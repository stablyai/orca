import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { isCodexSkillsListUnsupported, requestCodexSkillReport } from './codex-skill-list'

type CodexSkillReportDeps = {
  connection: Pick<CodexAppServerConnection, 'request'>
  cwd: string
  sessionId: string
  /** False once this child is no longer the session's, so a late answer is dropped. */
  isCurrent: () => boolean
  /** Re-sends the session's `/` surface to its subscribers. */
  publish: () => void
  timeoutMs?: number
  logger?: StructuredAgentSessionLogger
}

/**
 * A running Codex chat's `/` surface, as its own app-server lists it: read once the thread is
 * open and again whenever Codex says its skills changed. Until the first answer, and forever on a
 * Codex without `skills/list`, there is none, so the client keeps the folder scan.
 */
export class CodexSkillReport {
  private commands: AgentSessionSlashCommand[] | undefined
  private inFlight = false
  private rerun = false
  private unsupported = false

  constructor(private readonly deps: CodexSkillReportDeps) {}

  /** The same array until the list changes, since subscribers republish on identity. */
  read = (): AgentSessionSlashCommand[] | undefined => this.commands

  /** The skill files this child loaded, which alone may be sent as a picked skill. */
  hasSkillPath = (path: string): boolean | undefined =>
    this.commands?.some((command) => command.kind === 'skill' && command.path === path)

  refresh = (forceReload = false): void => {
    if (this.unsupported) {
      return
    }
    if (this.inFlight) {
      this.rerun = true
      return
    }
    this.inFlight = true
    void this.list(forceReload).finally(() => {
      this.inFlight = false
      if (this.rerun && this.deps.isCurrent()) {
        this.rerun = false
        this.refresh(true)
      }
    })
  }

  private async list(forceReload: boolean): Promise<void> {
    try {
      const commands = await requestCodexSkillReport(this.deps.connection, this.deps.cwd, {
        forceReload,
        ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {})
      })
      if (!this.deps.isCurrent()) {
        return
      }
      if (JSON.stringify(commands) !== JSON.stringify(this.commands)) {
        this.commands = commands
        this.deps.publish()
      }
    } catch (error) {
      if (isCodexSkillsListUnsupported(error)) {
        this.unsupported = true
        return
      }
      // A failed refresh keeps the last list Codex gave; it is still the best answer.
      try {
        this.deps.logger?.warn('Codex skill list failed', {
          scope: 'codex-skill-report',
          sessionId: this.deps.sessionId,
          error
        })
      } catch {
        // Reporting must never reject an unawaited refresh.
      }
    }
  }
}
