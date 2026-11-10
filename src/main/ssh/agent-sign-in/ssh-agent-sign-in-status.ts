// Classic SSH sign-in status (spec §4 annotation 4): the CLIs' own status commands over the existing
// remote exec, only while the host is connected, with a 60 s cache per target. Only verdicts leave
// main; CLI output never does.
import {
  HOST_AGENT_SIGN_IN_AGENTS,
  type HostAgentSignInAgent,
  type HostAgentSignInEntry,
  type HostAgentSignInReport
} from '../../../shared/host-agent-sign-in-status'
import type { SshAgentSignInStatusResult } from '../../../shared/ssh-agent-sign-in-types'
import { classifyAgentStatusOutput } from '../../runtime/agent-session/environment/host-agent-sign-in-status'
import type { RemoteInstallTransport } from '../../managed-server/install/remote-install-transport'
import {
  execCommand,
  isSshCommandExitError,
  isSshExecTimeout
} from '../remote-exec/remote-exec-command'

const REPORT_TTL_MS = 60_000
const STATUS_TIMEOUT_MS = 10_000
// POSIX shells exit 127 when the command isn't on PATH.
const COMMAND_NOT_FOUND = 127

export const SSH_AGENT_STATUS_COMMAND: Record<HostAgentSignInAgent, string> = {
  claude: 'claude auth status --json',
  codex: 'codex login status'
}

export type SshStatusTransport = Pick<
  RemoteInstallTransport,
  'exec' | 'execWithClosedStdin' | 'usesSystemSshTransport'
>

async function checkAgent(
  conn: SshStatusTransport,
  agent: HostAgentSignInAgent
): Promise<HostAgentSignInEntry> {
  let stderr = ''
  try {
    const stdout = await execCommand(conn, SSH_AGENT_STATUS_COMMAND[agent], {
      timeoutMs: STATUS_TIMEOUT_MS,
      onStderr: (text) => {
        stderr += text
      }
    })
    return classifyAgentStatusOutput(agent, {
      exitCode: 0,
      output: `${stdout}\n${stderr}`,
      timedOut: false
    })
  } catch (error) {
    if (isSshExecTimeout(error)) {
      return { agent, state: 'unknown' }
    }
    if (isSshCommandExitError(error)) {
      if (error.exitCode === COMMAND_NOT_FOUND) {
        return { agent, state: 'notInstalled' }
      }
      // Signed out exits non-zero with the same report; the message carries Codex's stderr verdict.
      return classifyAgentStatusOutput(agent, {
        exitCode: error.exitCode,
        output: `${error.stdout}\n${error.message}`,
        timedOut: false
      })
    }
    return { agent, state: 'unknown' }
  }
}

type Cached = { report: HostAgentSignInReport; at: number; generation: number }

/** One cache per main process; concurrent asks for a target share one check. */
export class SshAgentSignInStatus {
  private readonly cache = new Map<string, Cached>()
  private readonly inFlight = new Map<string, Promise<HostAgentSignInReport>>()

  constructor(
    private readonly connection: (
      targetId: string
    ) => (SshStatusTransport & { getConnectGeneration(): number; connected(): boolean }) | null,
    private readonly now: () => number = Date.now
  ) {}

  async read(targetId: string, force = false): Promise<SshAgentSignInStatusResult> {
    const conn = this.connection(targetId)
    if (!conn || !conn.connected()) {
      return { ok: false, error: 'disconnected' }
    }
    const generation = conn.getConnectGeneration()
    const cached = this.cache.get(targetId)
    if (
      !force &&
      cached &&
      cached.generation === generation &&
      this.now() - cached.at < REPORT_TTL_MS
    ) {
      return { ok: true, report: cached.report }
    }
    let pending = this.inFlight.get(targetId)
    if (!pending || force) {
      pending = (async () => {
        const agents = await Promise.all(
          HOST_AGENT_SIGN_IN_AGENTS.map((agent) => checkAgent(conn, agent))
        )
        return { checkedAt: this.now(), agents }
      })()
      this.inFlight.set(targetId, pending)
    }
    try {
      const report = await pending
      this.cache.set(targetId, { report, at: this.now(), generation })
      return { ok: true, report }
    } catch {
      return { ok: false, error: 'unknown' }
    } finally {
      if (this.inFlight.get(targetId) === pending) {
        this.inFlight.delete(targetId)
      }
    }
  }

  forget(targetId: string): void {
    this.cache.delete(targetId)
  }
}
