import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../shared/node-bounded-file-reader'
import { writeDurableSecureJsonFile } from '../shared/secure-file'
import {
  parseRelayOwnerResetRequest,
  type RelayOwnerResetRequest
} from '../shared/relay-owner-reset-contract'
import {
  parseRelayResetPreparationBinding,
  parseRelayResetPreparationRecord as parsePreparation,
  type RelayResetPreparationRecord as Preparation
} from '../shared/relay-reset-preparation-contract'
const writing = new Set<string>()

/** Immutable preparation evidence, not evidence that the daemon or its processes exited. */
export class RelayOwnerResetPreparationJournal {
  private readonly directory: string

  constructor(
    directory: string,
    private readonly sockPath: string,
    private readonly serverBuildId: string
  ) {
    this.directory = resolve(directory)
  }

  describe(principal: string, authenticationKind: string) {
    return parseRelayResetPreparationBinding({
      version: 1,
      journalDirectory: this.directory,
      readerVersion: 1,
      sockPath: this.sockPath,
      serverBuildId: this.serverBuildId,
      principal,
      authenticationKind
    })
  }

  private path(request: RelayOwnerResetRequest): string {
    const hash = createHash('sha256')
      .update(JSON.stringify([request.runtimeIncarnation, request.operationId]))
      .digest('hex')
    return join(this.directory, `${hash}.json`)
  }

  read(value: RelayOwnerResetRequest): Preparation | null {
    const request = parseRelayOwnerResetRequest(value)
    const path = this.path(request)
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size > 64 * 1024) {
        throw new Error('relay_reset_preparation_journal_invalid')
      }
      const record = parsePreparation(
        JSON.parse(readNodeFileSyncWithinLimit(path, 64 * 1024).buffer.toString('utf8'))
      )
      if (
        JSON.stringify(record.request) !== JSON.stringify(request) ||
        record.sockPath !== this.sockPath ||
        record.serverBuildId !== this.serverBuildId
      ) {
        throw new Error('relay_reset_preparation_journal_conflict')
      }
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  persist(
    request: RelayOwnerResetRequest,
    principal: string,
    authenticationKind: string,
    assertAuthority: () => void
  ): undefined {
    const record = parsePreparation({
      version: 1,
      prepared: true,
      request,
      principal,
      authenticationKind,
      sockPath: this.sockPath,
      serverBuildId: this.serverBuildId
    })
    const path = this.path(record.request)
    if (writing.has(path)) {
      throw new Error('relay_reset_preparation_journal_busy')
    }
    writing.add(path)
    try {
      assertAuthority()
      const previous = this.read(record.request)
      if (previous && JSON.stringify(previous) !== JSON.stringify(record)) {
        throw new Error('relay_reset_preparation_journal_conflict')
      }
      assertAuthority()
      if (!writeDurableSecureJsonFile(path, record)) {
        throw new Error('relay_reset_preparation_journal_write_unconfirmed')
      }
      assertAuthority()
      if (JSON.stringify(this.read(record.request)) !== JSON.stringify(record)) {
        throw new Error('relay_reset_preparation_journal_write_unconfirmed')
      }
    } finally {
      writing.delete(path)
    }
  }
}
