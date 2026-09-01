import {
  boundPayload,
  digestPayload
} from '../native-chat/agent-session-journal/journal-payload-bounds'

/** Maximum forgotten turn keys retained for late-frame reconciliation. */
export const MAX_CODEX_TURN_ORDINAL_ENTRIES = 256
export const MAX_CODEX_TURN_ORDINAL_BYTES = 512 * 1024

/** Assigns stable message ordinals while retaining a bounded late-frame window. */
export class CodexTurnOrdinals {
  private readonly turns = new Map<
    string,
    { assigned: Map<string, number>; next: number; active: boolean }
  >()
  private retainedBytes = 0

  get forgottenTurnCount(): number {
    let count = 0
    for (const turn of this.turns.values()) {
      if (!turn.active) {
        count += 1
      }
    }
    return count
  }

  get bytes(): number {
    return this.retainedBytes
  }

  private keyPart(value: string): string {
    const encoded = encodeURIComponent(value)
    if (Buffer.byteLength(encoded, 'utf8') <= 256) {
      return encoded
    }
    const suffix = `#${digestPayload(value).slice(0, 24)}`
    return `${
      boundPayload(encoded, {
        inlineHeadBytes: 256 - Buffer.byteLength(suffix, 'utf8'),
        maxSessionBytes: Number.MAX_SAFE_INTEGER,
        maxAppendsPerWindow: Number.MAX_SAFE_INTEGER,
        appendWindowMs: Number.MAX_SAFE_INTEGER
      }).head
    }${suffix}`
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${this.keyPart(threadId)}:${this.keyPart(turnId)}`
  }

  private trimForgotten(): void {
    while (this.forgottenTurnCount > MAX_CODEX_TURN_ORDINAL_ENTRIES) {
      const oldest = [...this.turns.entries()].find(([, turn]) => !turn.active)?.[0]
      if (!oldest) {
        break
      }
      const removed = this.turns.get(oldest)
      this.turns.delete(oldest)
      if (removed) {
        this.retainedBytes = Math.max(
          0,
          this.retainedBytes -
            Buffer.byteLength(oldest, 'utf8') -
            [...removed.assigned.keys()].reduce((n, key) => n + Buffer.byteLength(key, 'utf8'), 0)
        )
      }
    }
  }

  private trimBytes(currentTurnKey: string): void {
    this.trimForgotten()
    while (this.retainedBytes > MAX_CODEX_TURN_ORDINAL_BYTES) {
      const forgotten = [...this.turns.entries()].find(([, turn]) => !turn.active)?.[0]
      const oldest = forgotten ?? this.turns.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      const turn = this.turns.get(oldest)
      if (oldest === currentTurnKey && this.turns.size === 1 && turn) {
        const itemKey = turn.assigned.keys().next().value
        if (typeof itemKey !== 'string') {
          break
        }
        turn.assigned.delete(itemKey)
        this.retainedBytes = Math.max(
          Buffer.byteLength(currentTurnKey, 'utf8'),
          this.retainedBytes - Buffer.byteLength(itemKey, 'utf8')
        )
        continue
      }
      if (!turn) {
        break
      }
      this.turns.delete(oldest)
      this.retainedBytes = Math.max(
        0,
        this.retainedBytes -
          Buffer.byteLength(oldest, 'utf8') -
          [...turn.assigned.keys()].reduce((n, key) => n + Buffer.byteLength(key, 'utf8'), 0)
      )
    }
  }

  ordinalFor(threadId: string, turnId: string, codexItemId: string): number {
    const turnKey = this.turnKey(threadId, turnId)
    let turn = this.turns.get(turnKey)
    if (!turn) {
      turn = { assigned: new Map(), next: 0, active: true }
      this.turns.set(turnKey, turn)
      this.retainedBytes += Buffer.byteLength(turnKey, 'utf8')
    } else {
      if (!turn.active) {
        this.turns.delete(turnKey)
        this.turns.set(turnKey, turn)
      }
      turn.active = true
    }
    const itemKey = this.keyPart(codexItemId)
    const existing = turn.assigned.get(itemKey)
    if (existing !== undefined) {
      return existing
    }
    const ordinal = turn.next
    turn.assigned.set(itemKey, ordinal)
    this.retainedBytes += Buffer.byteLength(itemKey, 'utf8')
    turn.next += 1
    this.trimBytes(turnKey)
    return ordinal
  }

  forgetTurn(threadId: string, turnId: string): void {
    const turnKey = this.turnKey(threadId, turnId)
    const turn = this.turns.get(turnKey)
    if (turn) {
      const assignedBytes = [...turn.assigned.keys()].reduce(
        (n, key) => n + Buffer.byteLength(key, 'utf8'),
        0
      )
      turn.assigned = new Map()
      turn.active = false
      this.retainedBytes = Math.max(0, this.retainedBytes - assignedBytes)
      this.turns.delete(turnKey)
      this.turns.set(turnKey, turn)
      this.trimForgotten()
    }
  }
}
