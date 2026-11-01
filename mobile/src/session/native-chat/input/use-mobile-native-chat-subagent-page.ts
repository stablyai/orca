import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { OlderPagePhase } from '../../use-mobile-older-page-loader'

const INITIAL_LIMIT = 40
const PAGE_LIMIT = 60

export type MobileNativeChatSubagentRead = (
  agentId: string,
  limit: number,
  beforeOffset?: number
) => Promise<
  { messages: NativeChatMessage[]; hasMore?: boolean; beforeOffset?: number } | { error: string }
>

type PageState = {
  agentId: string
  messages: NativeChatMessage[]
  hasMore: boolean
  beforeOffset: number
  loading: boolean
  loadingEarlier: boolean
  earlierFailed: boolean
}

/** One child's paged transcript. A null reader leaves the caller on rows already in the parent. */
export function useMobileNativeChatSubagentPage(
  agentId: string | null,
  readPage: MobileNativeChatSubagentRead | null | undefined
): {
  messages: readonly NativeChatMessage[] | null
  loading: boolean
  hasMore: boolean
  olderPages: OlderPagePhase
  loadEarlier: () => void
} {
  const [page, setPage] = useState<PageState | null>(null)
  const readRef = useRef(readPage)
  readRef.current = readPage
  const pageRef = useRef(page)
  pageRef.current = page
  const pagingRef = useRef(false)

  useEffect(() => {
    const read = readRef.current
    if (!agentId || !read) {
      setPage(null)
      return
    }
    let cancelled = false
    setPage({
      agentId,
      messages: [],
      hasMore: false,
      beforeOffset: 0,
      loading: true,
      loadingEarlier: false,
      earlierFailed: false
    })
    void read(agentId, INITIAL_LIMIT).then((result) => {
      if (cancelled) {
        return
      }
      if ('error' in result) {
        setPage({
          agentId,
          messages: [],
          hasMore: false,
          beforeOffset: 0,
          loading: false,
          loadingEarlier: false,
          earlierFailed: false
        })
        return
      }
      setPage({
        agentId,
        messages: result.messages,
        hasMore: result.hasMore === true,
        beforeOffset: result.beforeOffset ?? 0,
        loading: false,
        loadingEarlier: false,
        earlierFailed: false
      })
    })
    return () => {
      cancelled = true
    }
  }, [agentId, readPage])

  const loadEarlier = useCallback(() => {
    const read = readRef.current
    const current = pageRef.current
    if (
      pagingRef.current ||
      !agentId ||
      !read ||
      !current ||
      current.agentId !== agentId ||
      current.loading ||
      current.loadingEarlier ||
      !current.hasMore
    ) {
      return
    }
    pagingRef.current = true
    const beforeOffset = current.beforeOffset
    setPage({ ...current, loadingEarlier: true, earlierFailed: false })
    void read(agentId, PAGE_LIMIT, beforeOffset)
      .then((result) => {
        setPage((latest) => {
          if (!latest || latest.agentId !== agentId || latest.beforeOffset !== beforeOffset) {
            return latest
          }
          if ('error' in result) {
            return { ...latest, loadingEarlier: false, earlierFailed: true }
          }
          const seen = new Set(latest.messages.map((entry) => entry.id))
          const older = result.messages.filter((entry) => !seen.has(entry.id))
          return {
            agentId,
            messages: [...older, ...latest.messages],
            hasMore: result.hasMore === true,
            beforeOffset: result.beforeOffset ?? latest.beforeOffset,
            loading: false,
            loadingEarlier: false,
            earlierFailed: false
          }
        })
      })
      .finally(() => {
        pagingRef.current = false
      })
  }, [agentId])

  if (!readPage || !agentId || !page || page.agentId !== agentId) {
    return {
      messages: null,
      loading: Boolean(readPage && agentId),
      hasMore: false,
      olderPages: 'idle',
      loadEarlier
    }
  }
  return {
    messages: page.messages,
    loading: page.loading,
    hasMore: page.hasMore,
    olderPages: page.loadingEarlier ? 'loading' : page.earlierFailed ? 'failed' : 'idle',
    loadEarlier
  }
}
