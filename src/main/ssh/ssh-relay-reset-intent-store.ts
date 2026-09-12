import { SshRelayResetArchivedRecords } from './ssh-relay-reset-archived-records'
import { SshRelayResetRecordFiles } from './ssh-relay-reset-record-files'
import { unlinkSync } from 'node:fs'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from './ssh-relay-reset-intent'
import { parseSshRelayResetArchive, type SshRelayResetArchive } from './ssh-relay-reset-archive'
import {
  parseSshRelayResetRetirementSelection,
  parseSshRelayResetPreparationReceipt,
  parseSshRelayResetCompletion,
  sshRelayResetRecordDigest,
  type SshRelayResetCompletion,
  type SshRelayResetRetirementSelection,
  type SshRelayResetPreparationReceipt
} from './ssh-relay-reset-retirement-record'

const MAX_BYTES = 64 * 1024

export class SshRelayResetIntentStore {
  private readonly files: SshRelayResetRecordFiles
  private readonly archives: SshRelayResetArchivedRecords

  constructor(directory: string) {
    this.files = new SshRelayResetRecordFiles(directory)
    this.archives = new SshRelayResetArchivedRecords(this.files)
  }

  read(targetId: string): SshRelayResetIntent | null {
    const intent = this.readRawIntent(targetId)
    const retired = this.archives.readRetirementMarker(targetId)
    if (retired) {
      if (!intent) {
        throw new Error('ssh_relay_reset_retired_head_missing')
      }
      if (sshRelayResetRecordDigest(intent) === sshRelayResetRecordDigest(retired.intent)) {
        return null
      }
    }
    if (!intent) {
      this.files.assertNoOrphanedSidecars(targetId)
    }
    return intent
  }

  private readRawIntent(targetId: string): SshRelayResetIntent | null {
    return this.files.readRecord(this.files.path(targetId), (value) => {
      const result = parseSshRelayResetIntent(value)
      if (result.targetId !== targetId) {
        throw new Error('ssh_relay_reset_intent_target_mismatch')
      }
      return result
    })
  }

  async persist(value: unknown): Promise<SshRelayResetIntent> {
    const intent = parseSshRelayResetIntent(value)
    const path = this.files.path(intent.targetId)
    return this.files.withTargetLock(intent.targetId, () => {
      const previous = this.readRawIntent(intent.targetId)
      const marker = this.archives.readRetirementMarker(intent.targetId)
      const retired =
        marker &&
        previous &&
        sshRelayResetRecordDigest(previous) === sshRelayResetRecordDigest(marker.intent)
      if (marker && !previous) {
        throw new Error('ssh_relay_reset_retired_head_missing')
      }
      if (!previous) {
        this.files.assertNoOrphanedSidecars(intent.targetId)
      }
      if (!retired) {
        return this.files.writeRecord(path, intent, parseSshRelayResetIntent, () => {})
      }
      if (sshRelayResetRecordDigest(intent) === sshRelayResetRecordDigest(previous)) {
        throw new Error('ssh_relay_reset_intent_already_retired')
      }
      const archive = this.readArchive(marker.intent)!
      const remaining = this.archives.archivedSidecars(archive)
      for (const entry of remaining) {
        if (entry.present) {
          unlinkSync(entry.path)
        }
      }
      const markerDigest = sshRelayResetRecordDigest(marker)
      return this.files.writeRecord(
        path,
        intent,
        parseSshRelayResetIntent,
        () => {
          if (
            sshRelayResetRecordDigest(this.archives.readRetirementMarker(intent.targetId)) !==
            markerDigest
          ) {
            throw new Error('ssh_relay_reset_retirement_marker_changed')
          }
        },
        MAX_BYTES,
        sshRelayResetRecordDigest(previous)
      )
    })
  }

  readSelection(intent: SshRelayResetIntent): SshRelayResetRetirementSelection | null {
    this.assertIntent(parseSshRelayResetIntent(intent))
    return this.files.readRecord(
      `${this.files.path(intent.targetId)}.selection`,
      (value) => parseSshRelayResetRetirementSelection(value, intent),
      16 * 1024 * 1024
    )
  }

  async persistSelection(
    intent: SshRelayResetIntent,
    value: unknown
  ): Promise<SshRelayResetRetirementSelection> {
    const expected = parseSshRelayResetIntent(intent)
    const parse = (value: unknown) => parseSshRelayResetRetirementSelection(value, expected)
    return this.persistRecord(
      expected.targetId,
      `${this.files.path(expected.targetId)}.selection`,
      parse(value),
      parse,
      () => this.assertWritableIntent(expected),
      16 * 1024 * 1024
    )
  }

  readReceipt(intent: SshRelayResetIntent): SshRelayResetPreparationReceipt | null {
    const selection = this.readSelection(intent)
    if (!selection) {
      throw new Error('ssh_relay_reset_selection_missing')
    }
    return this.files.readRecord(`${this.files.path(intent.targetId)}.receipt`, (value) =>
      parseSshRelayResetPreparationReceipt(value, intent, selection)
    )
  }

