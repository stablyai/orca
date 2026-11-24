import { codexCommandOutlivesTurn } from './codex-command-lifecycle'
import {
  MAX_CODEX_ITEM_STREAM_ITEM_BYTES,
  MAX_CODEX_ITEM_STREAM_STATES
} from './codex-structured-item-stream-bounds'
import type { CodexItemStreamState } from './codex-structured-item-stream-contracts'

// Bounds only evictable streams; a command that outlives its turn is kept until it ends.
const MAX_EVICTABLE_STATE_BYTES = MAX_CODEX_ITEM_STREAM_STATES * MAX_CODEX_ITEM_STREAM_ITEM_BYTES

type RetainedState = { state: CodexItemStreamState; bytes: number; persistent: boolean }

export class CodexItemStreamRetention {
  private readonly states = new Map<string, RetainedState>()
  private evictableBytes = 0
  private persistentCount = 0

  get persistentSize(): number {
    return this.persistentCount
  }

  get overCapacity(): boolean {
    return (
      this.evictableBytes > MAX_EVICTABLE_STATE_BYTES ||
      this.states.size - this.persistentCount > MAX_CODEX_ITEM_STREAM_STATES
    )
  }

  get(key: string): CodexItemStreamState | undefined {
    return this.states.get(key)?.state
  }

  isPersistent(key: string): boolean {
    return this.states.get(key)?.persistent === true
  }

  retain(key: string, state: CodexItemStreamState): void {
    this.forget(key)
    const bytes = this.stateBytes(key, state)
    const persistent = codexCommandOutlivesTurn(state.item)
    this.states.set(key, { state, bytes, persistent })
    if (persistent) {
      this.persistentCount += 1
    } else {
      this.evictableBytes += bytes
    }
  }

  oldestEvictable(): string | undefined {
    for (const [key, entry] of this.states) {
      if (!entry.persistent) {
        return key
      }
    }
    return undefined
  }

  forget(key: string): void {
    const entry = this.states.get(key)
    if (!entry) {
      return
    }
    if (entry.persistent) {
      this.persistentCount -= 1
    } else {
      this.evictableBytes -= entry.bytes
    }
    this.states.delete(key)
  }

  clear(): void {
    this.states.clear()
    this.evictableBytes = 0
    this.persistentCount = 0
  }

  private stateBytes(key: string, state: CodexItemStreamState): number {
    return Buffer.byteLength(key, 'utf8') + Buffer.byteLength(JSON.stringify(state), 'utf8') + 256
  }
}
