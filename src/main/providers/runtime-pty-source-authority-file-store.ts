import { readFileSync, statSync } from 'node:fs'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  MAX_RUNTIME_PTY_SOURCE_AUTHORITIES,
  type RuntimePtySourceAuthorityRecord,
  type RuntimePtySourceAuthorityStore
} from './runtime-pty-source-authority-registry'

const FILE_VERSION = 1
const MAX_FILE_BYTES = 4 * 1024 * 1024

/** Single-writer, owner-private authority registry with atomic fsynced replacement. */
export class RuntimePtySourceAuthorityFileStore implements RuntimePtySourceAuthorityStore {
  private records: RuntimePtySourceAuthorityRecord[] | null = null

  constructor(private readonly path: string) {}

  loadAll(): readonly unknown[] {
    try {
      const stats = statSync(this.path)
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
        throw invalidStore()
      }
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as {
        version?: unknown
        records?: unknown
      }
      if (
        value.version !== FILE_VERSION ||
        !Array.isArray(value.records) ||
        value.records.length > MAX_RUNTIME_PTY_SOURCE_AUTHORITIES
      ) {
        throw invalidStore()
      }
      this.records = value.records as RuntimePtySourceAuthorityRecord[]
      return structuredClone(value.records)
    } catch (error) {
      if (isMissingFile(error)) {
        this.records = []
        return []
      }
      throw new Error('runtime_pty_source_authority_store_invalid', { cause: error })
    }
  }

  replaceAll(records: readonly RuntimePtySourceAuthorityRecord[]): void {
    if (records.length > MAX_RUNTIME_PTY_SOURCE_AUTHORITIES) {
      throw new Error('runtime_pty_source_authority_capacity_exceeded')
    }
    if (!this.records) {
      this.loadAll()
    }
    this.write([...records])
  }

  private write(records: RuntimePtySourceAuthorityRecord[]): void {
    writeDurableSecureJsonFile(this.path, { version: FILE_VERSION, records })
    this.records = records
  }
}

function invalidStore(): Error {
  return new Error('runtime_pty_source_authority_store_invalid')
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
