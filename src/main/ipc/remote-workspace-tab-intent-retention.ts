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
  sequence: number
  worktrees: Map<string, RemoteWorkspaceObservedWorktree>
}

export const MAX_REMOTE_WORKSPACE_TAB_INTENTS_PER_TARGET = 2_048
export const MAX_REMOTE_WORKSPACE_TAB_INTENT_BYTES_PER_TARGET = 2 * 1024 * 1024

function intentBytes(slot: string, intent: RemoteWorkspaceTabIntent): number {
  return Buffer.byteLength(slot, 'utf8') + Buffer.byteLength(JSON.stringify(intent), 'utf8') + 1
}

export class RemoteWorkspaceTabIntentRetention {
  private nextLifecycle = 0

  createTarget(
    authority: RemoteWorkspaceTabObservationAuthority,
    connected: boolean,
    worktrees: Map<string, RemoteWorkspaceObservedWorktree>
  ): RemoteWorkspaceTabIntentTargetState {
    this.nextLifecycle += 1
    return {
      authority,
      connected,
      intents: new Map(),
      lifecycle: this.nextLifecycle,
      overflowed: false,
      retainedIntentBytes: 0,
      sequence: 0,
      worktrees
    }
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
      retainedBytes > MAX_REMOTE_WORKSPACE_TAB_INTENT_BYTES_PER_TARGET
    ) {
      this.overflow(state)
      return false
    }
    state.sequence = intent.sequence
    state.intents.set(slot, intent)
    state.retainedIntentBytes = retainedBytes
    return true
  }

  acknowledge(
    state: RemoteWorkspaceTabIntentTargetState,
    slot: string,
    intent: RemoteWorkspaceTabIntent
  ): void {
    state.intents.delete(slot)
    state.retainedIntentBytes -= intentBytes(slot, intent)
  }

  overflow(state: RemoteWorkspaceTabIntentTargetState): void {
    state.intents.clear()
    state.retainedIntentBytes = 0
    state.overflowed = true
  }

  reset(): void {
    this.nextLifecycle = 0
  }
}
