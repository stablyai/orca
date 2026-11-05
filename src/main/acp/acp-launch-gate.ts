// Fence chat starts during host account/runtime changes to prevent stale writes or deleted-file use.

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

  /** Refuses starts during an operation and aborts existing starts when one begins. */
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

  /** Retain spawned children even after acquisition finishes, before their chats are loaded. */
  retain(connection: ProviderAcquisitionConnection): void {
    this.retained.add(connection)
    connection.onExit(() => this.retained.delete(connection))
  }

  /** Stop starts, live chats and retained root processes before running setup changes. */
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
