import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { sshRelayResetRecordDigest } from './ssh-relay-reset-retirement-record'

const MAX_BYTES = 64 * 1024

export class SshRelayResetRecordFiles {
  constructor(private readonly directory: string) {}

  path(targetId: string): string {
    if (!targetId || targetId.length > 512 || targetId.includes('\0')) {
      throw new Error('ssh_relay_reset_intent_target_invalid')
    }
    return join(this.directory, `${createHash('sha256').update(targetId).digest('hex')}.json`)
  }

  assertNoOrphanedSidecars(targetId: string): void {
    for (const suffix of ['.selection', '.receipt', '.completion']) {
      try {
        lstatSync(`${this.path(targetId)}${suffix}`)
        throw new Error('ssh_relay_reset_orphaned_records')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
  }

  readRecord<T>(path: string, parse: (value: unknown) => T, max = MAX_BYTES): T | null {
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size > max) {
        throw new Error('ssh_relay_reset_intent_file_invalid')
      }
      return parse(JSON.parse(readNodeFileSyncWithinLimit(path, max).buffer.toString('utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  async withTargetLock<T>(targetId: string, operation: () => T): Promise<T> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    let compromised: Error | undefined
    const release = await lock(this.path(targetId), {
      realpath: false,
      retries: 0,
      stale: 60_000,
      onCompromised: (error) => {
        compromised = error
      }
    })
    try {
      if (compromised) {
        throw compromised
      }
      const result = operation()
      if (compromised) {
        throw compromised
      }
      return result
    } finally {
      await release()
    }
  }

  writeRecord<T>(
    path: string,
    record: T,
    parse: (value: unknown) => T,
    assertBinding: () => void,
    max = MAX_BYTES,
    replaceDigest?: string
  ): T {
    assertBinding()
    const canonical = JSON.stringify(record)
    if (Buffer.byteLength(JSON.stringify(record, null, 2)) > max) {
      throw new Error('ssh_relay_reset_record_too_large')
    }
    const previous = this.readRecord(path, parse, max)
    if (replaceDigest && !previous) {
      throw new Error('ssh_relay_reset_replaced_record_missing')
    }
    if (
      previous &&
      JSON.stringify(previous) !== canonical &&
      sshRelayResetRecordDigest(previous) !== replaceDigest
    ) {
      throw new Error('ssh_relay_reset_intent_conflict')
    }
    // Reflush exact retries: readable intent does not acknowledge an uncertain write.
    if (!writeDurableSecureJsonFile(path, record)) {
      throw new Error('ssh_relay_reset_intent_permissions_unconfirmed')
    }
    const saved = this.readRecord(path, parse, max)
    assertBinding()
    if (!saved || JSON.stringify(saved) !== canonical) {
      throw new Error('ssh_relay_reset_intent_write_unconfirmed')
    }
    return saved
  }
}
