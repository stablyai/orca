import { createLegacyProviderTimelineIdentityScheme } from '../../../native-chat/agent-session-timeline/provider-timeline-identity'
import {
  providerKey,
  ProviderTimelineRows
} from '../../../native-chat/agent-session-timeline/provider-timeline-rows'
import { backgroundTaskBlocks } from '../../../../shared/native-chat/input/task-lists/native-chat-background-task-row'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AcpStructuredChild } from '../children/acp-structured-child'

/** More background tasks than this outlasting their turns can't be real; the rest start anew. */
const MAX_CARRIED_TASKS = 32

/**
 * Background tasks still running when the earlier app quit: their turns ended, so their starts
 * were acked and won't replay. Before output is let through, each is restated from its saved row,
 * so it reads as running (not unavailable) and a call Orca made it of reports to it again: the
 * call's final update settles the task instead of replacing the closed call row. No row is written.
 */
export async function carryKeptAcpBackgroundWork(
  child: AcpStructuredChild,
  agent: AgentType
): Promise<void> {
  const taskIds = child.connection.kept?.openWork('task').slice(0, MAX_CARRIED_TASKS) ?? []
  const translator = child.lane?.translator
  const history = child.events?.journalHistory?.()
  if (taskIds.length === 0 || !translator || !history) {
    return
  }
  const namespace = translator.providerSessionId
  const rows = new ProviderTimelineRows({
    scheme: createLegacyProviderTimelineIdentityScheme({ agent, sessionId: child.sessionId }),
    generation: '',
    namespace
  })
  const read = (key: string) => {
    const { itemId } = rows.item('item', providerKey(key), namespace)
    return history.readInOrder((reads) => reads.itemDetail(itemId)).catch(() => null)
  }
  for (const row of await Promise.all(taskIds.map((id) => read(`background-task:${id}`)))) {
    for (const block of row?.body.kind === 'message' ? backgroundTaskBlocks(row.body.blocks) : []) {
      translator.backgroundTasks.restate(block)
    }
  }
}
