import type { RemoteWorkspaceTabObservationAuthority } from './remote-workspace-tab-intent-store'

type ObservationSender = {
  id: number
  once(event: 'destroyed', listener: () => void): unknown
  once(event: 'render-process-gone', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'render-process-gone', listener: () => void): unknown
}

type SenderLease = {
  cleanup: () => void
  generation: number
  processId: number
}

export class RemoteWorkspaceTabObservationOwnerRegistry {
  private leases = new WeakMap<ObservationSender, SenderLease>()
  private nextGeneration = 0

  start(sender: ObservationSender, processId: number): number {
    this.removeLifecycle(sender)
    const generation = ++this.nextGeneration
    let cleaned = false
    const cleanup = (): void => {
      if (cleaned) {
        return
      }
      cleaned = true
      sender.removeListener('destroyed', cleanup)
      sender.removeListener('render-process-gone', cleanup)
      if (this.leases.get(sender)?.generation === generation) {
        this.leases.delete(sender)
      }
    }
    this.leases.set(sender, { cleanup, generation, processId })
    sender.once('destroyed', cleanup)
    sender.once('render-process-gone', cleanup)
    return generation
  }

  resolve(
    sender: ObservationSender,
    processId: number,
    rendererGeneration: unknown
  ): RemoteWorkspaceTabObservationAuthority | null {
    const lease = this.leases.get(sender)
    if (!lease || lease.processId !== processId || lease.generation !== rendererGeneration) {
      return null
    }
    return { processId, rendererGeneration: lease.generation, senderId: sender.id }
  }

  resetForTests(): void {
    this.leases = new WeakMap()
    this.nextGeneration = 0
  }

  private removeLifecycle(sender: ObservationSender): void {
    this.leases.get(sender)?.cleanup()
  }
}
