import type { ArchivedTerminalPane, ArchivedTerminalTab } from '../shared/terminal-archive-types'
import type { TerminalArchivePaneSnapshotInput } from '../shared/workspace-session-terminal-archive'
import { TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT } from '../shared/terminal-scrollback-limits'
import {
  deleteTerminalScrollbackSnapshotSync,
  trailingUtf8Bytes,
  writeTerminalArchiveScrollbackSnapshotSync
} from './terminal-scrollback-snapshots'
import type { TerminalScrollbackSnapshotStorage } from './terminal-scrollback-snapshots'

export function stageTerminalArchivePaneSnapshot(args: {
  archiveId: string
  snapshotVersion: string
  pane: ArchivedTerminalPane
  snapshot: TerminalArchivePaneSnapshotInput
  storage: TerminalScrollbackSnapshotStorage | undefined
}): { pane: ArchivedTerminalPane; writtenRef?: string } {
  const cappedBuffer = trailingUtf8Bytes(
    args.snapshot.buffer,
    TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT
  )
  const written = writeTerminalArchiveScrollbackSnapshotSync({
    archiveId: args.archiveId,
    leafId: args.pane.archivedLeafId,
    buffer: cappedBuffer.toString('utf-8'),
    snapshotVersion: args.snapshotVersion,
    storage: args.storage
  })
  if (written.kind === 'failed') {
    throw new Error('Failed to write terminal archive scrollback snapshot')
  }
  if (written.kind === 'empty') {
    return { pane: args.pane }
  }
  return {
    pane: {
      ...args.pane,
      snapshot: {
        ref: written.ref,
        byteLength: written.byteLength,
        truncated:
          args.snapshot.truncated === true ||
          Buffer.byteLength(args.snapshot.buffer, 'utf-8') > cappedBuffer.byteLength ||
          written.truncated,
        source: args.snapshot.source
      }
    },
    writtenRef: written.ref
  }
}

export function deleteUnreferencedTerminalArchiveSnapshots(args: {
  archives: readonly ArchivedTerminalTab[]
  isLive: (ref: string) => boolean
  storage: TerminalScrollbackSnapshotStorage | undefined
}): string[] {
  const deletedRefs: string[] = []
  for (const archive of args.archives) {
    for (const pane of Object.values(archive.panesByLeafId)) {
      const ref = pane.snapshot?.ref
      if (ref && !args.isLive(ref)) {
        deleteTerminalScrollbackSnapshotSync(ref, args.storage)
        deletedRefs.push(ref)
      }
    }
  }
  return deletedRefs
}
