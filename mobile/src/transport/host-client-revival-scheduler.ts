import type { RpcClient } from './rpc-client'
import { subscribeConnectionRevivalTriggers } from './connection-revival-triggers'

const REVIVAL_BATCH_SIZE = 32
const REVIVAL_BATCH_DELAY_MS = 25

type RevivalReason = 'app-resume' | 'network-change'

export class HostClientRevivalScheduler {
  private readonly pending = new Map<RpcClient, RevivalReason>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  schedule(clients: readonly RpcClient[], reason: RevivalReason): void {
    if (this.stopped) {
      return
    }
    for (const client of clients) {
      this.pending.set(client, reason)
    }
    if (!this.timer) {
      this.notifyNextBatch()
    }
  }

  stop(): void {
    this.stopped = true
    this.pending.clear()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private notifyNextBatch(): void {
    this.timer = null
    if (this.stopped) {
      return
    }
    const batch = [...this.pending].slice(0, REVIVAL_BATCH_SIZE)
    for (const [client, reason] of batch) {
      this.pending.delete(client)
      client.notifyForeground(reason)
    }
    if (this.pending.size > 0) {
      this.timer = setTimeout(() => this.notifyNextBatch(), REVIVAL_BATCH_DELAY_MS)
    }
  }
}

export function subscribeHostClientRevival(listClients: () => readonly RpcClient[]): () => void {
  const scheduler = new HostClientRevivalScheduler()
  const unsubscribe = subscribeConnectionRevivalTriggers((reason) => {
    scheduler.schedule(listClients(), reason)
  })
  return () => {
    scheduler.stop()
    unsubscribe()
  }
}
