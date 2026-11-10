// Classic SSH code sign-in (spec §4 annotation 5, Q8): Claude's paste-code login and Codex's device
// code, each run over the host's existing SSH remote exec. No callback, no port forward. The pasted
// code goes to the CLI's stdin, never argv; codes, tokens and CLI output are never logged or sent to
// the renderer (only the sign-in page link and Codex's one-time device code, which the person needs).
import { randomUUID } from 'node:crypto'
import type { HostAgentSignInAgent } from '../../../shared/host-agent-sign-in-status'
import type {
  SshAgentSignInFlow,
  SshAgentSignInFlowError
} from '../../../shared/ssh-agent-sign-in-types'
import { parseClaudePastedCodeSignInLink } from '../../claude-accounts/claude-pasted-code-login'
import {
  DEVICE_AUTH_TIMEOUT_MS,
  parseCodexDeviceAuthPrompt
} from '../../codex-accounts/codex-device-auth-prompt'

const CLAUDE_LOGIN_TIMEOUT_MS = 600_000
const MAX_SCAN_CHARS = 8_000
const COMMAND_NOT_FOUND = 127
// The paste code is short; anything longer or multi-line is not a code and is refused unsent.
const MAX_CODE_CHARS = 512

// BROWSER=true: there is no browser on the host; the CLI prints the link instead of trying to open one.
export const SSH_AGENT_LOGIN_COMMAND: Record<HostAgentSignInAgent, string> = {
  claude: 'BROWSER=true claude auth login --claudeai',
  codex: 'codex login --device-auth'
}

/** A running remote login, as the flow drives it (adapted from an SSH exec channel in the IPC). */
export type SshLoginChannel = {
  /** stdout and stderr, as text. */
  onOutput(listener: (chunk: string) => void): void
  onClose(listener: (exitCode: number | null) => void): void
  onError(listener: () => void): void
  /** Writes to the CLI's stdin. */
  write(text: string): void
  close(): void
}

export type SshLoginTransport = {
  exec(command: string, options?: { wrapCommand?: boolean }): Promise<SshLoginChannel>
}

type Active = {
  flow: SshAgentSignInFlow
  channel: SshLoginChannel | null
  timer: ReturnType<typeof setTimeout> | null
  codeSent: boolean
  closed: boolean
}

export class SshAgentSignInFlows {
  private readonly flows = new Map<string, Active>()

  constructor(
    private readonly connection: (targetId: string) => SshLoginTransport | null,
    private readonly publish: (flow: SshAgentSignInFlow) => void,
    /** A finished sign-in changes the verdict: drop the cached status for that host. */
    private readonly onSignedIn: (targetId: string) => void
  ) {}

  list(targetId: string): SshAgentSignInFlow[] {
    return [...this.flows.values()]
      .map((active) => active.flow)
      .filter((flow) => flow.targetId === targetId)
  }

  start(targetId: string, agent: HostAgentSignInAgent): SshAgentSignInFlow {
    const running = [...this.flows.values()].find(
      (active) => active.flow.targetId === targetId && active.flow.agent === agent && !active.closed
    )
    if (running) {
      return running.flow
    }
    const flow: SshAgentSignInFlow = { flowId: randomUUID(), targetId, agent, phase: 'starting' }
    const active: Active = { flow, channel: null, timer: null, codeSent: false, closed: false }
    this.flows.set(flow.flowId, active)
    this.publish(flow)
    void this.run(active)
    return flow
  }

  submitCode(flowId: string, code: string): boolean {
    const active = this.flows.get(flowId)
    const trimmed = code.trim()
    if (
      !active ||
      active.closed ||
      active.flow.phase !== 'needsCode' ||
      !active.channel ||
      !trimmed ||
      trimmed.length > MAX_CODE_CHARS ||
      /\s/.test(trimmed)
    ) {
      return false
    }
    active.codeSent = true
    // stdin only: the code never appears in a command line or a log.
    active.channel.write(`${trimmed}\n`)
    this.update(active, { phase: 'submitting' })
    return true
  }

  cancel(flowId: string): void {
    const active = this.flows.get(flowId)
    if (!active || active.closed) {
      return
    }
    this.finish(active, { phase: 'cancelled' })
  }

  private update(active: Active, patch: Partial<SshAgentSignInFlow>): void {
    active.flow = { ...active.flow, ...patch }
    this.publish(active.flow)
  }

  private finish(active: Active, patch: Partial<SshAgentSignInFlow>): void {
    if (active.closed) {
      return
    }
    active.closed = true
    if (active.timer) {
      clearTimeout(active.timer)
    }
    try {
      active.channel?.close()
    } catch {
      // Already gone.
    }
    this.update(active, patch)
    // Settled flows stay readable briefly for late listeners, then go.
    setTimeout(() => this.flows.delete(active.flow.flowId), 60_000).unref?.()
  }

  private fail(active: Active, error: SshAgentSignInFlowError): void {
    this.finish(active, { phase: 'failed', error })
  }

  private async run(active: Active): Promise<void> {
    const { targetId, agent } = active.flow
    const conn = this.connection(targetId)
    if (!conn) {
      this.fail(active, 'disconnected')
      return
    }
    let channel: SshLoginChannel
    try {
      channel = await conn.exec(SSH_AGENT_LOGIN_COMMAND[agent], { wrapCommand: true })
    } catch {
      this.fail(active, 'disconnected')
      return
    }
    if (active.closed) {
      channel.close()
      return
    }
    active.channel = channel
    active.timer = setTimeout(
      () => this.fail(active, 'timeout'),
      agent === 'claude' ? CLAUDE_LOGIN_TIMEOUT_MS : DEVICE_AUTH_TIMEOUT_MS
    )
    let scanned = ''
    const onOutput = (chunk: string): void => {
      if (active.closed || active.flow.phase !== 'starting') {
        return
      }
      scanned = `${scanned}${chunk}`.slice(-MAX_SCAN_CHARS)
      if (agent === 'claude') {
        const url = parseClaudePastedCodeSignInLink(scanned)
        if (url) {
          this.update(active, { phase: 'needsCode', url })
        }
        return
      }
      const prompt = parseCodexDeviceAuthPrompt(scanned)
      if (prompt) {
        this.update(active, { phase: 'device', url: prompt.url, userCode: prompt.userCode })
      }
    }
    channel.onOutput(onOutput)
    channel.onError(() => this.fail(active, 'disconnected'))
    channel.onClose((code) => {
      if (active.closed) {
        return
      }
      if (code === 0) {
        this.onSignedIn(targetId)
        this.finish(active, { phase: 'signedIn' })
        return
      }
      this.fail(
        active,
        code === COMMAND_NOT_FOUND ? 'notInstalled' : active.codeSent ? 'rejected' : 'failed'
      )
    })
  }
}
