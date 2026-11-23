import { botGroupRoom } from '../../shared/bots/bot-group'
import { structuredAgentSessionPayloadFingerprint } from '../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { mintAgentSessionOperationId } from '../runtime/orchestration/mailbox/structured-pointer/structured-pointer-operation-id'
import { requireStructuredHost } from './bot-chat-session'
import type { BotGroupRuntime } from './bot-group-runtime'

/** The cutoff and the cancels are one room operation, so a send at the new revision cannot start
 *  a turn that a late cancel then stops. */
export function stopBotGroup(
  groups: BotGroupRuntime,
  groupId: string,
  botId?: string,
  threadId?: string
) {
  return runKeyedSerializedOperation(groups.queues, groupId, async () => {
    const group = groups.store.get(groupId)
    const previous = botGroupRoom(group, threadId)
    const sequence = groups.store.roomMessages(groupId, threadId, 1)[0]?.sequence ?? 0
    const stopping = (member: { botId: string }) => !botId || member.botId === botId
    const members = previous.members.map((member) =>
      stopping(member) ? { ...member, stoppedThroughSequence: sequence } : member
    )
    groups.store.put({
      ...group,
      revision: group.revision + 1,
      ...(threadId
        ? {
            threads: group.threads?.map((thread) =>
              thread.id === threadId ? { ...thread, members } : thread
            )
          }
        : { members })
    })
    groups.changed()
    const host = await requireStructuredHost(groups.runtime)
    return Promise.all(
      previous.members.filter(stopping).map(({ sessionId }) =>
        host.cancel(
          { callerKey: `bot-group-stop:${groupId}` },
          {
            envelope: {
              sessionId,
              clientOperationId: mintAgentSessionOperationId(Date.now()),
              expectedRuntimeFence:
                host.deps.store.requireWritableRecord(sessionId).lease.runtimeFence,
              payloadFingerprint: structuredAgentSessionPayloadFingerprint({
                method: 'agentSession.cancel',
                sessionId,
                fields: {}
              })
            }
          }
        )
      )
    )
  })
}
