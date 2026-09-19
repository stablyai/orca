import { randomBytes } from 'node:crypto'
import type { PtyProcessInfo } from './pty-process-info'
import type { RelayPtyOwnershipTransferSource } from '../../relay/relay-pty-ownership-transfer-adapter'

export const RUNTIME_PTY_SOURCE_AUTHORITY_RECORD_VERSION = 1 as const
export const MAX_RUNTIME_PTY_SOURCE_AUTHORITIES = 512

export type RuntimePtySourceAuthorityRecord = RelayPtyOwnershipTransferSource &
  Readonly<{ version: typeof RUNTIME_PTY_SOURCE_AUTHORITY_RECORD_VERSION }>

export type RuntimePtySourceAuthorityStore = Readonly<{
  loadAll: () => readonly unknown[]
  replaceAll: (records: readonly RuntimePtySourceAuthorityRecord[]) => void
}>

type RuntimePtySourceAuthorityRegistryOptions = Readonly<{
  store: RuntimePtySourceAuthorityStore
  maxRecords?: number
  mintOwnerLease?: () => string
}>

/** Durable identity for host-local PTYs; liveness always comes from the current provider. */
export class RuntimePtySourceAuthorityRegistry {
  private readonly records = new Map<string, RuntimePtySourceAuthorityRecord>()
  private readonly activeIncarnations = new Map<string, string>()
  private readonly maxRecords: number
  private readonly mintOwnerLease: () => string

  constructor(private readonly options: RuntimePtySourceAuthorityRegistryOptions) {
    this.maxRecords = boundedRecordCapacity(options.maxRecords)
    this.mintOwnerLease = options.mintOwnerLease ?? mintOwnerLease
    const loaded = options.store.loadAll()
    if (loaded.length > this.maxRecords) {
      throw invalidRegistry()
    }
    for (const value of loaded) {
      const record = parseRecord(value)
      if (this.records.has(record.terminalId)) {
        throw invalidRegistry()
      }
      this.records.set(record.terminalId, record)
    }
  }

  /** A durable record alone never proves that its process is live in this provider generation. */
  resolve(terminalId: string): RelayPtyOwnershipTransferSource | null {
    const record = this.records.get(terminalId)
    return record && this.activeIncarnations.get(terminalId) === record.incarnationId
      ? record
      : null
  }

  deactivateAll(): void {
    this.activeIncarnations.clear()
  }

  admit(terminalId: string, incarnationId: string): RuntimePtySourceAuthorityRecord {
    assertIdentityPart(terminalId)
    assertIdentityPart(incarnationId)
    const current = this.records.get(terminalId)
    if (current?.incarnationId === incarnationId) {
      this.activeIncarnations.set(terminalId, incarnationId)
      return current
    }
    if (!current && this.records.size >= this.maxRecords) {
      throw new Error('runtime_pty_source_authority_capacity_exceeded')
    }
    const sourceOwnerGeneration = current ? current.sourceOwnerGeneration + 1 : 1
    if (!Number.isSafeInteger(sourceOwnerGeneration)) {
      throw invalidRegistry()
    }
    const ownerLease = this.mintOwnerLease()
    assertIdentityPart(ownerLease)
    const next = Object.freeze({
      version: RUNTIME_PTY_SOURCE_AUTHORITY_RECORD_VERSION,
      terminalId,
      incarnationId,
      ownerLease,
      sourceOwnerGeneration
    })
    const records = new Map(this.records).set(terminalId, next)
    this.persistAndReplace(records)
    this.activeIncarnations.set(terminalId, incarnationId)
    return next
  }

  retire(terminalId: string, incarnationId: string): boolean {
    if (this.activeIncarnations.get(terminalId) !== incarnationId) {
      return false
    }
    this.activeIncarnations.delete(terminalId)
    const record = this.records.get(terminalId)
    if (record?.incarnationId !== incarnationId) {
      return false
    }
    const records = new Map(this.records)
    records.delete(terminalId)
    this.persistAndReplace(records)
    return true
  }

