// Classic SSH sign-in status (spec §4 annotation 4): the CLIs' own status commands over the existing
// remote exec, only while the host is connected, with a 60 s cache per target. Only verdicts leave
// main; CLI output never does.
import {
  HOST_AGENT_SIGN_IN_AGENTS,
  type HostAgentSignInAgent,
  type HostAgentSignInEntry
} from '../../../shared/host-agent-sign-in-status'
import type {
  SshAgentSignInEntry,
  SshAgentSignInReport,
  SshAgentSignInStatusResult
} from '../../../shared/ssh-agent-sign-in-types'
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

// Presence only: each prints exactly "yes" or "no". Nothing is read into output; no Keychain -w/-g.
// Claude: its credentials file, or on a macOS host the Keychain item's existence.
// Codex: auth.json holding a ChatGPT login (a refresh_token key), matched with grep -q.
export const SSH_AGENT_LOGIN_PRESENCE_COMMAND: Record<HostAgentSignInAgent, string> = {
  claude:
    'if [ -s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" ]; then echo yes; ' +
    "elif command -v security >/dev/null 2>&1 && security find-generic-password -s 'Claude Code-credentials' >/dev/null 2>&1; then echo yes; " +
    'else echo no; fi',
  codex:
    'if grep -q \'"refresh_token"\' "${CODEX_HOME:-$HOME/.codex}/auth.json" 2>/dev/null; then echo yes; else echo no; fi'
}

/** Whether a CLI login sits under the API key; null when the host gave no clean yes/no. */
async function hasCliLogin(
  conn: SshStatusTransport,
  agent: HostAgentSignInAgent
): Promise<boolean | null> {
  try {
    const answer = (
      await execCommand(conn, SSH_AGENT_LOGIN_PRESENCE_COMMAND[agent], {
        timeoutMs: STATUS_TIMEOUT_MS
      })
    ).trim()
    return answer === 'yes' ? true : answer === 'no' ? false : null
  } catch {
    return null
  }
}

async function checkAgentWithLogin(
  conn: SshStatusTransport,
  agent: HostAgentSignInAgent
): Promise<SshAgentSignInEntry> {
  const entry = await checkAgent(conn, agent)
  if (entry.state !== 'signedIn' || entry.method !== 'apiKey') {
    return entry
  }
  const hasLogin = await hasCliLogin(conn, agent)
  return hasLogin === null ? entry : { ...entry, hasLogin }
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

type Cached = { report: SshAgentSignInReport; at: number }

/**
 * One cache per main process, keyed by target and connection generation, so a report from before a
 * reconnect is never reused. Concurrent asks share one check; a forced ask while one runs queues a
 * single follow-up behind it instead of opening more remote sessions.
 */
export class SshAgentSignInStatus {
  private readonly cache = new Map<string, Cached>()
  private readonly inFlight = new Map<string, Promise<SshAgentSignInReport>>()
  private readonly queuedForce = new Map<string, Promise<SshAgentSignInReport>>()

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
    const key = `${targetId}\u0000${conn.getConnectGeneration()}`
    const cached = this.cache.get(key)
    if (!force && cached && this.now() - cached.at < REPORT_TTL_MS) {
      return { ok: true, report: cached.report }
    }
    try {
      const report = await this.check(key, conn, force)
      this.cache.set(key, { report, at: this.now() })
      return { ok: true, report }
    } catch {
      return { ok: false, error: 'unknown' }
    }
  }

  private check(
    key: string,
    conn: SshStatusTransport,
    force: boolean
  ): Promise<SshAgentSignInReport> {
    const running = this.inFlight.get(key)
    if (running) {
      if (!force) {
        return running
      }
      // A check begun before a sign-in finished can't answer a forced recheck: one queued follow-up.
      let queued = this.queuedForce.get(key)
      if (!queued) {
        queued = running
          .catch(() => undefined)
          .then(() => {
            this.queuedForce.delete(key)
            return this.start(key, conn)
          })
        this.queuedForce.set(key, queued)
      }
      return queued
    }
    return this.start(key, conn)
  }

  private start(key: string, conn: SshStatusTransport): Promise<SshAgentSignInReport> {
    const pending = (async () => {
      const agents = await Promise.all(
        HOST_AGENT_SIGN_IN_AGENTS.map((agent) => checkAgentWithLogin(conn, agent))
      )
      return { checkedAt: this.now(), agents }
    })()
    this.inFlight.set(key, pending)
    void pending
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight.get(key) === pending) {
          this.inFlight.delete(key)
        }
      })
    return pending
  }

  forget(targetId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${targetId}\u0000`)) {
        this.cache.delete(key)
      }
    }
  }
}
