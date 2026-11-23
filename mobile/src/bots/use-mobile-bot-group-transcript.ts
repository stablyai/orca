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
const ITEM_KINDS: readonly BotChangeKind[] = ['items', 'workers']
// A chat starting or ending a wait on the owner: what a member's asks are read from.
const ASK_KINDS: readonly BotChangeKind[] = ['chats', 'status']

/** Bumps for the group's Items list to read again: `rooms` its rooms, `all` every member's items,
 *  `bots` one member's; `asks` the same for members' chats alone, which change too often to re-read
 *  their items with. */
export type BotGroupItemReads = {
  rooms: number
  all: number
  bots: Readonly<Record<string, number>>
  asks: { all: number; bots: Readonly<Record<string, number>> }
}

/** Who a change names among the members: every one (null), or some. */
function namedMembers(
  changed: BotChangeScope | undefined,
  kinds: readonly BotChangeKind[],
  memberIds: readonly string[]
): readonly string[] | null {
  if (!botChangeConcerns(changed, { kinds })) {
    return []
  }
  const named = botChangeBotIds(changed, kinds)
  return named === null ? null : named.filter((id) => memberIds.includes(id))
}

function sameCounts(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>
): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

function bumpEach(
  counts: Readonly<Record<string, number>>,
  ids: readonly string[]
): Readonly<Record<string, number>> {
  const next = { ...counts }
  ids.forEach((id) => {
    next[id] = (next[id] ?? 0) + 1
  })
  return next
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
  const [itemReads, setItemReads] = useState<BotGroupItemReads>({
    rooms: 0,
    all: 0,
    bots: {},
    asks: { all: 0, bots: {} }
  })
  // The members the Items drawer reads, which it sets from the group list: a thread room's own read
  // lists only the thread's members.
  const itemMemberIds = useRef<readonly string[]>([])
  useEffect(() => {
    if (!visible) {
      return
    }
    let closed = false
    let request = 0
    const refresh = (changed?: BotChangeScope) => {
      const rooms = botChangeConcerns(changed, { kinds: ['groups'] })
      // An items or workers change naming no bot can change every member's list; another bot's
      // changes nothing a member's list shows. A group change reaches the lists only by moving their
      // rooms, which re-reads them through the group list.
      const members = namedMembers(changed, ITEM_KINDS, itemMemberIds.current)
      const askers = namedMembers(changed, ASK_KINDS, itemMemberIds.current)
      if (rooms || members?.length !== 0 || askers?.length !== 0) {
        setItemReads((last) => ({
          rooms: last.rooms + (rooms ? 1 : 0),
          all: last.all + (members === null ? 1 : 0),
          bots: members?.length ? bumpEach(last.bots, members) : last.bots,
          asks:
            askers?.length !== 0
              ? {
                  all: last.asks.all + (askers === null ? 1 : 0),
                  bots: askers ? bumpEach(last.asks.bots, askers) : last.asks.bots
                }
              : last.asks
        }))
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
      interest: () => ({ kinds: [...ROOM_KINDS, ...ITEM_KINDS, ...ASK_KINDS] })
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
  return {
    data,
    group: room.data?.group,
    apply,
    bots,
    needsYou,
    itemReads,
    itemMemberIds,
    loadEarlier
  }
}
