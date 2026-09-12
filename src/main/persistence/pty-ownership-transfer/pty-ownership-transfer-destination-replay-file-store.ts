import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_STAGED_BYTES
} from '../../../shared/pty-ownership-transfer-destination-adapter'
import type {
  PtyOwnershipTransferDestinationJournal,
  PtyOwnershipTransferIdentity
} from '../../../shared/pty-ownership-transfer-journal'
import type { PtyOwnershipTransferOutputFrame } from '../../../shared/pty-ownership-transfer-wire'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_FRAMES,
  type PtyOwnershipTransferDestinationFileRecord
} from './pty-ownership-transfer-destination-file'
import { advancePtyOwnershipTransferDestinationCursor } from './pty-ownership-transfer-journal-transitions'

type DestinationReplayFileStoreContext = Readonly<{
  loadRecord: (identity: PtyOwnershipTransferIdentity) => PtyOwnershipTransferDestinationFileRecord
  persist: (
    identity: PtyOwnershipTransferIdentity,
    record: PtyOwnershipTransferDestinationFileRecord
  ) => void
  now: () => Date
}>

export class PtyOwnershipTransferDestinationReplayFileStore {
  constructor(private readonly context: DestinationReplayFileStoreContext) {}

  appendFrame(
    identity: PtyOwnershipTransferIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): PtyOwnershipTransferDestinationJournal {
    const current = this.context.loadRecord(identity)
    if (current.journal.phase !== 'prepared') {
      throw new Error('pty_ownership_transfer_destination_cursor_advance_invalid')
    }
    if (frame.seq !== current.journal.acceptedSourceEndSeq + 1) {
      throw new Error('pty_ownership_transfer_destination_output_gap')
    }
    const frameBytes = Buffer.byteLength(frame.data, 'utf8')
    if (
      !frame.data ||
      frameBytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES ||
      (frame.truncated !== undefined && frame.truncated !== true)
    ) {
      throw new Error('pty_ownership_transfer_destination_frame_invalid')
    }
    if (current.frames.length >= PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_FRAMES) {
      throw new Error('pty_ownership_transfer_destination_frame_capacity_exceeded')
    }
    const stagedBytes = current.frames.reduce(
      (total, candidate) => total + Buffer.byteLength(candidate.data, 'utf8'),
      frameBytes
    )
    if (stagedBytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_STAGED_BYTES) {
      throw new Error('pty_ownership_transfer_destination_frame_capacity_exceeded')
    }
    const journal = advancePtyOwnershipTransferDestinationCursor(current.journal, frame.seq, {
      now: this.context.now
    })
    this.context.persist(identity, {
      ...current,
      journal,
      frames: [...current.frames, { ...frame }]
    })
    return structuredClone(journal)
  }
}
