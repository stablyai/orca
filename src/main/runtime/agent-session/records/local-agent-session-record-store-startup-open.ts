import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
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
  return {
    stateDirectory: getProfileUserDataPath(),
    legacySessionTabIds,
    hostId: LOCAL_EXECUTION_HOST_ID,
    logger: neverThrowingStructuredAgentSessionLogger(createStructuredAgentSessionLogger())
  }
}

/** Boots the chat writer alongside other startup work; profiles without chats spawn nothing.
 *  `maintenanceAfter` is the host's own listening milestone, so background sweeps start after it. */
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
