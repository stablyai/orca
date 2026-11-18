// The bot automations a message its bot answers also matches: run in that turn, not on their own.
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import type { Bot } from '../../shared/bot-types'
import type { ConnectorTurnAutomation } from '../../shared/connector-trigger-event-contract'
import type { EventInTurn } from '../automations/automation-trigger-runs'
import { triggerRunEvent } from './connector-triggers'

export type TurnAutomations = {
  /** What the agent reads after the message: each automation's name and instructions. */
  note: string
  /** Once the turn took the message: a run in each automation's history, handled in this chat. */
  record: (chat: EventInTurn['inTurn']) => Promise<void>
}

/**
 * Null when none is still this machine's to run, so the turn goes on as a plain message. `takes` is
 * what a run of its own would check first: the automation is on, made before the event, still has the
 * rule, and hasn't run the event.
 */
export function turnAutomations(
  automations: readonly Pick<Automation, 'id' | 'name' | 'prompt' | 'bot' | 'on'>[],
  bots: readonly Pick<Bot, 'id'>[],
  entries: readonly ConnectorTurnAutomation[],
  deps: {
    takes: (automationId: string, event: AutomationRunEvent) => boolean
    run: (automationId: string, event: AutomationRunEvent, inTurn: EventInTurn) => Promise<unknown>
  }
): TurnAutomations | null {
  const taken = entries.flatMap((entry) => {
    const automation = automations.find((candidate) => candidate.id === entry.automationId)
    const event = triggerRunEvent(automations, bots, entry)
    return automation && event && deps.takes(automation.id, event) ? [{ automation, event }] : []
  })
  if (taken.length === 0) {
    return null
  }
  const named = [...new Map(taken.map(({ automation }) => [automation.id, automation])).values()]
  return {
    note: turnAutomationsNote(named),
    record: async (chat) => {
      for (const { automation, event } of taken) {
        await deps.run(automation.id, event, { inTurn: chat })
      }
    }
  }
}

function turnAutomationsNote(automations: readonly Pick<Automation, 'name' | 'prompt'>[]): string {
  const each = automations.map(
    ({ name, prompt }) => `This message also matches your automation "${name}":\n${prompt.trim()}`
  )
  return [
    ...each,
    'Do what each one asks as part of this turn, and answer once, covering the message and them.'
  ].join('\n\n')
}
