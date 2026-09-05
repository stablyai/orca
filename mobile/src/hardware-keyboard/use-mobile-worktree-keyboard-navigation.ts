import { useCallback, useEffect, useRef, useState } from 'react'
import type { HardwareKeyboardCommandEvent } from '@orca/expo-hardware-keyboard-navigation'
import type { Router } from 'expo-router'
import type { KeybindingContext } from '../../../src/shared/keybindings'
import { getLastCachedWorktrees, setCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { WorktreeCatalogSnapshotClient } from '../worktree/worktree-catalog-snapshot-client'
import type { Worktree } from '../worktree/workspace-list-sections'
import { MOBILE_WORKTREE_KEYBOARD_ACTIONS } from './mobile-hardware-keyboard-actions'
import { useMobileHardwareKeyboardCommands } from './use-mobile-hardware-keyboard-commands'
import {
  getIndexedKeyboardWorktree,
  getRelativeKeyboardWorktree,
  MobileWorktreeNavigationHistory
} from './mobile-worktree-keyboard-navigation'

export function useMobileWorktreeKeyboardNavigation(options: {
  client: RpcClient | null
  connState: ConnectionState
  context: KeybindingContext
  hostId: string | undefined
  orderedWorktrees?: readonly Worktree[]
  router: Router
  worktreeId: string | undefined
}): void {
  const { client, connState, context, hostId, orderedWorktrees, router, worktreeId } = options
  const [worktrees, setWorktrees] = useState<Worktree[]>(() => cachedWorktrees(hostId))
  const catalogRef = useRef(new WorktreeCatalogSnapshotClient())
  const historyRef = useRef(new MobileWorktreeNavigationHistory())
  const worktreesRef = useRef(worktrees)
  const routeRef = useRef({ client, hostId, generation: 0 })
  worktreesRef.current = worktrees
  if (routeRef.current.client !== client || routeRef.current.hostId !== hostId) {
    routeRef.current = { client, hostId, generation: routeRef.current.generation + 1 }
  }

  const refresh = useCallback(async (): Promise<Worktree[] | null> => {
    if (!client || connState !== 'connected' || !hostId) {
      return worktreesRef.current
    }
    const routeGeneration = routeRef.current.generation
    const result = await catalogRef.current.fetch(client, hostId).catch(() => null)
    if (routeRef.current.generation !== routeGeneration) {
      return null
    }
    if (!result || result.kind !== 'response') {
      return worktreesRef.current
    }
    const confirmed = catalogRef.current.admit(result.pending)
    if (!confirmed) {
      return worktreesRef.current
    }
    worktreesRef.current = confirmed
    setWorktrees(confirmed)
    setCachedWorktrees(hostId, confirmed, { proven: true })
    return confirmed
  }, [client, connState, hostId])

  useEffect(() => {
    const cached = cachedWorktrees(hostId)
    worktreesRef.current = cached
    setWorktrees(cached)
    void refresh()
  }, [hostId, refresh])

  useEffect(() => {
    if (worktreeId) {
      historyRef.current.record(worktreeId)
    }
  }, [worktreeId])

  const openWorktree = useCallback(
    (target: Worktree) => {
      if (!hostId || target.worktreeId === worktreeId) {
        return
      }
      if (client && connState === 'connected') {
        void client
          .sendRequest('worktree.activate', {
            worktree: `id:${target.worktreeId}`,
            notifyClients: false,
            navigation: 'caller'
          })
          .catch(() => null)
      }
      router.replace(
        `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(target.worktreeId)}?name=${encodeURIComponent(target.displayName || target.repo)}`
      )
    },
    [client, connState, hostId, router, worktreeId]
  )

  const handleCommand = useCallback(
    (event: HardwareKeyboardCommandEvent) => {
      if (!hostId) {
        return
      }
      if (event.actionId === 'worktree.palette') {
        router.replace(
          `/h/${encodeURIComponent(hostId)}?action=keyboardSwitcher-${Date.now().toString(36)}`
        )
        return
      }

      const apply = (rows: readonly Worktree[], order: 'smart' | 'provided') => {
        const target = resolveWorktreeCommand(event, rows, worktreeId, historyRef.current, order)
        if (target) {
          openWorktree(target)
        }
      }
      if (orderedWorktrees) {
        apply(orderedWorktrees, 'provided')
        return
      }
      if (worktreesRef.current.length > 0) {
        apply(worktreesRef.current, 'smart')
      } else {
        void refresh().then((rows) => {
          if (rows) {
            apply(rows, 'smart')
          }
        })
      }
    },
    [hostId, openWorktree, orderedWorktrees, refresh, router, worktreeId]
  )

  useMobileHardwareKeyboardCommands({
    actionIds: MOBILE_WORKTREE_KEYBOARD_ACTIONS,
    context,
    onCommand: handleCommand
  })
}

function resolveWorktreeCommand(
  event: HardwareKeyboardCommandEvent,
  worktrees: readonly Worktree[],
  currentWorktreeId: string | undefined,
  history: MobileWorktreeNavigationHistory,
  order: 'smart' | 'provided'
): Worktree | null {
  if (event.actionId === 'worktree.navigateUp') {
    return getRelativeKeyboardWorktree(worktrees, currentWorktreeId, -1, order)
  }
  if (event.actionId === 'worktree.navigateDown') {
    return getRelativeKeyboardWorktree(worktrees, currentWorktreeId, 1, order)
  }
  if (event.actionId === 'workspace.selectByIndex') {
    return getIndexedKeyboardWorktree(worktrees, Number(event.key), order)
  }
  const historyTarget =
    event.actionId === 'worktree.history.back'
      ? history.back()
      : event.actionId === 'worktree.history.forward'
        ? history.forward()
        : null
  return historyTarget
    ? (worktrees.find((worktree) => worktree.worktreeId === historyTarget) ?? null)
    : null
}

function cachedWorktrees(hostId: string | undefined): Worktree[] {
  return hostId ? ((getLastCachedWorktrees(hostId) as Worktree[] | null) ?? []) : []
}
