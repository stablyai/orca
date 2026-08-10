import { Buffer } from 'node:buffer'
import type { RemoteWorkspaceObservedWorktree } from '../../shared/remote-workspace-types'
import type { RemoteWorkspaceTabIntent } from './remote-workspace-tab-intent-reconciliation'
import type { RemoteWorkspaceTabObservationAuthority } from './remote-workspace-tab-intent-types'

export type RemoteWorkspaceTabIntentTargetState = {
  authority: RemoteWorkspaceTabObservationAuthority
  connected: boolean
  intents: Map<string, RemoteWorkspaceTabIntent>
  lifecycle: number
  overflowed: boolean
  retainedIntentBytes: number
  retainedWorktreeBytes: number
  sequence: number
  worktrees: Map<string, RemoteWorkspaceObservedWorktree>
}

export const MAX_REMOTE_WORKSPACE_TAB_INTENTS_PER_TARGET = 2_048
export const MAX_REMOTE_WORKSPACE_TAB_INTENT_BYTES_PER_TARGET = 2 * 1024 * 1024
export const MAX_REMOTE_WORKSPACE_TAB_RETAINED_BYTES = 16 * 1024 * 1024

function intentBytes(slot: string, intent: RemoteWorkspaceTabIntent): number {
  return Buffer.byteLength(slot, 'utf8') + Buffer.byteLength(JSON.stringify(intent), 'utf8') + 1
}

export class RemoteWorkspaceTabIntentRetention {
  private nextLifecycle = 0
  private retainedBytes = 0

  createTarget(
    authority: RemoteWorkspaceTabObservationAuthority,
    connected: boolean,
    worktrees: Map<string, RemoteWorkspaceObservedWorktree>,
    retainedWorktreeBytes: number
  ): RemoteWorkspaceTabIntentTargetState {
    this.nextLifecycle += 1
    const state: RemoteWorkspaceTabIntentTargetState = {
      authority,
      connected,
      intents: new Map(),
      lifecycle: this.nextLifecycle,
      overflowed: false,
      retainedIntentBytes: 0,
      retainedWorktreeBytes: 0,
      sequence: 0,
      worktrees: new Map()
    }
    this.replaceWorktrees(state, worktrees, retainedWorktreeBytes)
    return state
  }

  retain(
    state: RemoteWorkspaceTabIntentTargetState,
    slot: string,
    intent: RemoteWorkspaceTabIntent
  ): boolean {
    const previous = state.intents.get(slot)
    const retainedBytes =
      state.retainedIntentBytes -
      (previous ? intentBytes(slot, previous) : 0) +
      intentBytes(slot, intent)
    if (
      state.intents.size + (previous ? 0 : 1) > MAX_REMOTE_WORKSPACE_TAB_INTENTS_PER_TARGET ||
      retainedBytes > MAX_REMOTE_WORKSPACE_TAB_INTENT_BYTES_PER_TARGET ||
      this.retainedBytes -
        (previous ? intentBytes(slot, previous) : 0) +
        intentBytes(slot, intent) >
        MAX_REMOTE_WORKSPACE_TAB_RETAINED_BYTES
    ) {
      this.overflow(state)
      return false
    }
    state.sequence = intent.sequence
    state.intents.set(slot, intent)
    this.retainedBytes += retainedBytes - state.retainedIntentBytes
    state.retainedIntentBytes = retainedBytes
    return true
  }

  acknowledge(
    state: RemoteWorkspaceTabIntentTargetState,
    slot: string,
    intent: RemoteWorkspaceTabIntent
  ): void {
    state.intents.delete(slot)
    const releasedBytes = intentBytes(slot, intent)
    state.retainedIntentBytes -= releasedBytes
    this.retainedBytes -= releasedBytes
  }

  overflow(state: RemoteWorkspaceTabIntentTargetState): void {
    this.retainedBytes -= state.retainedIntentBytes + state.retainedWorktreeBytes
    state.intents.clear()
    state.retainedIntentBytes = 0
    state.retainedWorktreeBytes = 0
    state.worktrees.clear()
    state.overflowed = true
  }

  release(state: RemoteWorkspaceTabIntentTargetState): void {
    this.retainedBytes -= state.retainedIntentBytes + state.retainedWorktreeBytes
    state.intents.clear()
    state.retainedIntentBytes = 0
    state.retainedWorktreeBytes = 0
    state.worktrees.clear()
  }

  replaceWorktrees(
    state: RemoteWorkspaceTabIntentTargetState,
    worktrees: Map<string, RemoteWorkspaceObservedWorktree>,
    retainedWorktreeBytes: number
  ): boolean {
    const nextRetainedBytes =
      this.retainedBytes - state.retainedWorktreeBytes + retainedWorktreeBytes
    if (nextRetainedBytes > MAX_REMOTE_WORKSPACE_TAB_RETAINED_BYTES) {
      this.overflow(state)
      return false
    }
    this.retainedBytes = nextRetainedBytes
    state.retainedWorktreeBytes = retainedWorktreeBytes
    state.worktrees = worktrees
    return true
  }

  evictBaseline(
    targets: Map<string, RemoteWorkspaceTabIntentTargetState>,
    incomingConnected: boolean
  ): boolean {
    const candidates = [...targets].filter(
      ([, state]) => !state.overflowed && state.intents.size === 0
    )
    const victim =
      candidates.find(([, state]) => !state.connected) ??
      (incomingConnected ? candidates[0] : undefined)
    if (!victim) {
      return false
    }
    this.release(victim[1])
    targets.delete(victim[0])
    return true
  }

  reset(): void {
    this.nextLifecycle = 0
    this.retainedBytes = 0
  }
}
