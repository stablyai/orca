import { ClaudeImportResourceError } from './journal-claude-import-resource-error'

export const CLAUDE_IMPORT_INDEX_BYTES = 192 * 1024 * 1024

export const SLAB_ROWS = 4096
const KEY_SLAB_BYTES = 64 * 1024

export class IndexBudget {
  private bytes = 0

  reserve(bytes: number): void {
    if (this.bytes + bytes > CLAUDE_IMPORT_INDEX_BYTES) {
      throw new ClaudeImportResourceError('Claude history exceeds the import index budget.')
    }
    this.bytes += bytes
  }

  release(bytes: number): void {
    this.bytes -= bytes
  }
}

function releaseStorage(buffer: ArrayBuffer, budget: IndexBudget): void {
  const bytes = buffer.byteLength
  buffer.transfer(0)
  budget.release(bytes)
}

export class Table {
  private readonly slabs: (Uint32Array<ArrayBuffer> | Float64Array<ArrayBuffer>)[] = []
  length = 0

  constructor(
    private readonly columns: number,
    private readonly budget: IndexBudget,
    private readonly Storage: Uint32ArrayConstructor | Float64ArrayConstructor = Uint32Array
  ) {}

  append(...values: number[]): number {
    const row = ++this.length
    const index = (row - 1) % SLAB_ROWS
    if (index === 0) {
      const length = this.columns * SLAB_ROWS
      this.budget.reserve(length * this.Storage.BYTES_PER_ELEMENT)
      this.slabs.push(new this.Storage(length))
    }
    this.slabs.at(-1)!.set(values, index * this.columns)
    return row
  }

  get(row: number, column: number): number {
    return row === 0
      ? 0
      : this.slabs[Math.floor((row - 1) / SLAB_ROWS)][
          ((row - 1) % SLAB_ROWS) * this.columns + column
        ]
  }

  set(row: number, column: number, value: number): void {
    this.slabs[Math.floor((row - 1) / SLAB_ROWS)][((row - 1) % SLAB_ROWS) * this.columns + column] =
      value
  }

  dispose(): void {
    for (const slab of this.slabs) {
      releaseStorage(slab.buffer, this.budget)
    }
    this.slabs.length = 0
    this.length = 0
  }
}

export const enum Key {
  Slab,
  Offset,
  Length,
  Hash,
  LatestRow,
  FirstRow,
  Child,
  Group,
  Sibling,
  DirectResult,
  CrossResult,
  ResultStamp,
  Owner,
  Covered,
  Width
}

export class Keys {
  readonly table: Table
  private readonly slabs: Buffer<ArrayBuffer>[] = []
  private offset = 0
  private slots = new Uint32Array()

  constructor(private readonly budget: IndexBudget) {
    this.table = new Table(Key.Width, budget)
  }

  intern(value: unknown): number {
    if (typeof value !== 'string' || !value) {
      return 0
    }
    // JSON escaping keeps lone surrogates distinct from the replacement character.
    const bytes = value.isWellFormed()
      ? Buffer.from(value)
      : Buffer.concat([Buffer.from([255]), Buffer.from(JSON.stringify(value))])
    let hash = 2166136261
    for (let index = 0; index < bytes.length; index++) {
      hash = Math.imul(hash ^ bytes[index], 16777619)
    }
    hash >>>= 0
    const slotMask = this.slots.length - 1
    let slot = hash & slotMask
    for (let key = this.slots[slot]; key; key = this.slots[slot]) {
      if (
        this.table.get(key, Key.Hash) === hash &&
        this.table.get(key, Key.Length) === bytes.length
      ) {
        const start = this.table.get(key, Key.Offset)
        const slab = this.slabs[this.table.get(key, Key.Slab)]
        if (slab.compare(bytes, 0, bytes.length, start, start + bytes.length) === 0) {
          return key
        }
      }
      slot = (slot + 1) & slotMask
    }
    if (this.table.length * 4 >= this.slots.length * 3) {
      this.grow()
      const mask = this.slots.length - 1
      slot = hash & mask
      while (this.slots[slot]) {
        slot = (slot + 1) & mask
      }
    }
    if (bytes.length > KEY_SLAB_BYTES) {
      this.budget.reserve(bytes.length)
      const slab = Buffer.allocUnsafeSlow(bytes.length)
      bytes.copy(slab)
      this.slabs.push(slab)
      const key = this.table.append(this.slabs.length - 1, 0, slab.length, hash)
      this.offset = bytes.length
      this.slots[slot] = key
      return key
    }
    if (!this.slabs.length || this.offset + bytes.length > this.slabs.at(-1)!.length) {
      this.budget.reserve(KEY_SLAB_BYTES)
      this.slabs.push(Buffer.allocUnsafeSlow(KEY_SLAB_BYTES))
      this.offset = 0
    }
    bytes.copy(this.slabs.at(-1)!, this.offset)
    const key = this.table.append(this.slabs.length - 1, this.offset, bytes.length, hash)
    this.offset += bytes.length
    this.slots[slot] = key
    return key
  }

  private grow(): void {
    const nextLength = this.slots.length ? this.slots.length * 2 : SLAB_ROWS
    this.budget.reserve(nextLength * Uint32Array.BYTES_PER_ELEMENT)
    const next = new Uint32Array(nextLength)
    const mask = nextLength - 1
    for (let key = 1; key <= this.table.length; key++) {
      let slot = this.table.get(key, Key.Hash) & mask
      while (next[slot]) {
        slot = (slot + 1) & mask
      }
      next[slot] = key
    }
    releaseStorage(this.slots.buffer, this.budget)
    this.slots = next
  }

  dispose(): void {
    for (const slab of this.slabs) {
      releaseStorage(slab.buffer, this.budget)
    }
    this.slabs.length = 0
    this.offset = 0
    releaseStorage(this.slots.buffer, this.budget)
    this.slots = new Uint32Array()
    this.table.dispose()
  }
}

export const enum Position {
  Offset,
  LegacyOffset,
  Line,
  Width
}
export const enum RangeData {
  Length,
  Digest,
  Width
}
export const enum Flag {
  Decode = 1,
  Turn = 2,
  Leaf = 4,
  Meta = 16,
  Selected = 32,
  HasChild = 64,
  HasLeafChild = 128,
  Exhausted = 256,
  ToolResult = 512,
  QueuedPrompt = 1024,
  UnselectedTurnPath = 2048,
  TrailingReachable = 4096,
  TrailingVisited = 8192,
  CompactBoundary = 16384,
  CompactSummary = 32768
}
export const enum Link {
  Key,
  Next,
  Width
}
