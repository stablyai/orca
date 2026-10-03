// The structured-chat step of host startup, before any client lists a tab: the restart lease check,
// the rows listed chats lack derived from their rows, listed chats still in per-chat files opened,
// each listed chat's status seeded from its stored status, and every chat a gone process left with
// work settled. The tab list waits for all but the settle; chat commands wait for the settle too.

import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { collectSavedStructuredAgentSessionIds } from './saved-structured-agent-session-restoration'
import { ensureStructuredAgentSessionHostUnlessRefused } from './structured-agent-session-host-refusal'
import type {
  StartupStepOutcome,
  StructuredAgentSessionStartupGate
} from './structured-agent-session-startup-gate'

/** Named from the host so a rename fails to compile. */
export type StructuredAgentSessionStartupHost = Pick<
  StructuredAgentSessionHost,
  | 'reconcileRestartLeases'
  | 'catchUpMissingStatuses'
  | 'restoreListedFromPerChatFiles'
  | 'seedStoredStatuses'
  | 'settleOwedSessions'
> &
  StructuredAgentSessionListingHost

type StructuredAgentSessionListingHost = Partial<
  Pick<StructuredAgentSessionHost, 'getPersistedVisibleSessionTabIndex'>
>

/**
 * Answers the listed chats stored status could not answer, which the post-listing restore opens.
 * The lease check runs first: it marks crashed leases `recovering` and starts their recoveries,
 * which record the death evidence the settle's verdicts read. It reports its own failures and
 * never throws.
 */
export async function runStructuredAgentSessionStartupStep(
  host: StructuredAgentSessionStartupHost,
  savedSession: WorkspaceSessionState | null,
  /** The settle, which chat commands wait for; it never rejects. */
  onSettling: (settled: Promise<void>) => void
): Promise<string[]> {
  await host.reconcileRestartLeases()
  const listedIds = listedStructuredAgentSessionIds(host, savedSession)
  // Before the listing answers: the first launch after the upgrade derives the rows listed chats
  // lack, so the seed and the settle below read stored status for every one of them.
  await host.catchUpMissingStatuses(listedIds)
  // Listed chats an older build left in per-chat files have no stored status to list them from.
  await host.restoreListedFromPerChatFiles(listedIds)
  const background = host.seedStoredStatuses(listedIds)
  // Not awaited here: the tab list and paint never wait on it; chat commands do.
  onSettling(host.settleOwedSessions(listedIds))
  return background
}

/** The chats with a tab, for the startup step and the tab restore alike: the host's persisted tab
 *  index, or before it is recorded, the saved workspace session's. */
export function listedStructuredAgentSessionIds(
  host: StructuredAgentSessionListingHost | null,
  savedSession: WorkspaceSessionState | null
): string[] {
  const persistedVisibleIndex = host?.getPersistedVisibleSessionTabIndex?.() ?? {
    present: false,
    sessionIds: []
  }
  if (persistedVisibleIndex.present) {
    return persistedVisibleIndex.sessionIds
  }
  // Unrecorded, the profile's chats join the tabs chats opened while the import was owed left.
  // First: after a /clear the profile's chat would take their tab id, so seeds hit tabIdTaken.
  return [
    ...new Set([
      ...persistedVisibleIndex.sessionIds,
      ...collectSavedStructuredAgentSessionIds(savedSession)
    ])
  ]
}

/**
 * The whole startup step, timed on the gate: the host build, then the step above. Chat commands
 * held for startup go ahead however this ends: when the settle does, or as it returns or throws.
 * Answers the listed chats the background restore still opens, or null when there is no host.
 */
export async function runStructuredAgentSessionStartup(input: {
  gate: StructuredAgentSessionStartupGate
  hasChatsOnDisk: () => boolean
  buildHost: () => Promise<void>
  savedSession: () => WorkspaceSessionState | null
}): Promise<string[] | null> {
  const { gate } = input
  gate.stepStarted()
  let ended: StartupStepOutcome | null = 'no chats on disk'
  try {
    if (!input.hasChatsOnDisk()) {
      return null
    }
    ended = 'no host'
    // A refused host is no host: startup goes on, and only structured requests are refused.
    await ensureStructuredAgentSessionHostUnlessRefused(input.buildHost)
    const host = getStructuredAgentSessionHost()
    if (!host) {
      return null
    }
    return await runStructuredAgentSessionStartupStep(host, input.savedSession(), (settled) => {
      ended = null
      gate.openWhen(settled)
    })
  } catch (error) {
    ended &&= 'step failed'
    throw error
  } finally {
    if (ended) {
      gate.stepEnded(ended)
    }
  }
}
