import { useCallback, type MutableRefObject } from 'react'
import type { NativeChatMerger } from '../../../../src/shared/native-chat/native-chat-merge'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTranscriptPage } from '../../../../src/shared/native-chat/native-chat-transcript-frames'
import type { RpcClient } from '../../transport/rpc-client'
import { nativeChatSessionPageRead } from '../mobile-session-read-operations'
import type { useMobileOlderPageLoader } from '../use-mobile-older-page-loader'

const PAGE = 60
export const MAX_MESSAGES = 2000

function nextPageWindow(
  limit: number,
  listLength: number
): { nextLimit: number; pageLimit: number } | null {
  // Live output grows the list past the last read, so the next page counts from what is held.
  const held = Math.max(limit, listLength)
  const nextLimit = Math.min(held + PAGE, MAX_MESSAGES)
  return nextLimit > held ? { nextLimit, pageLimit: nextLimit - held } : null
}

type ReadSessionResult =
  | (Pick<NativeChatTranscriptPage, 'messages'> &
      Partial<Pick<NativeChatTranscriptPage, 'hasMore' | 'beforeOffset'>>)
  | { error: string }

/** Page older rows into the held transcript, bounded by the retained capacity. */
export function useMobileNativeChatLoadEarlier(args: {
  client: RpcClient | null
  agent: string | null
  sessionId: string | null
  transcriptPath: string | null
  hasMore: boolean
  setList: (next: readonly NativeChatMessage[]) => void
  setHasMore: (value: boolean) => void
  loadOlderPages: ReturnType<typeof useMobileOlderPageLoader>['load']
  limitRef: MutableRefObject<number>
  mergerRef: MutableRefObject<NativeChatMerger>
  beforeOffsetRef: MutableRefObject<number | null>
  sessionIdRef: MutableRefObject<string | null>
}): () => void {
  const {
    client,
    agent,
    sessionId,
    transcriptPath,
    hasMore,
    setList,
    setHasMore,
    loadOlderPages,
    limitRef,
    mergerRef,
    beforeOffsetRef,
    sessionIdRef
  } = args
  return useCallback(() => {
    if (!client || !agent || !sessionId || !hasMore) {
      return
    }
    // Capture the page’s session so late replies cannot land in a newly selected chat.
    const requestSessionId = sessionId
    loadOlderPages(async ({ timeoutMs, isCurrent }) => {
      const page = nextPageWindow(limitRef.current, mergerRef.current.list.length)
      if (!page) {
        setHasMore(false)
        return 'end'
      }
      const { nextLimit, pageLimit } = page
      const beforeOffset = beforeOffsetRef.current
      const response = await nativeChatSessionPageRead.request(
        client,
        {
          agent,
          sessionId,
          limit: beforeOffset === null ? nextLimit : pageLimit,
          capabilities: { transcriptSourceOrder: 1 },
          ...(beforeOffset === null ? {} : { beforeOffset }),
          ...(transcriptPath ? { transcriptPath } : {})
        },
        { timeoutMs, budgetSpansConnect: true }
      )
      const accepted = nativeChatSessionPageRead.interpret(response)
      if (!accepted.accepted) {
        return 'failed'
      }
      // Accepted legacy-union replies may be absent/null; validate before using the in operator.
      const payload = accepted.value
      if (payload === null || typeof payload !== 'object') {
        return 'failed'
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main cast this payload unread; the reader hands back the same result.
      const result = payload as ReadSessionResult
      if ('error' in result) {
        return 'failed'
      }
      // Apply pages only to their captured window/cursor; otherwise retry from the new window.
      if (
        !isCurrent() ||
        sessionIdRef.current !== requestSessionId ||
        beforeOffsetRef.current !== beforeOffset
      ) {
        return 'end'
      }
      limitRef.current = nextLimit
      let more: boolean
      if (beforeOffset !== null && result.beforeOffset != null) {
        beforeOffsetRef.current = result.beforeOffset
        setList([...result.messages, ...mergerRef.current.list])
        more = nextLimit < MAX_MESSAGES && (result.hasMore ?? result.messages.length >= pageLimit)
      } else {
        // Legacy hosts return a growing tail instead of cursor pages; preserve rows streamed during the read.
        const live = mergerRef.current.list
        const after = live.findIndex((message) => message.id === result.messages.at(-1)?.id)
        setList(after === -1 ? result.messages : [...result.messages, ...live.slice(after + 1)])
        more = result.messages.length >= nextLimit
      }
      setHasMore(more)
      return more ? 'drew' : 'end'
    })
  }, [
    client,
    agent,
    sessionId,
    transcriptPath,
    hasMore,
    setList,
    setHasMore,
    loadOlderPages,
    limitRef,
    mergerRef,
    beforeOffsetRef,
    sessionIdRef
  ])
}
