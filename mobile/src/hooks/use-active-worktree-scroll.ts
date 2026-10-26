import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { SectionList, SectionListData } from 'react-native'

type WithId = { worktreeId: string; isActive?: boolean }

// Scroll only when the active workspace changes; revealing the same workspace after search/unfold must not yank the list. Retry unmeasured variable-height rows.
export function useActiveWorktreeScroll<T extends WithId, S>(
  sections: readonly (SectionListData<T, S> & { data: readonly T[] })[],
  collapsedGroups?: ReadonlySet<string>
): {
  sectionListRef: React.RefObject<SectionList<T, S> | null>
  onScrollToIndexFailed: (info: { averageItemLength: number }) => void
} {
  const sectionListRef = useRef<SectionList<T, S>>(null)
  const lastScrolledActiveIdRef = useRef<string | null>(null)
  // The last workspace highlighted, scrolled to or not: a hidden row coming back is no change.
  const seenActiveIdRef = useRef<string | null>(null)
  const collapsedGroupsRef = useRef(collapsedGroups)

  const activeWorktreeId = useMemo(() => {
    for (const section of sections) {
      const match = section.data.find((w) => w.isActive)
      if (match) {
        return match.worktreeId
      }
    }
    return null
  }, [sections])

  // Use the current active id to reject deferred retries after selection changes.
  const activeWorktreeIdRef = useRef<string | null>(activeWorktreeId)
  activeWorktreeIdRef.current = activeWorktreeId

  const scrollToWorktree = useCallback(
    (worktreeId: string): boolean => {
      for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
        const itemIndex = sections[sectionIndex].data.findIndex((w) => w.worktreeId === worktreeId)
        if (itemIndex !== -1) {
          sectionListRef.current?.scrollToLocation({
            sectionIndex,
            itemIndex,
            viewPosition: 0.5,
            animated: true
          })
          return true
        }
      }
      return false
    },
    [sections]
  )

  useEffect(() => {
    const folded = collapsedGroupsRef.current !== collapsedGroups
    collapsedGroupsRef.current = collapsedGroups
    if (!activeWorktreeId || activeWorktreeId === seenActiveIdRef.current) {
      return
    }
    seenActiveIdRef.current = activeWorktreeId
    if (!folded && scrollToWorktree(activeWorktreeId)) {
      lastScrolledActiveIdRef.current = activeWorktreeId
    }
  }, [collapsedGroups, activeWorktreeId, scrollToWorktree])

  const onScrollToIndexFailed = useCallback(
    (info: { averageItemLength: number }) => {
      const target = lastScrolledActiveIdRef.current
      if (!target) {
        return
      }
      setTimeout(
        () => {
          if (activeWorktreeIdRef.current === target) {
            scrollToWorktree(target)
          }
        },
        info.averageItemLength > 0 ? 120 : 0
      )
    },
    [scrollToWorktree]
  )

  return { sectionListRef, onScrollToIndexFailed }
}
