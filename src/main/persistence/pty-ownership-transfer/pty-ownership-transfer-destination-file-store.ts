import { createHash } from 'node:crypto'
import { bindPtyOwnershipTransferDelegatedSource } from './pty-ownership-transfer-delegated-source'
import { reservePtyOwnershipTransferDelegatedClaimIntent } from './pty-ownership-transfer-delegated-claim-intent'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import {
  assertPtyOwnershipTransferIdentity,
  MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS,
  parsePtyOwnershipTransferJournal,
  type PtyOwnershipTransferCommitReceipt,
  type PtyOwnershipTransferDestinationJournal,
  type PtyOwnershipTransferIdentity,
  type PtyOwnershipTransferPublicationReceipt
} from '../../../shared/pty-ownership-transfer-journal'
import type { PtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS,
  type PtyOwnershipTransferDestinationStore
} from '../../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipTransferOutputFrame } from '../../../shared/pty-ownership-transfer-wire'
import {
  abortPtyOwnershipTransferJournal,
  commitPtyOwnershipTransferDestination,
  publishPtyOwnershipTransferDestination
} from './pty-ownership-transfer-journal-transitions'
import {
  parsePtyOwnershipTransferDestinationFile,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_FILE_VERSION,
  readPtyOwnershipTransferDestinationFile,
  type PtyOwnershipTransferDestinationFileRecord
} from './pty-ownership-transfer-destination-file'
import {
  boundedDestinationFileStoreValue,
  destinationFileStoreErrorHasCode,
  requireDestinationSequence,
  type DestinationFileStoreOptions
} from './pty-ownership-transfer-destination-file-store-contract'
import { PtyOwnershipTransferDestinationInputFileStore } from './pty-ownership-transfer-destination-input-file-store'
import { PtyOwnershipTransferDestinationReplayFileStore } from './pty-ownership-transfer-destination-replay-file-store'
import { PtyOwnershipTransferDestinationSurfaceFileStore } from './pty-ownership-transfer-destination-surface-file-store'
import {
  listPtyOwnershipTransferDestinationRecoveryCandidates,
  type PtyOwnershipTransferDestinationRecoveryCandidate
} from './pty-ownership-transfer-destination-recovery-candidates'

export {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_DIRECTORY,
  ptyOwnershipTransferDestinationDirectory
} from './pty-ownership-transfer-destination-file-store-contract'

/** Crash-safe replay/input store. Every successful mutation is fsynced before it returns. */
export class PtyOwnershipTransferDestinationFileStore implements PtyOwnershipTransferDestinationStore {
  private readonly maxRecords: number
  private readonly maxInputIds: number
  private readonly now: () => Date
  readonly input: PtyOwnershipTransferDestinationInputFileStore
  private readonly replay: PtyOwnershipTransferDestinationReplayFileStore
  readonly surface: PtyOwnershipTransferDestinationSurfaceFileStore

  constructor(private readonly options: DestinationFileStoreOptions) {
    this.maxRecords = boundedDestinationFileStoreValue(
      options.maxRecords ?? MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS,
      MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS
    )
    this.maxInputIds = boundedDestinationFileStoreValue(
      options.maxInputIds ?? PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS,
      PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS
    )
    this.now = options.now ?? (() => new Date())
    this.input = new PtyOwnershipTransferDestinationInputFileStore({
      loadRecord: (identity) => this.requireRecord(identity),
      persist: (identity, record) => this.persist(identity, record),
      maxInputIds: this.maxInputIds
    })
    this.replay = new PtyOwnershipTransferDestinationReplayFileStore({
      loadRecord: (identity) => this.requireRecord(identity),
      persist: (identity, record) => this.persist(identity, record),
      now: this.now
    })
    this.surface = new PtyOwnershipTransferDestinationSurfaceFileStore({
      catalogPublicationVersion: options.catalogPublicationVersion,
      loadRecord: (identity) => this.requireRecord(identity),
      persist: (identity, record) => this.persist(identity, record),
      now: this.now
    })
  }

  load(identity: PtyOwnershipTransferIdentity): PtyOwnershipTransferDestinationJournal | null {
    return structuredClone(this.loadRecord(identity)?.journal ?? null)
  }

