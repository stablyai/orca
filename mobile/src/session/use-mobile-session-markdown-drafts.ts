import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import type {
  HostSessionMarkdownOperations,
  HostSessionMarkdownTarget
} from './host-session-markdown-operations'
import {
  MobileSessionMarkdownDraftCoordinator,
  restoreMobileSessionMarkdownDraft
} from './mobile-session-markdown-draft-coordinator'
import type { MarkdownDocState, MobileSessionTab } from './mobile-session-route-types'

type MarkdownTab = Extract<MobileSessionTab, { type: 'markdown' }>

export function useMobileSessionMarkdownDrafts(args: {
  workspaceId: string
  tabs: readonly MobileSessionTab[]
  docs: ReadonlyMap<string, MarkdownDocState>
  setDocs: Dispatch<SetStateAction<Map<string, MarkdownDocState>>>
  operations: HostSessionMarkdownOperations | null
}) {
  const { workspaceId, tabs, docs, setDocs, operations } = args
  const coordinator = useMemo(
    () => (operations ? new MobileSessionMarkdownDraftCoordinator(operations) : null),
    [operations]
  )
  const tabsRef = useRef(tabs)
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  useEffect(() => () => coordinator?.dispose(), [coordinator])

  useEffect(() => {
    if (!coordinator) {
      return
    }
    for (const tab of markdownTabs(tabs)) {
      const doc = docs.get(tab.id)
      if (doc?.status !== 'ready' || !doc.editable || !doc.baseVersion) {
        continue
      }
      const target = markdownTarget(workspaceId, tab)
      void coordinator
        .hydrate(target, (draft) => {
          setDocs((current) => {
            const live = current.get(tab.id)
            if (
              live?.status !== 'ready' ||
              live.isDirty ||
              !live.editable ||
              live.content !== doc.content ||
              live.baseVersion !== doc.baseVersion
            ) {
              return current
            }
            return new Map(current).set(tab.id, restoreMobileSessionMarkdownDraft(live, draft))
          })
        })
        .catch(() => {})
    }
  }, [coordinator, docs, setDocs, tabs, workspaceId])

  useEffect(() => {
    if (!coordinator) {
      return
    }
    for (const tab of markdownTabs(tabs)) {
      const doc = docs.get(tab.id)
      if (
        doc?.status !== 'ready' ||
        !doc.editable ||
        !doc.baseVersion ||
        !coordinator.isHydrated(markdownTarget(workspaceId, tab))
      ) {
        continue
      }
      coordinator.scheduleSave(
        markdownTarget(workspaceId, tab),
        doc.isDirty ? { content: doc.localContent, baseVersion: doc.baseVersion } : null
      )
    }
  }, [coordinator, docs, tabs, workspaceId])

  const markEdited = useCallback(
    (tabId: string) => {
      const tab = markdownTabs(tabsRef.current).find((candidate) => candidate.id === tabId)
      if (tab) {
        coordinator?.markEdited(markdownTarget(workspaceId, tab))
      }
    },
    [coordinator, workspaceId]
  )

  const clearDraft = useCallback(
    async (tab: MarkdownTab) => {
      await coordinator?.clear(markdownTarget(workspaceId, tab))
    },
    [coordinator, workspaceId]
  )

  const clearDrafts = useCallback(
    async (tabIds: readonly string[]) => {
      const ids = new Set(tabIds)
      await Promise.all(
        markdownTabs(tabsRef.current)
          .filter((tab) => ids.has(tab.id))
          .map((tab) => coordinator?.clear(markdownTarget(workspaceId, tab)))
      )
    },
    [coordinator, workspaceId]
  )

  return { markEdited, clearDraft, clearDrafts }
}

function markdownTabs(tabs: readonly MobileSessionTab[]): MarkdownTab[] {
  return tabs.filter((tab): tab is MarkdownTab => tab.type === 'markdown')
}

function markdownTarget(workspaceId: string, tab: MarkdownTab): HostSessionMarkdownTarget {
  return {
    workspaceId,
    tabId: tab.id,
    relativePath: tab.relativePath
  }
}
