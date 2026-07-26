import type { ArchivedTerminalPane } from '../shared/terminal-archive-types'
import {
  createPrioritizedTerminalArchiveSnapshotSource,
  type TerminalArchivePaneSnapshotCapture,
  type TerminalArchiveSnapshotSource
} from '../shared/workspace-session-terminal-archive'

type CaptureByLeafId = (
  leafId: string
) =>
  | Promise<TerminalArchivePaneSnapshotCapture | undefined>
  | TerminalArchivePaneSnapshotCapture
  | undefined

function unavailable(): TerminalArchivePaneSnapshotCapture {
  return { kind: 'unavailable' }
}

function sourceFromLeafCapture(captureByLeafId: CaptureByLeafId): TerminalArchiveSnapshotSource {
  return {
    async capture(pane: ArchivedTerminalPane): Promise<TerminalArchivePaneSnapshotCapture> {
      return (await captureByLeafId(pane.archivedLeafId)) ?? unavailable()
    }
  }
}

/** Keeps the two lost-worker paths on the same authority ordering without inventing a capture for a missing leaf. */
export function createRelayLostWorkerSnapshotSource(args: {
  captureSessionSidecar: CaptureByLeafId
  captureRelayTail: CaptureByLeafId
}): TerminalArchiveSnapshotSource {
  return createPrioritizedTerminalArchiveSnapshotSource({
    sessionSidecar: sourceFromLeafCapture(args.captureSessionSidecar),
    relayTail: sourceFromLeafCapture(args.captureRelayTail)
  })
}

export function createDaemonLostWorkerSnapshotSource(args: {
  lostLeafId: string
  captureLostLeaf: () =>
    | Promise<TerminalArchivePaneSnapshotCapture>
    | TerminalArchivePaneSnapshotCapture
  captureSessionSidecar: CaptureByLeafId
  captureSiblingColdRestore: CaptureByLeafId
}): TerminalArchiveSnapshotSource {
  return createPrioritizedTerminalArchiveSnapshotSource({
    daemonAuthoritative: {
      async capture(pane: ArchivedTerminalPane): Promise<TerminalArchivePaneSnapshotCapture> {
        return pane.archivedLeafId === args.lostLeafId
          ? await args.captureLostLeaf()
          : unavailable()
      }
    },
    sessionSidecar: sourceFromLeafCapture(async (leafId) => {
      const sidecar = await args.captureSessionSidecar(leafId)
      if (sidecar) {
        return sidecar
      }
      return leafId === args.lostLeafId ? undefined : await args.captureSiblingColdRestore(leafId)
    })
  })
}
