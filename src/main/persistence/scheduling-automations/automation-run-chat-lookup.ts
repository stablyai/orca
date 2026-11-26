// Which existing automation a run that landed in a chat belongs to, without listing every run or
// automation: each history is indexed once, since every change replaces its array.
import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'

type RunChat = Pick<AutomationRun, 'chatSessionId' | 'automationId'>
const automationsByRunChat = new WeakMap<readonly RunChat[], Map<string, string>>()
const automationIds = new WeakMap<readonly Pick<Automation, 'id'>[], Set<string>>()

/** The automation a retained run that landed in this chat belongs to, while it still exists; null
 *  when no retained run landed there or its automation is gone. */
export function findLiveAutomationOfRunChat(
  state: { automationRuns?: readonly RunChat[]; automations?: readonly Pick<Automation, 'id'>[] },
  chatSessionId: string
): string | null {
  const runs = state.automationRuns ?? []
  let byChat = automationsByRunChat.get(runs)
  if (!byChat) {
    byChat = new Map()
    for (const { chatSessionId: chat, automationId } of runs) {
      if (chat && !byChat.has(chat)) {
        byChat.set(chat, automationId)
      }
    }
    automationsByRunChat.set(runs, byChat)
  }
  const automationId = byChat.get(chatSessionId)
  if (automationId === undefined) {
    return null
  }
  const automations = state.automations ?? []
  let live = automationIds.get(automations)
  if (!live) {
    live = new Set(automations.map(({ id }) => id))
    automationIds.set(automations, live)
  }
  return live.has(automationId) ? automationId : null
}
