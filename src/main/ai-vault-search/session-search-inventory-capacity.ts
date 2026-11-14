import { SessionSearchInventoryProjection } from './session-search-inventory-prefetch'
import {
  authorityEpochBytes,
  inventoryPageBytes,
  inventoryPageRows,
  inventoryMutationBytes,
  inventoryMutationFields,
  inventoryPhysicalReserve,
  inventoryValueBytes,
  type SessionSearchAuthorityPhase
} from './session-search-inventory-footprint'
export class SessionSearchInventoryCapacity {
  private readonly reserves = new Map<string, number>()
  private growth = new Map<string, number>()
  phase: SessionSearchAuthorityPhase | undefined
  private scalar = false
  private leaves = new Set<string>()
  private streamBytes = 0
  private streamWrite: string | undefined
  private readonly patchCharges = new Set<string>()

  private readonly charges = new Map<string, { bytes: number; rows: number }>()
  bytes = 1024
  rows = 0
  readonly projection = new SessionSearchInventoryProjection(this)
  get(key: string) {
    return this.charges.get(key)
  }
  fits(changes: [string, number, number][]): boolean {
    let bytes = this.bytes,
      rows = this.rows
    for (const [key, nextBytes, nextRows] of changes) {
      const old = this.charges.get(key)
      bytes += nextBytes - (old?.bytes ?? 0)
      rows += nextRows - (old?.rows ?? 0)
    }
    return bytes <= inventoryPageBytes && rows <= inventoryPageRows
  }
  set(key: string, bytes: number, rows = 1): void {
    const old = this.charges.get(key)
    this.bytes += bytes - (old?.bytes ?? 0)
    this.rows += rows - (old?.rows ?? 0)
    if (bytes || rows) {
      this.charges.set(key, { bytes, rows })
    } else {
      this.charges.delete(key)
    }
  }
  delete(key: string): void {
    this.set(key, 0, 0)
  }
  room() {
    return { rows: 256 - this.rows, bytes: 256 * 1024 - this.bytes }
  }
  private epochReserve = 0
  private epochRows = 0
  beginWorkingSet(
    growth: Map<string, number>,
    source: number,
    epochPaths: readonly string[],
    phase: SessionSearchAuthorityPhase,
    paths: readonly string[],
    scalar: boolean
  ): void {
    this.phase = phase
    this.scalar = scalar
    this.leaves = new Set(paths)
    this.streamBytes = Math.max(
      0,
      ...paths.flatMap((path) =>
        (['search_inventory_entries', 'search_inventory_activity'] as const).map((table) =>
          inventoryMutationBytes(
            table,
            source,
            path,
            growth.get(path) ?? 0,
            inventoryMutationFields(phase, table, true)
          )
        )
      )
    )
    this.set('stream-reserve', this.streamBytes, this.streamBytes ? 3 : 0)
    this.growth = growth
    this.set('working-inputs', inventoryValueBytes('growth', [...growth]), growth.size)
    this.epochReserve = epochPaths.reduce(
      (bytes, path) => bytes + authorityEpochBytes(source, path),
      0
    )
    this.epochRows = epochPaths.length * 3
    this.set('epoch-reserve', this.epochReserve, this.epochRows)
  }
  private reservation(key: string, writeBytes: number) {
    const reserved = this.reserves.get(key) ?? 0
    const factBytes = this.get(`fact:${key}`)?.bytes ?? 0
    return [
      Math.max(0, reserved - factBytes - writeBytes),
      reserved ? Math.max(0, 4 - Number(writeBytes > 0) * 3) : 0
    ] as const
  }
  retain(key: string, value: unknown, flush: () => void): boolean {
    if (
      key.startsWith('write:') &&
      this.phase &&
      !this.reserves.has(key.slice(6)) &&
      this.streamWrite &&
      this.streamWrite !== key
    ) {
      flush()
    }
    const patch = key.startsWith('write:') || key.startsWith('epoch:')
    const bytes = inventoryValueBytes(key, value) * (patch ? 3 : 1)
    const changes: [string, number, number][] = [[key, bytes, patch ? 3 : 1]]
    const physical = key.startsWith('fact:') ? key.slice(5) : undefined
    if (!patch && this.scalar) {
      this.delete(key)
      return false
    }
    if (physical && this.phase) {
      if (this.streamWrite === `write:${physical}`) {
        return false
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fact keys are retained only by typed physical projections and reads.
      const row = value as Record<string, unknown>
      const table = physical.startsWith('search_inventory_entries:')
        ? 'search_inventory_entries'
        : 'search_inventory_activity'
      const source = Number(physical.slice(table.length + 1).split(':', 1)[0])
      const path = physical.slice(table.length + 1 + String(source).length + 1)
      const names = inventoryMutationFields(this.phase, table, this.leaves.has(path))
      const extra = names.length
        ? inventoryPhysicalReserve(table, source, path, this.growth.get(path) ?? 0, names, row)
        : 0
      const reserved = extra ? (this.reserves.get(physical) ?? bytes + extra) : 0
      const write = this.get(`write:${physical}`)?.bytes ?? 0
      changes.push([
        `reserve:${physical}`,
        Math.max(0, reserved - bytes - write),
        reserved ? Math.max(0, 4 - Number(write > 0) * 3) : 0
      ])
      if (!this.fits(changes)) {
        this.delete(key)
        this.delete(`reserve:${physical}`)
        this.reserves.delete(physical)
        return false
      }
      if (reserved) {
        this.reserves.set(physical, reserved)
      }
    } else if (key.startsWith('epoch:')) {
      const current = this.get(key)?.bytes ?? 0
      const reserved = this.get('epoch-reserve')
      changes.push([
        'epoch-reserve',
        Math.max(0, (reserved?.bytes ?? 0) - bytes + current),
        Math.max(0, (reserved?.rows ?? 0) - 3 + Number(!!current) * 3)
      ])
    } else if (key.startsWith('write:') && this.phase && !this.reserves.has(key.slice(6))) {
      changes.push(['stream-reserve', 0, 0])
    } else if (key.startsWith('write:')) {
      const [reservedBytes, rows] = this.reservation(key.slice(6), bytes)
      changes.push([`reserve:${key.slice(6)}`, reservedBytes, rows])
    }
    if (!this.fits(changes)) {
      if (!patch && this.phase) {
        this.delete(key)
        return false
      }
      flush()
      if (!this.phase) {
        this.releaseFacts()
      }
      if (key.startsWith('write:') && this.phase && !this.reserves.has(key.slice(6))) {
        changes[1] = ['stream-reserve', 0, 0]
      } else if (key.startsWith('write:')) {
        const [reservedBytes, rows] = this.reservation(key.slice(6), bytes)
        changes[1] = [`reserve:${key.slice(6)}`, reservedBytes, rows]
      } else if (key.startsWith('epoch:')) {
        changes[1] = [
          'epoch-reserve',
          Math.max(0, this.epochReserve - bytes),
          Math.max(0, this.epochRows - 3)
        ]
      }
    }
    if (key.startsWith('write:') && this.phase && !this.reserves.has(key.slice(6))) {
      this.streamWrite = key
    }
    if (patch) {
      this.patchCharges.add(key)
    }
    for (const [at, size, rows] of changes) {
      this.set(at, size, rows)
    }
    return true
  }
  private readonly transients = new Set<string>()
  transient(key: string, value: unknown): void {
    const id = `transient:${key}`
    this.transients.add(id)
    this.set(id, Math.max(this.get(id)?.bytes ?? 0, inventoryValueBytes(key, value) * 3), 3)
  }
  releaseTransients(): void {
    for (const key of this.transients) {
      this.delete(key)
    }
    this.transients.clear()
  }
  flushedPhysical(): void {
    for (const [key, bytes] of this.reserves) {
      this.delete(`write:${key}`)
      this.set(`reserve:${key}`, Math.max(0, bytes - (this.get(`fact:${key}`)?.bytes ?? 0)), 4)
    }
    this.releasePatchCharges('write:')
    this.streamWrite = undefined
    this.set('stream-reserve', this.streamBytes, this.streamBytes ? 3 : 0)
  }
  private releasePatchCharges(prefix: string): void {
    for (const key of this.patchCharges) {
      if (key.startsWith(prefix)) {
        this.delete(key)
        this.patchCharges.delete(key)
      }
    }
  }
  flushedEpochs(): void {
    this.releasePatchCharges('epoch:')
    this.set('epoch-reserve', this.epochReserve, this.epochRows)
  }
  releaseFacts(): void {
    this.releaseTransients()
    this.phase = undefined
    this.scalar = false
    this.leaves.clear()
    this.streamBytes = 0
    this.streamWrite = undefined
    this.reserves.clear()
    this.growth.clear()
    this.epochReserve = 0
    this.epochRows = 0
    for (const key of this.charges.keys()) {
      if (!key.startsWith('write:') && !key.startsWith('epoch:') && key !== 'query') {
        this.delete(key)
      }
    }
  }
}
