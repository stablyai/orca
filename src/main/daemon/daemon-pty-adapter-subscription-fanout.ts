import type { PtyBackgroundStreamEvent } from '../providers/types'
import { combineUnsubscribes } from './combine-unsubscribes'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonPtyRouterDataEvent, DaemonPtyRouterExitEvent } from './daemon-pty-router-events'

export class DaemonPtyAdapterSubscriptionFanout {
  private unsubscribers = new Map<DaemonPtyAdapter, Set<() => void>>()
  private dataListeners: ((payload: DaemonPtyRouterDataEvent) => void)[] = []
  private exitListeners: ((payload: DaemonPtyRouterExitEvent) => void)[] = []

  constructor(
    private adapters: readonly DaemonPtyAdapter[],
    onAdapterExit: (id: string, adapter: DaemonPtyAdapter, incarnationId?: string) => void,
    onAdapterIdentityChanged?: (adapter: DaemonPtyAdapter) => void
  ) {
    for (const adapter of adapters) {
      this.unsubscribers.set(
        adapter,
        new Set([
          adapter.onData((payload) => {
            for (const listener of this.dataListeners) {
              listener(payload)
            }
          }),
          adapter.onExit((payload) => {
            onAdapterExit(payload.id, adapter, payload.incarnationId)
            for (const listener of this.exitListeners) {
              listener(payload)
            }
          }),
          ...(onAdapterIdentityChanged && typeof adapter.onDaemonIdentityChanged === 'function'
            ? [adapter.onDaemonIdentityChanged(() => onAdapterIdentityChanged(adapter))]
            : [])
        ])
      )
    }
  }

  onData(callback: (payload: DaemonPtyRouterDataEvent) => void): () => void {
    this.dataListeners.push(callback)
    return () => {
      const index = this.dataListeners.indexOf(callback)
      if (index !== -1) {
        this.dataListeners.splice(index, 1)
      }
    }
  }

  onBackgroundStreamEvent(callback: (payload: PtyBackgroundStreamEvent) => void): () => void {
    return combineUnsubscribes(
      this.adapters.map((adapter) => this.track(adapter, adapter.onBackgroundStreamEvent(callback)))
    )
  }

  // Why: main subscribes on the routed provider, so without this the dead-endpoint
  // fan-out never reaches the renderer and only the written pane recovers (STA-2373).
  onWriteUnavailable(callback: (payload: { id: string }) => void): () => void {
    return combineUnsubscribes(
      this.adapters.map((adapter) => this.track(adapter, adapter.onWriteUnavailable(callback)))
    )
  }

  onReplay(_callback: (payload: { id: string; data: string }) => void): () => void {
    return () => {}
  }

  onExit(callback: (payload: DaemonPtyRouterExitEvent) => void): () => void {
    this.exitListeners.push(callback)
    return () => {
      const index = this.exitListeners.indexOf(callback)
      if (index !== -1) {
        this.exitListeners.splice(index, 1)
      }
    }
  }

  removeAdapter(adapter: DaemonPtyAdapter): void {
    for (const unsubscribe of this.unsubscribers.get(adapter) ?? []) {
      unsubscribe()
    }
    this.unsubscribers.delete(adapter)
    this.adapters = this.adapters.filter((candidate) => candidate !== adapter)
  }

  private track(adapter: DaemonPtyAdapter, unsubscribe: () => void): () => void {
    this.unsubscribers.get(adapter)?.add(unsubscribe)
    return () => {
      if (this.unsubscribers.get(adapter)?.delete(unsubscribe)) {
        unsubscribe()
      }
    }
  }

  dispose(): void {
    for (const adapter of this.adapters) {
      this.removeAdapter(adapter)
    }
  }
}
