import type { SshRelayResetRecordFiles } from './ssh-relay-reset-record-files'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from './ssh-relay-reset-intent'
import { parseSshRelayResetArchive, type SshRelayResetArchive } from './ssh-relay-reset-archive'
import { parseSshRelayResetRetirementMarker } from './ssh-relay-reset-retirement-marker'
import { sshRelayResetRecordDigest } from './ssh-relay-reset-retirement-record'

const MAX_BYTES = 64 * 1024

export class SshRelayResetArchivedRecords {
  constructor(private readonly files: SshRelayResetRecordFiles) {}

  archivePath(intent: SshRelayResetIntent): string {
    return `${this.files.path(intent.targetId)}.archive-${sshRelayResetRecordDigest(intent)}`
  }

  readRetirementMarker(targetId: string) {
    const marker = this.files.readRecord(`${this.files.path(targetId)}.retired`, (value) =>
      parseSshRelayResetRetirementMarker(value, targetId)
    )
    if (marker) {
      const archive = this.readArchive(marker.intent)
      if (!archive || sshRelayResetRecordDigest(archive) !== marker.archiveSha256) {
        throw new Error('ssh_relay_reset_retirement_archive_unconfirmed')
      }
    }
    return marker
  }

  archivedSidecars(archive: SshRelayResetArchive) {
    const base = this.files.path(archive.intent.targetId)
    return [
      { suffix: '.selection', value: archive.selection, max: 16 * 1024 * 1024 },
      { suffix: '.receipt', value: archive.receipt, max: MAX_BYTES },
      { suffix: '.completion', value: archive.completion, max: MAX_BYTES }
    ].map((entry) => {
      const path = `${base}${entry.suffix}`
      const present = this.files.readRecord(
        path,
        (value) => {
          if (!value || typeof value !== 'object') {
            throw new Error('ssh_relay_reset_sidecar_invalid')
          }
          return value
        },
        entry.max
      )
      if (
        present &&
        sshRelayResetRecordDigest(present) !== sshRelayResetRecordDigest(entry.value)
      ) {
        throw new Error('ssh_relay_reset_archived_sidecar_changed')
      }
      return { path, present: present !== null }
    })
  }

  async retireArchived(
    intent: SshRelayResetIntent,
    assertRetired: () => void
  ): Promise<SshRelayResetArchive> {
    const expected = parseSshRelayResetIntent(intent)
    return this.files.withTargetLock(expected.targetId, () => {
      const assertCurrent = () => {
        assertRetired()
      }
      assertCurrent()
      const archive = this.readArchive(expected)
      if (!archive) {
        throw new Error('ssh_relay_reset_archive_missing')
      }
      const previous = this.readRetirementMarker(expected.targetId)
      const alreadyRetired =
        previous &&
        sshRelayResetRecordDigest(previous.intent) === sshRelayResetRecordDigest(expected)
      const sidecars = this.archivedSidecars(archive)
      if (!alreadyRetired && sidecars.some((entry) => !entry.present)) {
        throw new Error('ssh_relay_reset_active_records_missing')
      }
      this.files.writeRecord(
        this.archivePath(expected),
        archive,
        (value) => parseSshRelayResetArchive(value, expected),
        assertCurrent,
        17 * 1024 * 1024
      )
      const marker = parseSshRelayResetRetirementMarker(
        {
          version: 1,
          kind: 'archived',
          intent: expected,
          archiveSha256: sshRelayResetRecordDigest(archive)
        },
        expected.targetId
      )
      this.files.writeRecord(
        `${this.files.path(expected.targetId)}.retired`,
        marker,
        (value) => parseSshRelayResetRetirementMarker(value, expected.targetId),
        assertCurrent,
        MAX_BYTES,
        previous ? sshRelayResetRecordDigest(previous) : undefined
      )
      if (
        sshRelayResetRecordDigest(this.readRetirementMarker(expected.targetId)) !==
        sshRelayResetRecordDigest(marker)
      ) {
        throw new Error('ssh_relay_reset_retirement_unconfirmed')
      }
      return archive
    })
  }

  readArchive(intent: SshRelayResetIntent): SshRelayResetArchive | null {
    const expected = parseSshRelayResetIntent(intent)
    return this.files.readRecord(
      this.archivePath(expected),
      (value) => parseSshRelayResetArchive(value, expected),
      17 * 1024 * 1024
    )
  }
}
