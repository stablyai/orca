// Fences an agent's chat starts on this host off while its shared sign-in or installed runtime is
// replaced or removed: a chat running meanwhile could save the old account back or run deleted files.
// In memory only; a restart ends it.

import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ProviderAcquisitionConnection } from '../provider-process/provider-acquisition-starts'

export class AcpLaunchGate {
  private operating = false
  private readonly starts = new Map<AbortController, Promise<void>>()
  private readonly retained = new Set<ProviderAcquisitionConnection>()
  private readonly refusal: string

  constructor(private readonly label: string) {
    this.refusal = `${label}'s setup is changing on this host. Try again after it finishes.`
  }

  /** A start's way in: refused while an operation runs; an operation that begins aborts it. */
  enter(signal: AbortSignal | undefined): { signal: AbortSignal; leave: () => void } {
    if (this.operating) {
      throw new AgentSessionPreSpawnError(new Error(this.refusal), {
        reason: 'accountSwitchInProgress'
      })
    }
    const controller = new AbortController()
    const left = Promise.withResolvers<void>()
    this.starts.set(controller, left.promise)
    return {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      leave: () => {
        this.starts.delete(controller)
        left.resolve()
      }
    }
  }

  /** Held from spawn until the child exits: a start that left the gate still runs until its chat is
   *  loaded, so an operation proves every such child gone, not only the loaded chats. */
  retain(connection: ProviderAcquisitionConnection): void {
    this.retained.add(connection)
    connection.onExit(() => this.retained.delete(connection))
  }

  /** `work`, once the starts under way have ended, `stopLive` has stopped the running chats and
   *  every retained child is proven gone; otherwise it rejects without running `work`. */
  async run<T>(stopLive: () => Promise<void>, work: () => Promise<T>): Promise<T> {
    if (this.operating) {
      throw new Error(this.refusal)
    }
    this.operating = true
    try {
      const starts = [...this.starts]
      starts.forEach(([controller]) => controller.abort())
      await Promise.all(starts.map(([, left]) => left))
      await stopLive()
      await this.stopRetained()
      return await work()
    } finally {
      this.operating = false
    }
  }

  private async stopRetained(): Promise<void> {
    const owners = [...this.retained]
    const closes = await Promise.allSettled(owners.map((owner) => owner.close()))
    closes.forEach((close, index) => {
      const result = close.status === 'fulfilled' ? close.value : false
      if (typeof result === 'boolean' ? result : result.root === 'exited') {
        this.retained.delete(owners[index])
      }
    })
    if (this.retained.size > 0) {
      throw new Error(`${this.label} could not be stopped on this host. Try again.`)
    }
  }
}
