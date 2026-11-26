import { findLiveAutomationOfRunChat } from '../../scheduling-automations/automation-run-chat-lookup'
import type { StoreRuntimeState } from '../store-runtime-state'

const automationRunChatContext = Symbol('AutomationRunChatPersistence')

export class AutomationRunChatPersistence {
  readonly [automationRunChatContext]: Pick<StoreRuntimeState, 'state'>

  constructor(runtime: Pick<StoreRuntimeState, 'state'>) {
    this[automationRunChatContext] = runtime
  }

  /** The existing automation a retained run that landed in this chat belongs to, by an index. */
  findLiveAutomationOfRunChat(chatSessionId: string): string | null {
    return findLiveAutomationOfRunChat(this[automationRunChatContext].state, chatSessionId)
  }
}
