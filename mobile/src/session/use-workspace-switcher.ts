import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, PanResponder } from 'react-native'
import { useResetHostStack } from '../navigation/use-reset-host-stack'
import { triggerSelection } from '../platform/haptics'
import { loadHostCatalog } from '../transport/host-store'
import type { HostCatalogEntry } from '../transport/types'
import {
  loadRecentWorkspaces,
  recordRecentWorkspace,
  subscribeRecentWorkspaces,
  type RecentWorkspace
} from '../worktree/recent-workspaces'
import {
  buildWorkspaceSwitcherGroups,
  previousRecentWorkspace,
  type WorkspaceSwitcherHostGroup
} from './workspace-switcher-model'

const SWIPE_ACTIVATE_DX = 12
const SWIPE_COMMIT_DX = 56

type Scope = {
  hostId: string
  worktreeId: string
  worktreeName: string
  hasDirtyDrafts: () => boolean
  showToast: (message: string, durationMs?: number) => void
}

export function useWorkspaceSwitcher({
  hostId,
  worktreeId,
  worktreeName,
  hasDirtyDrafts,
  showToast
}: Scope) {
  const resetHostStack = useResetHostStack(hostId)
  const [visible, setVisible] = useState(false)
  const [recents, setRecents] = useState<RecentWorkspace[]>([])
  const [hosts, setHosts] = useState<HostCatalogEntry[]>([])

  useEffect(() => {
    let stale = false
    void loadRecentWorkspaces().then((list) => !stale && setRecents(list))
    // Why: a failed catalog read leaves the list empty; the sheet still lists recents' hosts on retry.
    void loadHostCatalog()
      .then((catalog) => !stale && setHosts(catalog))
      .catch(() => {})
    const unsubscribe = subscribeRecentWorkspaces(setRecents)
    return () => {
      stale = true
      unsubscribe()
    }
  }, [])

  // Recorded on entry and again once the live name resolves, so rows never show a bare id.
  useEffect(() => {
    if (hostId && worktreeId) {
      void recordRecentWorkspace({
        hostId,
        worktreeId,
        name: worktreeName,
        openedAt: Date.now()
      }).catch(() => {})
    }
  }, [hostId, worktreeId, worktreeName])

  const open = useCallback(() => {
    Keyboard.dismiss()
    void loadHostCatalog()
      .then(setHosts)
      .catch(() => {})
    setVisible(true)
  }, [])
  const close = useCallback(() => setVisible(false), [])

  const guardDrafts = useCallback(() => {
    if (!hasDirtyDrafts()) {
      return true
    }
    showToast('Save or discard markdown drafts first', 2000)
    return false
  }, [hasDirtyDrafts, showToast])

  const switchToWorkspace = useCallback(
    (target: RecentWorkspace) => {
      if (target.hostId === hostId && target.worktreeId === worktreeId) {
        return
      }
      if (guardDrafts()) {
        resetHostStack(target.hostId, { worktreeId: target.worktreeId, name: target.name })
      }
    },
    [guardDrafts, hostId, resetHostStack, worktreeId]
  )

  const switchToHost = useCallback(
    (targetHostId: string) => {
      if (guardDrafts()) {
        resetHostStack(targetHostId)
      }
    },
    [guardDrafts, resetHostStack]
  )

  const groups: WorkspaceSwitcherHostGroup[] = useMemo(
    () => buildWorkspaceSwitcherGroups(hosts, recents),
    [hosts, recents]
  )

  const flipTarget = useMemo(
    () =>
      previousRecentWorkspace(
        recents,
        { hostId, worktreeId },
        new Set(hosts.map((host) => host.id))
      ),
    [hostId, hosts, recents, worktreeId]
  )
  const flipRef = useRef<() => void>(() => {})
  flipRef.current = () => {
    if (flipTarget) {
      triggerSelection()
      switchToWorkspace(flipTarget)
    }
  }

  // Why capture: the title's own Pressable owns the touch on start, so a horizontal drag must be
  // claimed on the way down or it only ever reads as a tap.
  const swipeHandlers = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_evt, g) =>
        Math.abs(g.dx) > SWIPE_ACTIVATE_DX && Math.abs(g.dx) > Math.abs(g.dy) * 2,
      onPanResponderRelease: (_evt, g) => {
        if (Math.abs(g.dx) >= SWIPE_COMMIT_DX) {
          flipRef.current()
        }
      }
    })
  ).current.panHandlers

  return {
    visible,
    open,
    close,
    groups,
    flipTarget,
    swipeHandlers,
    switchToWorkspace,
    switchToHost
  }
}

export type WorkspaceSwitcher = ReturnType<typeof useWorkspaceSwitcher>
