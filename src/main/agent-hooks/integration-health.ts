import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

export type IntegrationArtifactHealth = 'missing' | 'current' | 'stale' | 'unknown'
export type IntegrationLoaderHealth = 'supported' | 'loaded' | 'rejected' | 'unknown'
export type IntegrationDeliveryHealth = 'observed' | 'failed' | 'unobserved' | 'unknown'

export type IntegrationHealthRecord = {
  integration: string
  host: string
  scope: string
  artifact: IntegrationArtifactHealth
  loader: IntegrationLoaderHealth
  delivery: IntegrationDeliveryHealth
  artifactId?: string
  executionId?: string
  digest?: string
  byteLength?: number
  version?: string
  updatedAt: number
  expiresAt: number
}

export type IntegrationHealthStoreOptions = {
  filePath: string
  now?: () => number
  ttlMs?: number
  maxRecords?: number
}

export function readIntegrationHealthMetadata(value: unknown): {
  version?: unknown
  artifactId?: unknown
} {
  if (typeof value !== 'object' || value === null) {
    return {}
  }
  const fields = new Map(Object.entries(value))
  return { version: fields.get('version'), artifactId: fields.get('artifactId') }
}

type PersistedHealth = { version: 1; records: IntegrationHealthRecord[] }

function isPersistedHealth(value: unknown): value is PersistedHealth {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only reads optional discriminator fields after object/null guard.
  const candidate = value as { version?: unknown; records?: unknown }
  return candidate.version === 1 && Array.isArray(candidate.records)
}

/** Durable diagnostics for adapter artifacts; this is not agent status authority. */
export class IntegrationHealthStore {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxRecords: number
  private readonly records = new Map<string, IntegrationHealthRecord>()
  private loaded = false

