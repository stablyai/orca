import { vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { classifyStoreFailure } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'

export function createPublishingAttachStub(sessionId: string) {
  return vi.fn(
    async (
      _caller: Parameters<StructuredAgentSessionHost['attach']>[0],
      _params: Parameters<StructuredAgentSessionHost['attach']>[1],
      options?: Parameters<StructuredAgentSessionHost['attach']>[2]
    ) => {
      try {
        await options?.publishTab?.()
      } catch (error) {
        return { ok: false, refusal: classifyStoreFailure(error, 1) }
      }
      return {
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'epoch-a', sequence: 0 },
        value: {
          sessionId,
          fence: 1,
          page: {
            sessionId,
            epoch: 'epoch-a',
            direction: 'tail',
            items: [],
            removedItemIds: [],
            submissions: [],
            window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-a', sequence: 0 } },
            liveCursor: { epoch: 'epoch-a', sequence: 0 },
            hasOlder: false,
            hasNewer: false
          },
          unconfirmedClientMessageIds: []
        }
      }
    }
  )
}
