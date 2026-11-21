import { boundPayload } from '../../../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import {
  AGENT_SESSION_MODEL_SWITCH_FRAME_KIND,
  AGENT_SESSION_MODEL_SWITCH_PRESENTATION
} from '../../../../shared/agent-session/journal/agent-session-model-switch'
import type { ZcodeStructuredLane } from '../timeline/zcode-structured-lane'
import type { ZcodeStructuredOptions } from '../options/zcode-structured-options'

// The model-switch notice: one status row per real routing change, parsed from the outgoing
// headers ask — never from picks, whose recorded intent can drift from what actually routes.

export function journalZcodeModelSwitchNotice(input: {
  lane: ZcodeStructuredLane
  providerSessionId: string
  options: ZcodeStructuredOptions
  from: string
  to: string
  at: number
}): void {
  const fromLabel = input.options.modelLabelOf(input.from) ?? input.from
  const toLabel = input.options.modelLabelOf(input.to) ?? input.to
  const turn = input.lane.translator.currentTurnKey ?? null
  input.lane.apply([
    {
      type: 'item.open',
      item: `${input.providerSessionId}:model-switch:${input.at}`,
      body: {
        kind: 'status',
        presentation: AGENT_SESSION_MODEL_SWITCH_PRESENTATION,
        text: `ZCode switched models: ${fromLabel} → ${toLabel}.`,
        providerFrame: {
          provider: 'zcode',
          kind: AGENT_SESSION_MODEL_SWITCH_FRAME_KIND,
          payload: boundPayload(
            JSON.stringify({
              type: 'model-switch',
              from: fromLabel,
              to: toLabel
            }),
            { inlineHeadBytes: 16 * 1024 }
          )
        }
      },
      join: {
        thread: input.providerSessionId,
        ...(turn !== null ? { turn } : {})
      }
    }
  ])
}
