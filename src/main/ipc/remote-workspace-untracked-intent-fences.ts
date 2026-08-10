import { isValidRemoteWorkspaceTargetId } from './remote-workspace-tab-observation-bounds'
import type {
  RemoteWorkspaceTabObservationAuthority,
  RemoteWorkspaceUntrackedIntentFence
} from './remote-workspace-tab-intent-types'

export const MAX_REMOTE_WORKSPACE_UNTRACKED_INTENT_TARGETS = 64

export class RemoteWorkspaceUntrackedIntentFences {
  private readonly targets = new Map<string, RemoteWorkspaceUntrackedIntentFence>()
  private nextSequence = 0
  private overflowAuthority: RemoteWorkspaceTabObservationAuthority | null = null

  canObserve(targetId: string, authority: RemoteWorkspaceTabObservationAuthority): boolean {
    const fence = this.targets.get(targetId)
    return !fence || this.canReplace(fence.authority, authority)
  }

  record(targetId: string, authority: RemoteWorkspaceTabObservationAuthority): void {
    if (!isValidRemoteWorkspaceTargetId(targetId)) {
      return
    }
    const fence = {
      authority: { ...authority },
      sequence: ++this.nextSequence
    }
    if (
      this.targets.has(targetId) ||
      this.targets.size < MAX_REMOTE_WORKSPACE_UNTRACKED_INTENT_TARGETS
    ) {
      this.targets.set(targetId, fence)
      return
    }
    if (!this.overflowAuthority || this.canReplace(this.overflowAuthority, authority)) {
      this.overflowAuthority = { ...authority }
    }
  }

  forget(targetId: string, authority: RemoteWorkspaceTabObservationAuthority): void {
    const fence = this.targets.get(targetId)
    if (fence && this.canReplace(fence.authority, authority)) {
      this.targets.delete(targetId)
    }
  }

  clear(targetId: string): void {
    this.targets.delete(targetId)
  }

  forgetAll(authority: RemoteWorkspaceTabObservationAuthority): void {
    for (const [targetId, fence] of this.targets) {
      if (this.canReplace(fence.authority, authority)) {
        this.targets.delete(targetId)
      }
    }
    if (this.overflowAuthority && this.canReplace(this.overflowAuthority, authority)) {
      this.overflowAuthority = null
    }
  }

  blocks(targetId: string): boolean {
    return this.targets.has(targetId) || this.overflowAuthority !== null
  }

  capture(targetId: string): RemoteWorkspaceUntrackedIntentFence | null {
    const fence = this.targets.get(targetId)
    return fence ? { authority: { ...fence.authority }, sequence: fence.sequence } : null
  }

  acknowledge(targetId: string, capture: RemoteWorkspaceUntrackedIntentFence | null): void {
    const current = this.targets.get(targetId)
    if (
      capture &&
      current &&
      capture.sequence === current.sequence &&
      this.sameAuthority(capture.authority, current.authority)
    ) {
      this.targets.delete(targetId)
    }
  }

  reset(): void {
    this.targets.clear()
    this.nextSequence = 0
    this.overflowAuthority = null
  }

  private canReplace(
    current: RemoteWorkspaceTabObservationAuthority,
    candidate: RemoteWorkspaceTabObservationAuthority
  ): boolean {
    return (
      candidate.rendererGeneration > current.rendererGeneration ||
      this.sameAuthority(current, candidate)
    )
  }

  private sameAuthority(
    left: RemoteWorkspaceTabObservationAuthority,
    right: RemoteWorkspaceTabObservationAuthority
  ): boolean {
    return (
      left.rendererGeneration === right.rendererGeneration &&
      left.processId === right.processId &&
      left.senderId === right.senderId
    )
  }
}
