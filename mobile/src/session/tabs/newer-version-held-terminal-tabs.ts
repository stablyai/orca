import { useSyncExternalStore } from 'react'
import { NEWER_DAEMON_HOLD_ERROR } from '../../../../src/shared/terminal/daemon/newer-daemon-hold'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'

// Only the shown pending tab needs the notice, so one slot is kept; any later answer for it clears it.
let heldTabKey: string | null = null
const listeners = new Set<() => void>()

const tabKey = (worktreeId: string, tabId: string): string => `${worktreeId}\u0000${tabId}`

function setHeld(worktreeId: string, tabId: string, held: boolean): void {
  const key = tabKey(worktreeId, tabId)
  const next = held ? key : heldTabKey === key ? null : heldTabKey
  if (next === heldTabKey) {
    return
  }
  heldTabKey = next
  listeners.forEach((listener) => listener())
}

/** Records whether the host's answer to a tab activation was the newer-version hold. */
export function noteTerminalTabActivation(
  worktreeId: string,
  tabId: string,
  response: RpcResponse
): void {
  setHeld(
    worktreeId,
    tabId,
    !response.ok && response.error.message.includes(NEWER_DAEMON_HOLD_ERROR)
  )
}

export function clearTerminalTabHold(worktreeId: string, tabId: string): void {
  setHeld(worktreeId, tabId, false)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTerminalTabHeldByNewerVersion(
  worktreeId: string,
  tabId: string | undefined
): boolean {
  return useSyncExternalStore(
    subscribe,
    () => tabId !== undefined && heldTabKey === tabKey(worktreeId, tabId)
  )
}
