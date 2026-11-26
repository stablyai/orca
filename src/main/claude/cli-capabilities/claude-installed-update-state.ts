import type { AgentSessionProviderUpdate } from '../../../shared/agent-session/agent-session-wire'

/** A Claude process's view of its own version against the one now installed. */
export type ClaudeInstalledUpdateState = {
  /** The `claude_code_version` this process's root init frames report. */
  runningVersion?: string
  /** Reads the launch command's version now; absent where the launch had no flag support to ask. */
  cliVersion?: () => Promise<string | null>
  /** The newer installed CLI last reported for this process; null once reported as current. */
  installedUpdate?: AgentSessionProviderUpdate | null
  /** Rechecks the installed CLI at most once a minute; set at this process's first turn end. */
  installedUpdateCheck?: () => void
}