  loadDelegatedSource(identity: PtyOwnershipTransferIdentity) {
    return structuredClone(this.requireRecord(identity).delegatedSource ?? null)
  }

  loadDelegatedClaimIntent(identity: PtyOwnershipTransferIdentity) {
    return structuredClone(this.requireRecord(identity).delegatedClaimIntent ?? null)
  }

  /** Synchronous CAS under the runtime's single-writer ownership, not a cross-process lock. */
  reserveDelegatedClaimIntent(
    identity: PtyOwnershipTransferIdentity,
    expected: unknown,
    next: unknown
  ) {
    const current = this.requireRecord(identity)
    const reserved = reservePtyOwnershipTransferDelegatedClaimIntent(current, expected, next)
    if (reserved !== current) {
      this.persist(identity, reserved)
    }
    return structuredClone(reserved.delegatedClaimIntent!)
  }

  bindDelegatedSource(identity: PtyOwnershipTransferIdentity, value: unknown): void {
    const record = this.requireRecord(identity)
    const bound = bindPtyOwnershipTransferDelegatedSource(record, value)
    if (bound !== record) {
      this.persist(identity, bound)
    }
  }

  listRecoveryCandidates(): readonly PtyOwnershipTransferDestinationRecoveryCandidate[] {
    return listPtyOwnershipTransferDestinationRecoveryCandidates({
      directory: this.options.directory,
      maxRecords: this.maxRecords,
      maxInputIds: this.maxInputIds
    })
  }

  prepare(
    identity: PtyOwnershipTransferIdentity,
    acceptedSourceEndSeq: number
  ): PtyOwnershipTransferDestinationJournal {
    const existing = this.loadRecord(identity)
    if (existing) {
      if (existing.journal.phase === 'aborted') {
        throw new Error('pty_ownership_transfer_id_aborted')
      }
      if (existing.journal.acceptedSourceEndSeq !== acceptedSourceEndSeq) {
        throw new Error('pty_ownership_transfer_destination_cursor_conflict')
      }
      return structuredClone(existing.journal)
    }
    requireDestinationSequence(acceptedSourceEndSeq)
    this.requireCapacity()
    const timestamp = this.now().toISOString()
    const journal = parseDestinationJournal({
      ...identity,
      version: 1,
      side: 'destination',
      phase: 'prepared',
      acceptedSourceEndSeq,
      startedAt: timestamp,
      updatedAt: timestamp
    })
    this.persist(identity, {
      version: PTY_OWNERSHIP_TRANSFER_DESTINATION_FILE_VERSION,
      journal,
      frames: [],
      inputIds: []
    })
    return structuredClone(journal)
  }

  loadFrames(identity: PtyOwnershipTransferIdentity): readonly PtyOwnershipTransferOutputFrame[] {
    return structuredClone(this.requireRecord(identity).frames)
  }

  appendFrame(
    identity: PtyOwnershipTransferIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): PtyOwnershipTransferDestinationJournal {
    return this.replay.appendFrame(identity, frame)
  }

  commit(
    identity: PtyOwnershipTransferIdentity,
    receipt: PtyOwnershipTransferCommitReceipt
  ): PtyOwnershipTransferDestinationJournal {
    return this.transition(identity, (current) =>
      commitPtyOwnershipTransferDestination(current, identity, receipt, { now: this.now })
    )
  }

  loadSurfaceBinding(
    identity: PtyOwnershipTransferIdentity
  ): PtyOwnershipTransferSurfaceBinding | null {
    return this.surface.loadSurfaceBinding(identity)
  }

  bindSurface(
    identity: PtyOwnershipTransferIdentity,
    binding: PtyOwnershipTransferSurfaceBinding
  ): PtyOwnershipTransferSurfaceBinding {
    return this.surface.bindSurface(identity, binding)
  }

  reservePublication(
    identity: PtyOwnershipTransferIdentity,
    receipt: PtyOwnershipTransferCommitReceipt
  ): PtyOwnershipTransferPublicationReceipt {
    return this.surface.reservePublication(identity, receipt)
  }

