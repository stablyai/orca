// Background-task rows outlive turn settlement; only their own updates or session end settle them.

import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { canReplaceBackgroundTaskState } from '../../../shared/native-chat-background-task-row'
import { isBackgroundTaskBlock } from '../../../shared/native-chat-types'

export function relightsProviderTimelineBackgroundTask(
  held: AgentJournalItemBody | null,
  next: AgentJournalItemBody
): boolean {
  if (held?.kind !== 'message' || next.kind !== 'message') {
    return false
  }
  const states = new Map<string, string>()
  for (const block of held.blocks) {
    if (isBackgroundTaskBlock(block)) {
      states.set(block.taskId, block.state)
    }
  }
  return next.blocks.some((block) => {
    const current = isBackgroundTaskBlock(block) ? states.get(block.taskId) : undefined
    return (
      isBackgroundTaskBlock(block) &&
      current !== undefined &&
      current !== block.state &&
      !canReplaceBackgroundTaskState(current, block.state)
    )
  })
}
