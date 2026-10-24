import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { isCodexSkillsListUnsupported, requestCodexSkillReport } from './codex-skill-list'

type CodexSkillReportDeps = {
  connection: Pick<CodexAppServerConnection, 'request'>
  cwd: string
  sessionId: string
  /** Drop late answers from superseded children. */
  isCurrent: () => boolean
  publish: () => void
  timeoutMs?: number
  logger?: StructuredAgentSessionLogger
}

/** Undefined until skills/list succeeds; clients retain their folder scan meanwhile. */
export class CodexSkillReport {
  private commands: AgentSessionSlashCommand[] | undefined
  private inFlight = false
  private rerun = false
  private unsupported = false

  constructor(private readonly deps: CodexSkillReportDeps) {}

  /** Preserve array identity until the list changes so subscribers avoid republishing. */
  read = (): AgentSessionSlashCommand[] | undefined => this.commands

  /** Only files loaded by this child may be sent as picked skills. */
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
      // Keep the last successful list on refresh failure.
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