  constructor(private readonly options: IntegrationHealthStoreOptions) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000
    this.maxRecords = options.maxRecords ?? 256
  }

  private key(
    record: Pick<
      IntegrationHealthRecord,
      'integration' | 'host' | 'scope' | 'artifactId' | 'version' | 'executionId'
    >
  ): string {
    return `${record.integration}\u0000${record.host}\u0000${record.scope}\u0000${record.artifactId ?? ''}\u0000${record.version ?? ''}\u0000${record.executionId ?? ''}`
  }

  private readPersistedRecords(): IntegrationHealthRecord[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.options.filePath, 'utf8'))
      return isPersistedHealth(parsed) ? parsed.records : []
    } catch {
      return []
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return
    }
    this.loaded = true
    const now = this.now()
    for (const record of this.readPersistedRecords()) {
      if (
        !record ||
        typeof record !== 'object' ||
        typeof record.expiresAt !== 'number' ||
        record.expiresAt <= now
      ) {
        continue
      }
      this.records.set(this.key(record), record)
    }
  }

  private acquireLock(): number | null {
    const lockPath = `${this.options.filePath}.lock`
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return openSync(lockPath, 'wx')
      } catch (error) {
        const code =
          error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (code !== 'EEXIST') {
          return null
        }
        // Bounded wait: diagnostics must never spin or block a launch forever.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
    }
    return null
  }

  private persist(): void {
    mkdirSync(dirname(this.options.filePath), { recursive: true })
    const lock = this.acquireLock()
    if (lock === null) {
      return
    }
    const tmp = join(dirname(this.options.filePath), `.${randomUUID()}.tmp`)
    try {
      const now = this.now()
      const merged = new Map<string, IntegrationHealthRecord>()
      for (const record of this.readPersistedRecords()) {
        if (record.expiresAt > now) {
          merged.set(this.key(record), record)
        }
      }
      for (const record of this.records.values()) {
        const previous = merged.get(this.key(record))
        if (!previous || previous.updatedAt <= record.updatedAt) {
          merged.set(this.key(record), record)
        }
      }
      // Apply the bound after merging disk state.  A store may have loaded an
      // older snapshot before another writer persisted; bounding only the
      // in-memory map would let the merge resurrect evicted records.
      const bounded = [...merged.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
        .slice(-this.maxRecords)
      this.records.clear()
      for (const [key, record] of bounded) {
        this.records.set(key, record)
      }
      writeFileSync(
        tmp,
        `${JSON.stringify({ version: 1, records: [...this.records.values()] } satisfies PersistedHealth)}\n`
      )
      renameSync(tmp, this.options.filePath)
    } finally {
      if (existsSync(tmp)) {
        try {
          unlinkSync(tmp)
        } catch {
          // Best effort.
        }
      }
      try {
        closeSync(lock)
        unlinkSync(`${this.options.filePath}.lock`)
      } catch {
        // Best effort cleanup; a stale lock is bounded by the next writer's attempts.
      }
    }
  }

  record(
    record: Omit<IntegrationHealthRecord, 'updatedAt' | 'expiresAt'>
  ): IntegrationHealthRecord {
    this.ensureLoaded()
    const now = this.now()
    const next: IntegrationHealthRecord = { ...record, updatedAt: now, expiresAt: now + this.ttlMs }
    this.records.set(this.key(next), next)
    while (this.records.size > this.maxRecords) {
      const oldest = [...this.records.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]
      if (!oldest) {
        break
      }
      this.records.delete(oldest[0])
    }
    try {
      this.persist()
    } catch {
      // Diagnostics are best effort.
    }
    return next
  }

  recordArtifact(input: {
    integration: string
    host: string
    scope: string
    bytes?: string | Uint8Array
    version?: string
    artifactId?: string
    executionId?: string
    loader?: IntegrationLoaderHealth
    delivery?: IntegrationDeliveryHealth
  }): IntegrationHealthRecord {
    const bytes =
      input.bytes === undefined
        ? undefined
        : typeof input.bytes === 'string'
          ? Buffer.from(input.bytes)
          : Buffer.from(input.bytes)
    const record: Omit<IntegrationHealthRecord, 'updatedAt' | 'expiresAt'> = {
      integration: input.integration,
      host: input.host,
      scope: input.scope,
      artifact: bytes === undefined ? 'unknown' : 'current',
      loader: input.loader ?? 'unknown',
      delivery: input.delivery ?? 'unobserved',
      version: input.version,
      executionId: input.executionId
    }
    if (bytes !== undefined) {
      const digest = createHash('sha256').update(bytes).digest('hex')
      Object.assign(record, {
        artifactId:
          input.artifactId ??
          `${input.integration}:${input.scope}:${input.version ?? 'unknown'}:${digest}`,
        digest,
        byteLength: bytes.byteLength
      })
    }
    this.ensureLoaded()
    for (const [key, previous] of this.records) {
      if (
        previous.integration === record.integration &&
        previous.host === record.host &&
        previous.scope === record.scope &&
        this.key(previous) !== this.key(record)
      ) {
        this.records.set(key, { ...previous, artifact: 'stale' })
      }
    }
    return this.record(record)
  }

  get(integration: string, host: string, scope: string): IntegrationHealthRecord | undefined {
    this.ensureLoaded()
    let latest: IntegrationHealthRecord | undefined
    for (const [key, record] of this.records) {
      if (record.integration !== integration || record.host !== host || record.scope !== scope) {
        continue
      }
      if (record.expiresAt <= this.now()) {
        this.records.delete(key)
        continue
      }
      if (!latest || record.updatedAt > latest.updatedAt) {
        latest = record
      }
    }
    return latest
  }

  /** Record loader/delivery evidence emitted by the host receiver itself.
   *  A receipt is independent of the artifact file and therefore never turns
   *  a missing artifact into a loaded one. */
  recordDeliveryEvidence(input: {
    integration: string
    host: string
    scope: string
    artifactId?: string
    version?: string
    executionId?: string
    loader: IntegrationLoaderHealth
    delivery: IntegrationDeliveryHealth
  }): IntegrationHealthRecord {
    return this.record({
      integration: input.integration,
      host: input.host,
      scope: input.scope,
      artifact: 'unknown',
      loader: input.loader,
      delivery: input.delivery,
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      ...(input.version ? { version: input.version } : {}),
      ...(input.executionId ? { executionId: input.executionId } : {})
    })
  }

  markArtifactStale(
    integration: string,
    host: string,
    scope: string
  ): IntegrationHealthRecord | undefined {
    const current = this.get(integration, host, scope)
    if (!current) {
      return undefined
    }
    return this.record({ ...current, artifact: 'stale' })
  }

  snapshot(): readonly IntegrationHealthRecord[] {
    this.ensureLoaded()
    const now = this.now()
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(key)
      }
    }
    return [...this.records.values()]
  }
}

export function createIntegrationHealthStore(filePath: string): IntegrationHealthStore {
  return new IntegrationHealthStore({ filePath })
}
