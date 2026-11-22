import type { AgentSessionProviderUpdate } from '../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionOptionsReportedEvent } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ClaudeSession } from '../structured/claude-structured-session-state'
import { claudeVersionReaches, parseClaudeCliVersion } from './claude-hook-event-versions'
import { installedManagedAgentCommand } from '../../managed-agent-cli/managed-agent-cli-registry'

// Catches an update installed while the chat waits for its next message.
const CLAUDE_INSTALLED_UPDATE_RECHECK_MS = 5 * 60_000

type WatchedSession = Pick<
  ClaudeSession,
  | 'fence'
  | 'acquisitionGeneration'
  | 'cliVersion'
  | 'runningVersion'
  | 'installedUpdate'
  | 'installedUpdateWatch'
>

/** The command a launch of `launched` runs next: Orca's own copy installs each release in a new
 *  folder, while other installs change the launched file's real path or modification time. */
export function claudeNextLaunchCommand(launched: string): () => string {
  const managed = launched === installedManagedAgentCommand('claude')
  return () => (managed && installedManagedAgentCommand('claude')) || launched
}

/** Only a strictly newer, readable installed version is an update. */
export function claudeInstalledUpdate(
  runningVersion: string | null | undefined,
  installedVersion: string | null | undefined
): AgentSessionProviderUpdate | null {
  const running = parseClaudeCliVersion(runningVersion)
  const installed = parseClaudeCliVersion(installedVersion)
  return running && installed && !claudeVersionReaches(running, installed)
    ? { runningVersion: running, installedVersion: installed }
    : null
}

/** Checks now, then every few minutes until this process is no longer the chat's. */
export function watchClaudeInstalledUpdate(
  sessionId: string,
  session: WatchedSession,
  current: () => boolean,
  emit: (event: StructuredAgentSessionOptionsReportedEvent) => void
): void {
  const check = (): void => void checkClaudeInstalledUpdate(sessionId, session, current, emit)
  check()
  if (session.installedUpdateWatch === undefined) {
    const watch = setInterval(
      () => (current() ? check() : clearInterval(watch)),
      CLAUDE_INSTALLED_UPDATE_RECHECK_MS
    )
    watch.unref?.()
    session.installedUpdateWatch = watch
  }
}

/** Reports when a newer CLI appears at this process's launch command, or stops being newer. */
async function checkClaudeInstalledUpdate(
  sessionId: string,
  session: WatchedSession,
  current: () => boolean,
  emit: (event: StructuredAgentSessionOptionsReportedEvent) => void
): Promise<void> {
  if (!session.cliVersion || !session.runningVersion) {
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
