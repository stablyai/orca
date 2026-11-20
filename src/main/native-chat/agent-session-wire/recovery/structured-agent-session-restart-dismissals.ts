// A person dismissing an offer abandons that cut work; whoever waits on the chat hears of it then,
// and only then, since with the setting off nothing acts on a cut before the person does.

import type {
  StructuredAgentSessionRestartCut,
  StructuredAgentSessionRestartResume
} from './structured-agent-session-restart-resume-contract'
import type { StructuredAgentSessionRestartAudience } from './structured-agent-session-restart-resume-set'
import type { RecoveryDismissal } from '../../../runtime/agent-session/records/agent-session-recovery-capsule-entries'
import { restartCutOfMarker } from './structured-agent-session-restart-witnesses'
import type { StructuredAgentSessionRestartFailureLedger } from './structured-agent-session-restart-failure-ledger'

export type StructuredAgentSessionDismissedCut = {
  sessionId: string
  cut: StructuredAgentSessionRestartCut
}

type BeforeClearAll = (audience?: StructuredAgentSessionRestartAudience) => Promise<void>

type Settle = StructuredAgentSessionRestartFailureLedger['settle']

export function createRestartOfferDismissals(): {
  listeners: Pick<StructuredAgentSessionRestartResume, 'onDismissed' | 'onContinueSettled'>
  /** Tells `onContinueSettled` once a Continue's chats are settled (continued, refused or unconfirmed). */
  settling: (settle: Settle) => Settle
  dismissing: (
    dismiss: (
      sessionIds: readonly string[] | undefined,
      beforeClearAll: BeforeClearAll,
      audience?: StructuredAgentSessionRestartAudience
    ) => Promise<RecoveryDismissal>,
    beforeClearAll: BeforeClearAll
  ) => StructuredAgentSessionRestartResume['dismiss']
} {
  const listeners = new Set<(dismissed: readonly StructuredAgentSessionDismissedCut[]) => void>()
  const settledListeners = new Set<(sessionIds: readonly string[]) => void>()
  return {
    listeners: {
      onDismissed: (listener) => {
        listeners.add(listener)
      },
      onContinueSettled: (listener) => {
        settledListeners.add(listener)
      }
    },
    settling: (settle) => async (operationId, outcomes, action) => {
      await settle(operationId, outcomes, action)
      const sessionIds = outcomes.map((outcome) => outcome.sessionId)
      for (const listener of sessionIds.length > 0 ? settledListeners : []) {
        try {
          listener(sessionIds)
        } catch (error) {
          console.warn('[agent-session] a restart settlement listener failed', error)
        }
      }
    },
    dismissing: (dismiss, beforeClearAll) => async (sessionIds, audience) => {
      const { count, abandoned } = await dismiss(sessionIds, beforeClearAll, audience)
      // Exactly what this dismissal removed under the capsule's lock: an offer another window
      // continued first is not abandoned.
      const dismissed = abandoned.map(({ marker, unconfirmed }) => ({
        sessionId: marker.sessionId,
        cut: {
          ...restartCutOfMarker(marker),
          ...(unconfirmed ? { continuationUnconfirmed: true as const } : {})
        }
      }))
      if (dismissed.length > 0) {
        for (const listener of listeners) {
          try {
            listener(dismissed)
          } catch (error) {
            console.warn('[agent-session] a restart dismissal listener failed', error)
          }
        }
      }
      return count
    }
  }
}
