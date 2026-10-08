import { codexCommandOutlivesTurn } from './codex-command-lifecycle'
import {
  MAX_CODEX_ITEM_STREAM_ITEM_BYTES,
  MAX_CODEX_ITEM_STREAM_STATES
} from './codex-structured-item-stream-bounds'
import type { CodexItemStreamState } from './codex-structured-item-stream-contracts'

// Preserve the previous metadata ceiling while letting small live commands share it.
export const MAX_CODEX_ITEM_STREAM_METADATA_BYTES =
  MAX_CODEX_ITEM_STREAM_STATES * MAX_CODEX_ITEM_STREAM_ITEM_BYTES

type RetainedState = { state: CodexItemStreamState; bytes: number; persistent: boolean }

export class CodexItemStreamRetention {
  private readonly states = new Map<string, RetainedState>()
  private bytes = 0
  private persistentBytes = 0
  private persistentCount = 0

  constructor(private readonly maxBytes = MAX_CODEX_ITEM_STREAM_METADATA_BYTES) {}

  get retainedBytes(): number {
    return this.bytes
  }

  get size(): number {
    return this.states.size
  }

  get persistentSize(): number {
    return this.persistentCount
  }

  get overCapacity(): boolean {
    return (
      this.bytes > this.maxBytes ||
      this.states.size - this.persistentCount > MAX_CODEX_ITEM_STREAM_STATES
    )
  }

  get(key: string): CodexItemStreamState | undefined {
    return this.states.get(key)?.state
  }

  isPersistent(key: string): boolean {
    return this.states.get(key)?.persistent === true
  }

  canRetain(key: string, state: CodexItemStreamState): boolean {
    const previous = this.states.get(key)
    return (
      this.persistentBytes -
        (previous?.persistent ? previous.bytes : 0) +
        this.stateBytes(key, state) <=
      this.maxBytes
    )
  }

  retain(key: string, state: CodexItemStreamState): boolean {
    if (!this.canRetain(key, state)) {
      return false
    }
    this.forget(key)
    const bytes = this.stateBytes(key, state)
    const persistent = codexCommandOutlivesTurn(state.item)
    this.states.set(key, { state, bytes, persistent })
    this.bytes += bytes
    if (persistent) {
      this.persistentBytes += bytes
      this.persistentCount += 1
    }
    return true
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
    this.bytes -= entry.bytes
    if (entry.persistent) {
      this.persistentBytes -= entry.bytes
      this.persistentCount -= 1
    }
    this.states.delete(key)
  }

  clear(): void {
    this.states.clear()
    this.bytes = 0
    this.persistentBytes = 0
    this.persistentCount = 0
  }

  private stateBytes(key: string, state: CodexItemStreamState): number {
    return Buffer.byteLength(key, 'utf8') + Buffer.byteLength(JSON.stringify(state), 'utf8') + 256
  }
}
