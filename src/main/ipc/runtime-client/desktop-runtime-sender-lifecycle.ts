import type { AppDocument } from '../app-registry/app-handler-registry'

import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

type SenderState = {
  connectionId: string
  sender: AppDocument
  subscriptions: Map<string, AbortController>
}

type CleanupRuntime = Pick<OrcaRuntimeService, 'cleanupSubscriptionsForConnection'>

export class DesktopRuntimeSenderLifecycle {
  private readonly senders = new Map<number, SenderState>()
  private nextConnectionGeneration = 1

  constructor(private readonly runtime: CleanupRuntime) {}

  connectionIdFor(sender: AppDocument): string {
    return this.stateFor(sender).connectionId
  }

  subscriptionsFor(sender: AppDocument): Map<string, AbortController> {
    return this.stateFor(sender).subscriptions
  }

  existingSubscriptionsFor(sender: AppDocument): Map<string, AbortController> | null {
    const state = this.senders.get(sender.id)
    return state?.sender === sender ? state.subscriptions : null
  }

  private stateFor(sender: AppDocument): SenderState {
    const existing = this.senders.get(sender.id)
    if (existing?.sender === sender) {
      return existing
    }
    if (existing) {
      this.retire(existing, true)
    }
    const state: SenderState = {
      connectionId: this.mintConnectionId(sender.id),
      sender,
      subscriptions: new Map()
    }
    this.senders.set(sender.id, state)
    const retireDocument = (): void => this.retire(state, true)
    sender.on('did-navigate', retireDocument)
    sender.on('render-process-gone', retireDocument)
    sender.once('destroyed', () => this.retire(state, true))
    return state
  }

  private retire(state: SenderState, destroyed: boolean): void {
    if (this.senders.get(state.sender.id) !== state) {
      return
    }
    const retiredConnectionId = state.connectionId
    if (destroyed) {
      this.senders.delete(state.sender.id)
    } else {
      state.connectionId = this.mintConnectionId(state.sender.id)
    }
    for (const controller of state.subscriptions.values()) {
      controller.abort()
    }
    state.subscriptions.clear()
    this.runtime.cleanupSubscriptionsForConnection(retiredConnectionId)
  }

  private mintConnectionId(senderId: number): string {
    return `desktop-renderer:${senderId}:${this.nextConnectionGeneration++}`
  }
}