  /** Replaces active authority only after one complete, unambiguous provider inventory. */
  reconcile(processes: readonly PtyProcessInfo[]): readonly RuntimePtySourceAuthorityRecord[] {
    const identities = new Map<string, string | null>()
    for (const process of processes) {
      assertIdentityPart(process.id)
      if (identities.has(process.id)) {
        throw new Error('runtime_pty_source_authority_inventory_ambiguous')
      }
      identities.set(process.id, process.incarnationId ?? null)
    }

    const records = new Map([...this.records].filter(([terminalId]) => identities.has(terminalId)))
    const admitted: RuntimePtySourceAuthorityRecord[] = []
    for (const [terminalId, incarnationId] of identities) {
      if (incarnationId) {
        const record = this.ensureRecord(records, terminalId, incarnationId)
        records.set(terminalId, record)
        admitted.push(record)
      }
    }
    if (records.size > this.maxRecords) {
      throw new Error('runtime_pty_source_authority_capacity_exceeded')
    }
    this.options.store.replaceAll([...records.values()])
    this.replaceRecords(records)
    this.activeIncarnations.clear()
    for (const record of admitted) {
      this.activeIncarnations.set(record.terminalId, record.incarnationId)
    }
    return Object.freeze(admitted)
  }

  private ensureRecord(
    records: ReadonlyMap<string, RuntimePtySourceAuthorityRecord>,
    terminalId: string,
    incarnationId: string
  ): RuntimePtySourceAuthorityRecord {
    const current = records.get(terminalId)
    if (current?.incarnationId === incarnationId) {
      return current
    }
    const sourceOwnerGeneration = current ? current.sourceOwnerGeneration + 1 : 1
    if (!Number.isSafeInteger(sourceOwnerGeneration)) {
      throw invalidRegistry()
    }
    const ownerLease = this.mintOwnerLease()
    assertIdentityPart(ownerLease)
    const next = Object.freeze({
      version: RUNTIME_PTY_SOURCE_AUTHORITY_RECORD_VERSION,
      terminalId,
      incarnationId,
      ownerLease,
      sourceOwnerGeneration
    })
    return next
  }

  private persistAndReplace(records: Map<string, RuntimePtySourceAuthorityRecord>): void {
    this.options.store.replaceAll([...records.values()])
    this.replaceRecords(records)
  }

  private replaceRecords(records: ReadonlyMap<string, RuntimePtySourceAuthorityRecord>): void {
    this.records.clear()
    for (const [terminalId, record] of records) {
      this.records.set(terminalId, record)
    }
  }
}

function parseRecord(value: unknown): RuntimePtySourceAuthorityRecord {
  if (!value || typeof value !== 'object') {
    throw invalidRegistry()
  }
  const record = value as Partial<RuntimePtySourceAuthorityRecord>
  if (
    record.version !== RUNTIME_PTY_SOURCE_AUTHORITY_RECORD_VERSION ||
    typeof record.terminalId !== 'string' ||
    typeof record.incarnationId !== 'string' ||
    typeof record.ownerLease !== 'string' ||
    !Number.isSafeInteger(record.sourceOwnerGeneration) ||
    record.sourceOwnerGeneration! <= 0
  ) {
    throw invalidRegistry()
  }
  assertIdentityPart(record.terminalId)
  assertIdentityPart(record.incarnationId)
  assertIdentityPart(record.ownerLease)
  return Object.freeze({
    version: RUNTIME_PTY_SOURCE_AUTHORITY_RECORD_VERSION,
    terminalId: record.terminalId,
    incarnationId: record.incarnationId,
    ownerLease: record.ownerLease,
    sourceOwnerGeneration: record.sourceOwnerGeneration!
  })
}

function assertIdentityPart(value: string): void {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 4_096) {
    throw invalidRegistry()
  }
}

function boundedRecordCapacity(value = MAX_RUNTIME_PTY_SOURCE_AUTHORITIES): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_RUNTIME_PTY_SOURCE_AUTHORITIES) {
    throw invalidRegistry()
  }
  return value
}

function mintOwnerLease(): string {
  return randomBytes(32).toString('base64url')
}

function invalidRegistry(): Error {
  return new Error('runtime_pty_source_authority_registry_invalid')
}
