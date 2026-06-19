import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { SectionList, SectionListData } from 'react-native'

type WithId = { worktreeId: string; isActive?: boolean }

// Scrolls the desktop-focused worktree into view when the active selection
// changes, so the mobile list mirrors the desktop's current workspace. Fires
// only on a *change* of active id (not every re-render) so it never yanks the
// list while the user scrolls or searches. Returns the ref to attach to the
// SectionList and the onScrollToIndexFailed handler it needs for rows that
// aren't measured yet (variable heights from the inline agent list).
export function useActiveWorktreeScroll<T extends WithId, S>(
  sections: ReadonlyArray<SectionListData<T, S> & { data: readonly T[] }>
): {
  sectionListRef: React.RefObject<SectionList<T, S> | null>
  onScrollToIndexFailed: (info: { averageItemLength: number }) => void
} {
  const sectionListRef = useRef<SectionList<T, S>>(null)
  const lastScrolledActiveIdRef = useRef<string | null>(null)

  const activeWorktreeId = useMemo(() => {
    for (const section of sections) {
      const match = section.data.find((w) => w.isActive)
      if (match) {
        return match.worktreeId
      }
    }
    return null
  }, [sections])

  // Live mirror of the current active id so the deferred retry can bail if the
  // selection changed during its timeout (avoids a brief scroll to a stale row).
  const activeWorktreeIdRef = useRef<string | null>(activeWorktreeId)
  activeWorktreeIdRef.current = activeWorktreeId

  const scrollToWorktree = useCallback(
    (worktreeId: string): boolean => {
      for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
        const itemIndex = sections[sectionIndex].data.findIndex((w) => w.worktreeId === worktreeId)
        if (itemIndex >= 0) {
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
    if (!activeWorktreeId || activeWorktreeId === lastScrolledActiveIdRef.current) {
      return
    }
    if (scrollToWorktree(activeWorktreeId)) {
      lastScrolledActiveIdRef.current = activeWorktreeId
    }
  }, [activeWorktreeId, scrollToWorktree])

  const onScrollToIndexFailed = useCallback(
    (info: { averageItemLength: number }) => {
      const target = lastScrolledActiveIdRef.current
      if (!target) {
        return
      }
      setTimeout(
        () => {
          // Bail if the active selection moved on while we waited — otherwise we'd
          // scroll to a now-stale row before the effect corrects it.
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
