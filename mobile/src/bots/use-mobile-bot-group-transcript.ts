import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { AppState } from 'react-native'
import {
  reduceBotGroupTranscript,
  type BotGroupTranscript,
  type BotGroupTranscriptAction
} from '../../../src/shared/bots/bot-group-transcript'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { groupRead } from './bot-group-operations'
import { readHostBots } from './host-bots-read'
import type { PhoneBot } from './host-bots-operations'
import { startHostBotRefresh } from './host-bot-refresh'
import {
  botChangeBotIds,
  botChangeConcerns,
  type BotChangeKind,
  type BotChangeScope
} from '../../../src/shared/bots/bot-change-scope'
const ROOM_KINDS: readonly BotChangeKind[] = ['groups', 'bot']
const ITEM_KINDS: readonly BotChangeKind[] = ['groups', 'items', 'workers']

function sameCounts(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>
): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

type RoomTranscript = { threadId: string | undefined; data: BotGroupTranscript | null }

// A page lands on the room it was read for; another room's page replaces it. A send, older page or
// Replies change that answers after the owner left its room has nothing to land on.
function reduceRoomTranscript(
  current: RoomTranscript,
  { threadId, action }: { threadId: string | undefined; action: BotGroupTranscriptAction }
): RoomTranscript {
  if (current.threadId !== threadId && action.kind !== 'recent') {
    return current
  }
  return {
    threadId,
    data: reduceBotGroupTranscript(current.threadId === threadId ? current.data : null, action)
  }
}

/** One room's transcript, the original room's or a thread's; `group` is the last group read in
 *  any room, so the room's name and threads stay while another room loads. */
export function useMobileBotGroupTranscript(
  client: RpcClient,
  groupId: string,
  threadId: string | undefined,
  hostId: string,
  visible: boolean,
  setError: (message: string | null) => void
) {
  const [room, dispatch] = useReducer(reduceRoomTranscript, { threadId, data: null })
  const data = room.threadId === threadId ? room.data : null
  const apply = useCallback(
    (action: BotGroupTranscriptAction) => dispatch({ threadId, action }),
    [threadId]
  )
  const [bots, setBots] = useState<PhoneBot[]>([])
  const [needsYou, setNeedsYou] = useState<Readonly<Record<string, number>>>({})
  // Bumps on each change the members' items may show, for the group's Items list to read again.
  const [itemReads, setItemReads] = useState(0)
  const memberIds = useRef<readonly string[]>([])
  useEffect(() => {
    memberIds.current = room.data?.group.members.map((member) => member.botId) ?? []
  })
  useEffect(() => {
    if (!visible) {
      return
    }
    let closed = false
    let request = 0
    const refresh = (changed?: BotChangeScope) => {
      // Another bot's items or workers change nothing a member's list shows.
      const changedBots = botChangeBotIds(changed, ITEM_KINDS)
      if (
        botChangeConcerns(changed, { kinds: ITEM_KINDS }) &&
        (changedBots === null || changedBots.some((id) => memberIds.current.includes(id)))
      ) {
        setItemReads((reads) => reads + 1)
      }
      // An items notice carries the host's new Needs you counts, which the bot list read would bring.
      const counts = changed?.needsYou?.counts
      if (counts) {
        setNeedsYou((last) => (sameCounts(last, counts) ? last : counts))
      }
      if (!botChangeConcerns(changed, { kinds: ROOM_KINDS })) {
        return
      }
      const current = ++request
      void Promise.all([
        groupRead.request(client, { groupId, threadId }),
        readHostBots(client, hostId)
      ])
        .then(([reply, bots]) => {
          if (closed || current !== request) {
            return
          }
          apply({ kind: 'recent', page: groupRead.interpret(reply) })
          if (bots.kind === 'bots') {
            setBots(bots.bots)
            setNeedsYou((last) => (sameCounts(last, bots.needsYou) ? last : bots.needsYou))
          }
        })
        .catch((error: unknown) => {
          if (!closed) {
            setError(String(error))
          }
        })
    }
    const stop = startHostBotRefresh({
      client,
      appState: AppState,
      refresh,
      listed: () => true,
      interest: () => ({ kinds: [...ROOM_KINDS, ...ITEM_KINDS] })
    })
    return () => {
      closed = true
      stop()
    }
  }, [apply, client, groupId, threadId, hostId, visible, setError])
  const loadEarlier = useCallback(async () => {
    if (!data?.hasEarlier) {
      return
    }
    try {
      const result = groupRead.interpret(
        await groupRead.request(client, {
          groupId,
          threadId,
          beforeSequence: data.messages[0]?.sequence
        })
      )
      apply({ kind: 'earlier', page: result })
    } catch (error) {
      setError(String(error))
    }
  }, [apply, client, groupId, threadId, data, setError])
  return { data, group: room.data?.group, apply, bots, needsYou, itemReads, loadEarlier }
}
