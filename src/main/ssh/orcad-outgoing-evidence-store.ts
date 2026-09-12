import { createHash } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'

const MAX_BYTES = 64 * 1024 * 1024

/** One profile writer; a persisted candidate does not prove source selection or destination publication. */
export class OrcadOutgoingEvidenceStore<T extends { identity: PtyOwnershipTransferWireIdentity }> {
  constructor(
    private readonly directory: string,
    private readonly parse: (value: unknown) => T,
    private readonly errorPrefix = 'orcad_outgoing_capture'
  ) {}

  private path(identity: PtyOwnershipTransferWireIdentity): string {
    const key = createHash('sha256').update(identity.bridgeId).digest('hex')
    return join(this.directory, `${key}.json`)
  }

  /** Discovery is all-or-error: unreadable evidence must not look like no pending transfer. */
  list(): T[] {
    const directory = this.directory
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) {
          throw new Error(`${this.errorPrefix}_filename_invalid`)
        }
        const path = join(directory, name)
        const record = this.readPath(path)
        if (this.path(record.identity) !== path) {
          throw new Error(`${this.errorPrefix}_filename_mismatch`)
        }
        return record
      })
  }

  private readPath(path: string): T {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      throw new Error(`${this.errorPrefix}_file_invalid`)
    }
    return this.parse(
      JSON.parse(readNodeFileSyncWithinLimit(path, MAX_BYTES).buffer.toString('utf8'))
    )
  }

  read(expected: PtyOwnershipTransferWireIdentity): T | null {
    const identity = parsePtyOwnershipTransferWireIdentity(expected)
    const path = this.path(identity)
    let record: T
    try {
      record = this.readPath(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
    if (!samePtyOwnershipTransferIdentity(record.identity, identity)) {
      throw new Error(`${this.errorPrefix}_identity_mismatch`)
    }
    return record
  }

  persist(value: unknown): T {
    const record = this.parse(value)
    const before = this.read(record.identity)
    const canonical = serializeOrcadMigrationValue(record)
    if (before && serializeOrcadMigrationValue(before) !== canonical) {
      throw new Error(`${this.errorPrefix}_conflict`)
    }
    if (Buffer.byteLength(JSON.stringify(record, null, 2), 'utf8') > MAX_BYTES) {
      throw new Error(`${this.errorPrefix}_too_large`)
    }
    // Reflush exact retries: readable bytes alone cannot acknowledge an earlier uncertain write.
    if (!writeDurableSecureJsonFile(this.path(record.identity), record)) {
      throw new Error(`${this.errorPrefix}_permissions_unconfirmed`)
    }
    const saved = this.read(record.identity)
    if (!saved || serializeOrcadMigrationValue(saved) !== canonical) {
      throw new Error(`${this.errorPrefix}_write_unconfirmed`)
    }
    return saved
  }
}
