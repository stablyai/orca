import { isNativeLocalLocation } from '../../../shared/execution-host/execution-host'
import { normalizeRuntimePathForComparison } from '../../../shared/file-access/cross-platform-path'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** Resolve the chat's next launch, never the status bar's potentially unrelated selection. */
export async function codexChatSignInAccount(
  sessionId: string,
  getSettings: (() => GlobalSettings) | undefined,
  expectedHomePath?: string
): Promise<string | null> {
  const host = getStructuredAgentSessionHost()
  const record = host?.deps.store.getRecord(sessionId)
  if (
    !host ||
    !record ||
    !getSettings ||
    record.provider !== 'codex' ||
    !isNativeLocalLocation(record.location)
  ) {
    return null
  }
  const location = JSON.stringify(record.location)
  const home = await host.deps.launchAccountHome?.(record, 'identity')
  const current = host.deps.store.getRecord(sessionId)
  if (
    !home ||
    'kind' in home ||
    (expectedHomePath !== undefined &&
      normalizeRuntimePathForComparison(home.path) !==
        normalizeRuntimePathForComparison(expectedHomePath)) ||
    !current ||
    current.provider !== record.provider ||
    JSON.stringify(current.location) !== location
  ) {
    return null
  }
  const account = getSettings().codexManagedAccounts.find(
    (candidate) =>
      candidate.managedHomeRuntime !== 'wsl' &&
      normalizeRuntimePathForComparison(candidate.managedHomePath) ===
        normalizeRuntimePathForComparison(home.path)
  )
  return account?.id ?? null
}
