import { useSyncExternalStore } from 'react'
import { NEWER_DAEMON_HOLD_ERROR } from '../../../../src/shared/terminal/daemon/newer-daemon-hold'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'

// Terminal tabs the host refused because a newer Orca there may still run them; any later answer clears one.
let heldTabKeys: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

const heldTabKey = (worktreeId: string, tabId: string): string => `${worktreeId}\u0000${tabId}`

function setHeld(worktreeId: string, tabId: string, held: boolean): void {
  const key = heldTabKey(worktreeId, tabId)
  if (held === heldTabKeys.has(key)) {
    return
  }
  const next = new Set(heldTabKeys)
  if (held) {
    next.add(key)
  } else {
    next.delete(key)
  }
  heldTabKeys = next
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
    () => tabId !== undefined && heldTabKeys.has(heldTabKey(worktreeId, tabId))
  )
}