  async persistReceipt(
    intent: SshRelayResetIntent,
    value: unknown
  ): Promise<SshRelayResetPreparationReceipt> {
    const expected = parseSshRelayResetIntent(intent)
    const selection = this.readSelection(expected)
    if (!selection) {
      throw new Error('ssh_relay_reset_selection_missing')
    }
    const parse = (value: unknown) =>
      parseSshRelayResetPreparationReceipt(value, expected, selection)
    return this.persistRecord(
      expected.targetId,
      `${this.files.path(expected.targetId)}.receipt`,
      parse(value),
      parse,
      () => {
        this.assertWritableIntent(expected)
        if (JSON.stringify(this.readSelection(expected)) !== JSON.stringify(selection)) {
          throw new Error('ssh_relay_reset_selection_changed')
        }
      }
    )
  }

  private assertIntent(expected: SshRelayResetIntent): void {
    if (JSON.stringify(this.readRawIntent(expected.targetId)) !== JSON.stringify(expected)) {
      throw new Error('ssh_relay_reset_intent_binding_changed')
    }
  }

  private assertWritableIntent(expected: SshRelayResetIntent): void {
    if (JSON.stringify(this.read(expected.targetId)) !== JSON.stringify(expected)) {
      throw new Error('ssh_relay_reset_intent_binding_changed')
    }
  }

  readCompletion(intent: SshRelayResetIntent): SshRelayResetCompletion | null {
    const selection = this.readSelection(intent)
    const receipt = this.readReceipt(intent)
    if (!selection || !receipt) {
      throw new Error('ssh_relay_reset_preparation_missing')
    }
    return this.files.readRecord(`${this.files.path(intent.targetId)}.completion`, (value) =>
      parseSshRelayResetCompletion(value, intent, selection, receipt)
    )
  }

  async persistCompletion(
    intent: SshRelayResetIntent,
    value: unknown,
    assertRetired: () => void
  ): Promise<SshRelayResetCompletion> {
    const expected = parseSshRelayResetIntent(intent)
    const selection = this.readSelection(expected)
    const receipt = this.readReceipt(expected)
    if (!selection || !receipt) {
      throw new Error('ssh_relay_reset_preparation_missing')
    }
    const parse = (value: unknown) =>
      parseSshRelayResetCompletion(value, expected, selection, receipt)
    const assertCurrent = () => {
      assertRetired()
      this.assertWritableIntent(expected)
      if (JSON.stringify(this.readReceipt(expected)) !== JSON.stringify(receipt)) {
        throw new Error('ssh_relay_reset_receipt_changed')
      }
    }
    const saved = await this.persistRecord(
      expected.targetId,
      `${this.files.path(expected.targetId)}.completion`,
      parse(value),
      parse,
      assertCurrent
    )
    assertCurrent()
    return saved
  }

  readRetiredArchive(intent: SshRelayResetIntent): SshRelayResetArchive | null {
    const expected = parseSshRelayResetIntent(intent)
    this.assertIntent(expected)
    const marker = this.archives.readRetirementMarker(expected.targetId)
    if (
      !marker ||
      sshRelayResetRecordDigest(marker.intent) !== sshRelayResetRecordDigest(expected)
    ) {
      return null
    }
    return this.readArchive(expected)
  }

  readArchive(intent: SshRelayResetIntent): SshRelayResetArchive | null {
    return this.archives.readArchive(intent)
  }

  retireArchived(
    intent: SshRelayResetIntent,
    assertRetired: () => void
  ): Promise<SshRelayResetArchive> {
    const expected = parseSshRelayResetIntent(intent)
    return this.archives.retireArchived(expected, () => {
      assertRetired()
      this.assertIntent(expected)
    })
  }

  async archiveCompleted(
    intent: SshRelayResetIntent,
    assertRetired: () => void
  ): Promise<SshRelayResetArchive> {
    const expected = parseSshRelayResetIntent(intent)
    const readActive = () => {
      assertRetired()
      return parseSshRelayResetArchive(
        {
          version: 1,
          intent: this.read(expected.targetId),
          selection: this.readSelection(expected),
          receipt: this.readReceipt(expected),
          completion: this.readCompletion(expected)
        },
        expected
      )
    }
    const archive = readActive()
    const digest = sshRelayResetRecordDigest(archive)
    const assertCurrent = () => {
      if (sshRelayResetRecordDigest(readActive()) !== digest) {
        throw new Error('ssh_relay_reset_archive_records_changed')
      }
    }
    const saved = await this.persistRecord(
      expected.targetId,
      this.archives.archivePath(expected),
      archive,
      (value) => parseSshRelayResetArchive(value, expected),
      assertCurrent,
      17 * 1024 * 1024
    )
    assertCurrent()
    return saved
  }

  private async persistRecord<T>(
    targetId: string,
    path: string,
    record: T,
    parse: (value: unknown) => T,
    assertBinding: () => void,
    max = MAX_BYTES
  ): Promise<T> {
    return this.files.withTargetLock(targetId, () =>
      this.files.writeRecord(path, record, parse, assertBinding, max)
    )
  }
}
