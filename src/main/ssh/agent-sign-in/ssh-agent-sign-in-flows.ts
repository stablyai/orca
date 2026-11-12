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
import { stripAnsiEscapeSequences } from '../../../shared/ansi-escape-sequences'
import {
  DEVICE_AUTH_TIMEOUT_MS,
  parseCodexDeviceAuthPrompt
} from '../../codex-accounts/login/codex-device-auth-prompt'

const CLAUDE_LOGIN_TIMEOUT_MS = 600_000
// Output is read line by line: a line is capped, the window holds the last few lines (Codex prints
// its link, marker and code on separate lines), and a host that prints this much without a sign-in
// link fails the flow, so a hostile stream can't keep the main process scanning.
const MAX_LINE_CHARS = 4_096
const WINDOW_LINES = 12
const MAX_OUTPUT_WITHOUT_LINK = 256 * 1024
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

// Claude Code's own OAuth app and paste-code callback, read from the CLI (2.1.318–2.1.322:
// CLIENT_ID and MANUAL_REDIRECT_URL in its production OAuth config). A link with anything else is
// not the CLI's sign-in link and is never shown.
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const CLAUDE_CODE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'
const CLAUDE_AUTHORIZE_HOSTS = new Set(['claude.ai', 'claude.com'])
// Bounded tokens keep each scan linear in the line length.
const LINK_TOKEN = /https:\/\/\S{1,2048}/g

/** The paste-code sign-in link Claude Code printed on this line, pinned to its real app; else null. */
export function pinnedClaudeSignInLink(line: string): string | null {
  let found: string | null = null
  for (const match of stripAnsiEscapeSequences(line).matchAll(LINK_TOKEN)) {
    try {
      const url = new URL(match[0])
      if (
        CLAUDE_AUTHORIZE_HOSTS.has(url.hostname) &&
        url.pathname.endsWith('/oauth/authorize') &&
        url.searchParams.get('code') === 'true' &&
        url.searchParams.get('client_id') === CLAUDE_CODE_CLIENT_ID &&
        url.searchParams.get('redirect_uri') === CLAUDE_CODE_REDIRECT_URI
      ) {
        // The last one wins: anything a login shell printed earlier never takes its place.
        found = url.toString()
      }
    } catch {
      // Not a link.
    }
  }
  return found
}

/** Splits streamed output into complete, capped lines; a partial line waits for its newline. */
export function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let pending = ''
  return (chunk) => {
    const parts = `${pending}${chunk}`.split(/\r?\n/)
    pending = (parts.pop() ?? '').slice(-MAX_LINE_CHARS)
    for (const part of parts) {
      onLine(part.slice(0, MAX_LINE_CHARS))
    }
  }
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
    const recent: string[] = []
    let seen = 0
    const onLine = (line: string): void => {
      if (active.closed || active.flow.phase !== 'starting') {
        return
      }
      if (agent === 'claude') {
        const url = pinnedClaudeSignInLink(line)
        if (url) {
          this.update(active, { phase: 'needsCode', url })
        }
        return
      }
      recent.push(line)
      if (recent.length > WINDOW_LINES) {
        recent.shift()
      }
      // Codex's parser wants the code line to end in whitespace; each line here ends in a newline.
      const prompt = parseCodexDeviceAuthPrompt(`${recent.join('\n')}\n`)
      if (prompt) {
        this.update(active, { phase: 'device', url: prompt.url, userCode: prompt.userCode })
      }
    }
    const read = lineReader(onLine)
    const onOutput = (chunk: string): void => {
      if (active.closed || active.flow.phase !== 'starting') {
        return
      }
      seen += chunk.length
      if (seen > MAX_OUTPUT_WITHOUT_LINK) {
        this.fail(active, 'failed')
        return
      }
      read(chunk)
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
      // No exit status means the connection dropped, not that the CLI refused the code.
      this.fail(
        active,
        code === null
          ? 'disconnected'
          : code === COMMAND_NOT_FOUND
            ? 'notInstalled'
            : active.codeSent
              ? 'rejected'
              : 'failed'
      )
    })
  }
}
