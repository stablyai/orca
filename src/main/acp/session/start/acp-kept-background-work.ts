import { createLegacyProviderTimelineIdentityScheme } from '../../../native-chat/agent-session-timeline/provider-timeline-identity'
import {
  providerKey,
  ProviderTimelineRows
} from '../../../native-chat/agent-session-timeline/provider-timeline-rows'
import { backgroundTaskBlocks } from '../../../../shared/native-chat/input/task-lists/native-chat-background-task-row'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AcpStructuredChild } from '../children/acp-structured-child'

/** Saved rows read at once; every carried task is read, in batches of this many. */
const READ_BATCH = 16

/**
 * Background tasks (and subagents) still running when the earlier app quit: their turns ended, so their starts
 * were acked and won't replay. Before output is let through, each is restated from its saved row,
 * and published as running (not unavailable), and a call Orca made it of reports to it again: the
 * call's final update settles the task instead of replacing the closed call row. No row is written.
 */
export async function carryKeptAcpBackgroundWork(
  child: AcpStructuredChild,
  agent: AgentType
): Promise<void> {
  const { kept } = child.connection
  // One that ended while Orca was closed is restated too: its replayed end then settles the row.
  const carried = (group: string) =>
    kept ? [...kept.openWork(group), ...kept.openWork(group, true)] : []
  const taskIds = carried('task')
  const translator = child.lane?.translator
  const subagentIds = carried('subagent')
  if (translator && subagentIds.length > 0) {
    // The host keeps each subagent's record; this run's evidence keeps it (and the agent) live.
    const join = { thread: translator.providerSessionId }
    const working = subagentIds.map((id) => ({ id, state: 'working' as const }))
    child.lane?.apply(translator.subagents.translate(working, join, Date.now()))
    translator.children.carryRunning(kept?.openWork('subagent') ?? [])
  }
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
  for (let at = 0; at < taskIds.length; at += READ_BATCH) {
    const batch = taskIds.slice(at, at + READ_BATCH)
    for (const row of await Promise.all(batch.map((id) => read(`background-task:${id}`)))) {
      const blocks = row?.body.kind === 'message' ? backgroundTaskBlocks(row.body.blocks) : []
      for (const live of blocks.map((block) =>
        translator.backgroundTasks.restate(block, namespace)
      )) {
        if (live) {
          child.lane?.publishChildWork(live)
        }
      }
    }
  }
}
