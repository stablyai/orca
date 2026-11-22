import type { AgentSessionProviderUpdate } from '../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionOptionsReportedEvent } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ClaudeSession } from '../structured/claude-structured-session-state'
import { claudeVersionReaches, parseClaudeCliVersion } from './claude-hook-event-versions'
import {
  installedManagedAgentCommand,
  isManagedAgentCopyPath
} from '../../managed-agent-cli/managed-agent-cli-registry'

// Turn ends can follow each other closely; one look a minute is enough to notice an update.
const CLAUDE_INSTALLED_UPDATE_MIN_GAP_MS = 60_000

type WatchedSession = Pick<
  ClaudeSession,
  | 'fence'
  | 'acquisitionGeneration'
  | 'cliVersion'
  | 'runningVersion'
  | 'installedUpdate'
  | 'installedUpdateCheck'
>

/** The command a launch of `launched` runs next: Orca's own copy installs each release in a new
 *  folder, while other installs change the launched file's real path or modification time. */
export function claudeNextLaunchCommand(launched: string): () => string {
  const managed = isManagedAgentCopyPath('claude', launched)
  return () => (managed && installedManagedAgentCommand('claude')) || launched
}

/** Only a strictly newer, readable installed version is an update. */
function claudeInstalledUpdate(
  runningVersion: string | null | undefined,
  installedVersion: string | null | undefined
): AgentSessionProviderUpdate | null {
  const running = parseClaudeCliVersion(runningVersion)
  const installed = parseClaudeCliVersion(installedVersion)
  return running && installed && !claudeVersionReaches(running, installed)
    ? { runningVersion: running, installedVersion: installed }
    : null
}

/** Checks at this turn end; the idle sweep's tick checks again while the process idles. */
export function watchClaudeInstalledUpdate(
  sessionId: string,
  session: WatchedSession,
  current: () => boolean,
  emit: (event: StructuredAgentSessionOptionsReportedEvent) => void
): void {
  if (!session.installedUpdateCheck) {
    let checkedAt = -Infinity
    session.installedUpdateCheck = () => {
      const now = performance.now()
      if (now - checkedAt >= CLAUDE_INSTALLED_UPDATE_MIN_GAP_MS) {
        checkedAt = now
        void checkClaudeInstalledUpdate(sessionId, session, current, emit)
      }
    }
  }
  session.installedUpdateCheck()
}

/** Reports when a newer CLI appears at the next launch's command, or stops being newer. */
async function checkClaudeInstalledUpdate(
  sessionId: string,
  session: WatchedSession,
  current: () => boolean,
  emit: (event: StructuredAgentSessionOptionsReportedEvent) => void
): Promise<void> {
  if (!session.cliVersion || !session.runningVersion || !current()) {
    return
  }
  const installed = await session.cliVersion().catch(() => null)
  const update = claudeInstalledUpdate(session.runningVersion, installed)
  if (!current() || session.installedUpdate?.installedVersion === update?.installedVersion) {
    return
  }
  session.installedUpdate = update
  emit({
    type: 'options-reported',
    sessionId,
    fence: session.fence,
    acquisitionGeneration: session.acquisitionGeneration,
    reportedOptions: {},
    providerUpdate: update
  })
}
