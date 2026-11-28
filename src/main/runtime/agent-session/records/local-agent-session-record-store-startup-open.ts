import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { withPRWatchRecovery } from '../lifecycle/pr-watch-runtime'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import {
  hasPersistedStructuredAgentSessionStore,
  openAgentSessionRecordStoreOnce,
  type AgentSessionRecordStoreLocation
} from './agent-session-record-store-slot'

/** One startup's saved-chat probe and open attempt; startup restoration consumes it once. */
export type AgentSessionRecordStoreStartupOpen = {
  legacySessionTabIds: readonly string[]
  persisted: boolean
  opened: Promise<unknown> | null
}

export function localAgentSessionRecordStoreLocation(
  legacySessionTabIds: readonly string[]
): AgentSessionRecordStoreLocation {
  return withPRWatchRecovery({
    stateDirectory: getProfileUserDataPath(),
    legacySessionTabIds,
    hostId: LOCAL_EXECUTION_HOST_ID,
    logger: neverThrowingStructuredAgentSessionLogger(createStructuredAgentSessionLogger())
  })
}

/** Opens saved chats early; old-history cleanup on empty profiles depends on the serving open. */
export function startLocalAgentSessionRecordStoreOpen(
  legacySessionTabIds: readonly string[],
  maintenanceAfter: Promise<void>
): AgentSessionRecordStoreStartupOpen {
  const location = localAgentSessionRecordStoreLocation(legacySessionTabIds)
  if (!hasPersistedStructuredAgentSessionStore(location.stateDirectory)) {
    return { legacySessionTabIds, persisted: false, opened: null }
  }
  const opened = openAgentSessionRecordStoreOnce({ ...location, maintenanceAfter })
  // Restoration reads the outcome; the open already logs and records its own refusal.
  opened.catch(() => {})
  return { legacySessionTabIds, persisted: true, opened }
}
