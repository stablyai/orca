import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PtyOwnershipTransferDestinationJournal } from '../../../shared/pty-ownership-transfer-journal'
import type { PtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import type { PtyOwnershipTransferPrepareResult } from '../../../shared/pty-ownership-transfer-wire'
import {
  parsePtyOwnershipTransferDestinationFile,
  readPtyOwnershipTransferDestinationFile
} from './pty-ownership-transfer-destination-file'
import { destinationFileStoreErrorHasCode } from './pty-ownership-transfer-destination-file-store-contract'

export type PtyOwnershipTransferDestinationRecoveryCandidate = Readonly<{
  requiresDelegatedSource?: true
  journal: Readonly<PtyOwnershipTransferDestinationJournal>
  surfaceBinding: PtyOwnershipTransferSurfaceBinding | null
}>

type RecoveryCandidateOptions = Readonly<{
  directory: string
  maxRecords: number
  maxInputIds: number
}>

export function prepareResultFromPtyOwnershipTransferRecoveryCandidate(
  candidate: PtyOwnershipTransferDestinationRecoveryCandidate
): PtyOwnershipTransferPrepareResult {
  const { journal, surfaceBinding } = candidate
  return Object.freeze({
    version: 1,
    bridgeId: journal.bridgeId,
    terminalId: journal.terminalId,
    incarnationId: journal.incarnationId,
    ownerLease: journal.ownerLease,
    sourceOwnerGeneration: journal.sourceOwnerGeneration,
    destinationRuntimeId: journal.destinationRuntimeId,
    phase: 'prepared',
    sourceOutputEndSeq: journal.acceptedSourceEndSeq,
    replayStartSeq: 1,
    ...(surfaceBinding
      ? { surfacePublication: Object.freeze({ version: 1 as const, surfaceBinding }) }
      : {})
  })
}

/** Enumerate exact durable sessions without changing transfer or execution ownership. */
export function listPtyOwnershipTransferDestinationRecoveryCandidates(
  options: RecoveryCandidateOptions
): readonly PtyOwnershipTransferDestinationRecoveryCandidate[] {
  let fileNames: string[]
  try {
    fileNames = readdirSync(options.directory)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort()
  } catch (error) {
    if (destinationFileStoreErrorHasCode(error, 'ENOENT')) {
      return Object.freeze([])
    }
    throw error
  }
  if (fileNames.length > options.maxRecords) {
    throw new Error('pty_ownership_transfer_destination_store_capacity_exceeded')
  }
  try {
    const candidates = fileNames
      .map((fileName) => {
        const record = parsePtyOwnershipTransferDestinationFile(
          readPtyOwnershipTransferDestinationFile(join(options.directory, fileName)),
          options.maxInputIds
        )
        if (fileName !== recordFileName(record.journal.bridgeId)) {
          throw new Error('pty_ownership_transfer_destination_store_filename_invalid')
        }
        return record
      })
      .filter((record) => record.journal.phase !== 'aborted')
      .sort(
        (left, right) =>
          left.journal.startedAt.localeCompare(right.journal.startedAt) ||
          left.journal.bridgeId.localeCompare(right.journal.bridgeId)
      )
      .map((record) =>
        Object.freeze({
          ...(record.delegatedSource ? { requiresDelegatedSource: true as const } : {}),
          journal: Object.freeze(structuredClone(record.journal)),
          surfaceBinding: record.surfaceBinding
            ? Object.freeze(structuredClone(record.surfaceBinding))
            : null
        })
      )
    return Object.freeze(candidates)
  } catch (error) {
    throw new Error('pty_ownership_transfer_destination_store_invalid', { cause: error })
  }
}

function recordFileName(bridgeId: string): string {
  return `${createHash('sha256').update(bridgeId).digest('hex')}.json`
}
