import { withTimeout } from '../../../../src/shared/promise-timeout-fallback'
import { BRIDGE_MEDIA_MAX_LIVE_HANDLES, mediaReleaseParamsSchema } from './bridge-media-verbs'
import type { BridgeRpcClient } from './bridge-rpc-client'

const RETRY_BUDGET_MS = 250

type ReleaseDeps = {
  sessionId: () => string | null
  release: (handle: string) => Promise<boolean>
}

// Retry only idempotent cleanup; never replay selection or release handles still being read.
export class NativeMediaReleaseQueue {
  private readonly pending = new Set<string>()
  private sessionId: string | null = null
  private generation = 0
  private retrying: Promise<void> | null = null

  constructor(private readonly deps: ReleaseDeps) {}

  private syncSession(): number {
    const current = this.deps.sessionId()
    if (current !== this.sessionId) {
      this.pending.clear()
      this.retrying = null
      this.sessionId = current
      this.generation += 1
    }
    return this.generation
  }

  async release(handle: string): Promise<boolean> {
    const generation = this.syncSession()
    try {
      const released = await this.deps.release(handle)
      if (this.syncSession() === generation) {
        this.pending.delete(handle)
      }
      return released
    } catch (error) {
      if (
        this.syncSession() === generation &&
        this.sessionId !== null &&
        this.pending.size < BRIDGE_MEDIA_MAX_LIVE_HANDLES &&
        mediaReleaseParamsSchema.safeParse({ handle }).success
      ) {
        this.pending.add(handle)
      }
      throw error
    }
  }

  async retry(): Promise<void> {
    const generation = this.syncSession()
    if (this.retrying === null) {
      const retry = withTimeout(
        this.retryPending(generation).finally(() => {
          if (this.retrying === retry) {
            this.retrying = null
          }
        }),
        RETRY_BUDGET_MS,
        undefined
      )
      this.retrying = retry
    }
    await this.retrying
  }

  private async retryPending(generation: number): Promise<void> {
    const deadline = Date.now() + RETRY_BUDGET_MS
    // Snapshot before awaiting so concurrent failures wait for the next bounded pass.
    const handles = [...this.pending]
    for (const handle of handles) {
      if (this.syncSession() !== generation || Date.now() >= deadline) {
        return
      }
      try {
        await this.release(handle)
      } catch {
        // Leave failed cleanup for the next explicit selection attempt.
      }
    }
  }
}

const queues = new WeakMap<BridgeRpcClient, NativeMediaReleaseQueue>()

// Picker and clipboard hooks share ownership across remounts of the same page client.
export function nativeMediaReleaseQueueFor(
  client: BridgeRpcClient,
  release: ReleaseDeps['release']
): NativeMediaReleaseQueue {
  const existing = queues.get(client)
  if (existing !== undefined) {
    return existing
  }
  const queue = new NativeMediaReleaseQueue({
    sessionId: () => client.getShellSession()?.sessionId ?? null,
    release
  })
  queues.set(client, queue)
  return queue
}