  publish(
    identity: PtyOwnershipTransferIdentity,
    receipt: PtyOwnershipTransferPublicationReceipt
  ): PtyOwnershipTransferDestinationJournal {
    this.surface.assertPublicationIntent(identity, receipt)
    return this.transition(identity, (current) =>
      publishPtyOwnershipTransferDestination(current, identity, receipt)
    )
  }

  abort(identity: PtyOwnershipTransferIdentity): PtyOwnershipTransferDestinationJournal {
    const current = this.requireRecord(identity)
    const journal = abortPtyOwnershipTransferJournal(current.journal, { now: this.now })
    if (journal.side !== 'destination') {
      throw new Error('pty_ownership_transfer_destination_file_side_invalid')
    }
    this.persist(identity, {
      ...current,
      journal,
      frames: [],
      inputIds: [],
      surfaceBinding: undefined,
      publicationIntent: undefined
    })
    return structuredClone(journal)
  }

  loadInputIds(
    identity: PtyOwnershipTransferIdentity
  ): readonly Readonly<{ inputId: string; data: string }>[] {
    return this.input.loadInputIds(identity)
  }

  acceptInput(
    identity: PtyOwnershipTransferIdentity,
    inputId: string,
    data: string
  ): 'accepted' | 'duplicate' | 'conflict' {
    return this.input.acceptInput(identity, inputId, data)
  }

  retireInput(identity: PtyOwnershipTransferIdentity, inputIds: readonly string[]): number {
    return this.input.retireInput(identity, inputIds)
  }

  private transition(
    identity: PtyOwnershipTransferIdentity,
    transition: (
      journal: PtyOwnershipTransferDestinationJournal
    ) => PtyOwnershipTransferDestinationJournal
  ): PtyOwnershipTransferDestinationJournal {
    const current = this.requireRecord(identity)
    const journal = transition(current.journal)
    if (journal !== current.journal) {
      this.persist(identity, { ...current, journal })
    }
    return structuredClone(journal)
  }

  private loadRecord(
    identity: PtyOwnershipTransferIdentity
  ): PtyOwnershipTransferDestinationFileRecord | null {
    const path = this.recordPath(identity.bridgeId)
    if (!existsSync(path)) {
      return null
    }
    try {
      const record = parsePtyOwnershipTransferDestinationFile(
        readPtyOwnershipTransferDestinationFile(path),
        this.maxInputIds
      )
      assertPtyOwnershipTransferIdentity(record.journal, identity)
      return record
    } catch (error) {
      throw new Error('pty_ownership_transfer_destination_store_invalid', { cause: error })
    }
  }

  private requireRecord(identity: PtyOwnershipTransferIdentity) {
    const record = this.loadRecord(identity)
    if (!record) {
      throw new Error('pty_ownership_transfer_journal_not_found')
    }
    return record
  }

  private persist(
    identity: PtyOwnershipTransferIdentity,
    record: PtyOwnershipTransferDestinationFileRecord
  ): void {
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })
    const path = this.recordPath(identity.bridgeId)
    writeFileDurableSync(durableWriteTempPath(path), path, `${JSON.stringify(record)}\n`, 0o600)
  }

  private requireCapacity(): void {
    let records: string[] = []
    try {
      records = readdirSync(this.options.directory).filter((name) =>
        /^[a-f0-9]{64}\.json$/.test(name)
      )
    } catch (error) {
      if (!destinationFileStoreErrorHasCode(error, 'ENOENT')) {
        throw error
      }
    }
    if (records.length >= this.maxRecords) {
      throw new Error('pty_ownership_transfer_destination_store_capacity_exceeded')
    }
  }

  private recordPath(bridgeId: string): string {
    const digest = createHash('sha256').update(bridgeId).digest('hex')
    return join(this.options.directory, `${digest}.json`)
  }
}

function parseDestinationJournal(value: unknown): PtyOwnershipTransferDestinationJournal {
  const journal = parsePtyOwnershipTransferJournal(value)
  if (journal.side !== 'destination') {
    throw new Error('pty_ownership_transfer_destination_file_side_invalid')
  }
  return journal
}
