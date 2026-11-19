// A person dismissing an offer abandons that cut work; whoever waits on the chat hears of it then,
// and only then, since with the setting off nothing acts on a cut before the person does.

import type {
  StructuredAgentSessionRestartCut,
  StructuredAgentSessionRestartResume
} from './structured-agent-session-restart-resume-contract'
import type { StructuredAgentSessionRestartAudience } from './structured-agent-session-restart-resume-set'

export type StructuredAgentSessionDismissedCut = {
  sessionId: string
  cut: StructuredAgentSessionRestartCut
}

type Dismiss = StructuredAgentSessionRestartResume['dismiss']
type BeforeClearAll = (audience?: StructuredAgentSessionRestartAudience) => Promise<void>

export function createRestartOfferDismissals(
  deps: Pick<StructuredAgentSessionRestartResume, 'list' | 'listFailures' | 'cutOf'>
): {
  onDismissed: StructuredAgentSessionRestartResume['onDismissed']
  dismissing: (
    dismiss: (
      sessionIds: readonly string[] | undefined,
      beforeClearAll: BeforeClearAll,
      audience?: StructuredAgentSessionRestartAudience
    ) => Promise<number>,
    beforeClearAll: BeforeClearAll
  ) => Dismiss
} {
  const listeners = new Set<(dismissed: readonly StructuredAgentSessionDismissedCut[]) => void>()
  const shown = async (audience?: StructuredAgentSessionRestartAudience) =>
    new Set(
      [...(await deps.list(audience)), ...(await deps.listFailures(audience))].map(
        (row) => row.sessionId
      )
    )
  return {
    onDismissed: (listener) => {
      listeners.add(listener)
    },
    dismissing: (dismiss, beforeClearAll) => async (sessionIds, audience) => {
      if (listeners.size === 0) {
        return dismiss(sessionIds, beforeClearAll, audience)
      }
      const named = [...(await shown(audience))].filter(
        (sessionId) => sessionIds === undefined || sessionIds.includes(sessionId)
      )
      const cuts = new Map<string, StructuredAgentSessionRestartCut>()
      for (const sessionId of named) {
        const cut = await deps.cutOf(sessionId)
        if (cut) {
          cuts.set(sessionId, cut)
        }
      }
      const count = await dismiss(sessionIds, beforeClearAll, audience)
      const left = await shown(audience)
      const dismissed = [...cuts].flatMap(([sessionId, cut]) =>
        left.has(sessionId) ? [] : [{ sessionId, cut }]
      )
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
