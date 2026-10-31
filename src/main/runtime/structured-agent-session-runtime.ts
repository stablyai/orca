// Install lazily after Electron finalizes the profile path; runtimes without structured requests need no store. Journal-open failures install a refusal.

import type { AgentSessionResumeTrigger } from '../../shared/agent-session-resume-marker'
import {
  structuredAgentSessionTeardownTrigger,
  tearDownRuntime,
  type InstalledRuntime
} from './agent-session/structured-agent-session-runtime-teardown'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { stopAgentSessionAttachments } from './structured-agent-session-attachment-wiring'
import {
  closeAgentSessionRecordStoreDatabase,
  openAgentSessionRecordStoreOnce,
  releaseAgentSessionRecordStore
} from './agent-session-record-store-slot'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { migrateLegacyNativeChatVisualsFolders } from '../native-chat/native-chat-scratch-folder-migration'

export { hasPersistedStructuredAgentSessionStore } from './agent-session-record-store-slot'

export type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime-contract'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime-contract'

let installing: Promise<InstalledRuntime> | null = null

export const CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED =
  'structured agent-session host requires a Claude auth policy resolver'

export const STRUCTURED_AGENT_LAUNCH_ARGS_REQUIRED =
  'structured agent-session host requires a launch arguments resolver'

export const STRUCTURED_AGENT_SESSION_LOGGER_REQUIRED =
  'structured agent-session host requires a logger'

/** Keep failed teardowns after clearing the install slot so later stops retry their indexed conversations and journal connection. */
const pendingTeardown = new Set<InstalledRuntime>()

export function ensureStructuredAgentSessionHost(
  deps: StructuredAgentSessionRuntimeDeps
): Promise<StructuredAgentSessionHost> {
  // A failed open must not poison the slot forever — the next call retries.
  installing ??= install(deps).catch((error) => {
    installing = null
    throw error
  })
  return installing.then((installed) => installed.host)
}

/** Wait until observed exits publish and host reconciliation settles; callbacks alone cannot tell callers when lease updates land. */
export async function waitForStructuredAgentSessionRecovery(): Promise<void> {
  const installed = await installing?.catch(() => null)
  await installed?.waitForRecovery()
}

/** Stop every provider child; retain failed teardowns for retry after the install slot clears. */
export async function stopStructuredAgentSessionRuntime(options?: {
  trigger?: AgentSessionResumeTrigger
}): Promise<void> {
  const trigger = options?.trigger ?? structuredAgentSessionTeardownTrigger()
  const pending = installing
  installing = null
  setStructuredAgentSessionHost(null)
  stopAgentSessionAttachments()
  const outstanding = [...pendingTeardown]
  pendingTeardown.clear()
  const installed = pending ? await pending.catch(() => null) : null
  if (installed) {
    outstanding.push(installed)
  }
  // A store admission opened with no host built on it has no teardown to close its database.
  const recordStore = await releaseAgentSessionRecordStore()
  const failures: unknown[] = []
  const standalone =
    recordStore &&
    !outstanding.some((runtime) => runtime.journalDatabase === recordStore.journalDatabase)

  try {
    await closeAgentSessionRecordStoreDatabase(standalone ? recordStore.journalDatabase : undefined)
  } catch (error) {
    failures.push(error)
  }
  for (const runtime of outstanding) {
    try {
      await tearDownRuntime(runtime, trigger)
    } catch (error) {
      pendingTeardown.add(runtime)
      failures.push(error)
    }
  }
  await agentModelCatalogStore.flushPersistence()
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'structured agent-session runtime teardown failed')
  }
}

async function install(deps: StructuredAgentSessionRuntimeDeps): Promise<InstalledRuntime> {
  // A default policy could attribute sign-in failures to the wrong account.
  if (typeof deps.resolveClaudeAuthPolicy !== 'function') {
    throw new Error(CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED)
  }
  if (typeof deps.resolveLaunchArgs !== 'function') {
    throw new Error(STRUCTURED_AGENT_LAUNCH_ARGS_REQUIRED)
  }
  const declared: Partial<StructuredAgentSessionLogger> | undefined = deps.logger
  if (typeof declared?.warn !== 'function' || typeof declared.error !== 'function') {
    throw new Error(STRUCTURED_AGENT_SESSION_LOGGER_REQUIRED)
  }
  const logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
  // The store launch admission may already have opened; a failed install leaves it to that slot.
  const recordStore = await openAgentSessionRecordStoreOnce({
    stateDirectory: deps.stateDirectory,
    legacySessionTabIds: deps.legacySessionTabIds ?? [],
    hostId: deps.hostId,
    logger
  })
  try {
    // Without the Arguments source there is nothing to fill from; missing modes run Ask.
    if (deps.resolveAgentFullAccess) {
      await recordStore.store.backfillChatPermissionModes(deps.resolveAgentFullAccess)
    }
  } catch (error) {
    // Missing choices safely run Ask; the next host install retries this pass.
    logger.warn('saving existing chat permission choices failed', {
      scope: 'permission-mode-backfill',
      error
    })
  }
  // Before the host serves reads: a chat opened right after an update finds its visuals in place.
  await migrateLegacyNativeChatVisualsFolders(deps.stateDirectory, logger)
  const { installOnJournal } = await import('./structured-agent-session-host-assembly')
  return await installOnJournal({ ...deps, logger }, recordStore)
}
