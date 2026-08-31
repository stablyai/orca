import {
  TerminalStreamOpcode,
  encodeTerminalStreamText
} from '../../../../../shared/terminal-stream-protocol'
import type { TerminalOsc52ScannerSyncState } from '../../../../../shared/terminal-osc52-stream-scanner'
import type { TerminalMultiplexStream, TerminalOutputChunk } from './terminal-stream-types'
import { getOutputAfterSnapshotSeq } from './terminal-stream-replay'

export function prepareTerminalSnapshotPendingOutput(args: {
  stream: TerminalMultiplexStream
  pendingOutput: TerminalOutputChunk[]
  snapshotSeq: number | undefined
  includeAll: boolean
  sendFrame: (opcode: TerminalStreamOpcode, payload: Uint8Array<ArrayBufferLike>) => boolean
}): TerminalOutputChunk[] {
  const uncoveredOutput = args.pendingOutput.flatMap((chunk) => {
    const uncovered = args.includeAll ? chunk : getOutputAfterSnapshotSeq(chunk, args.snapshotSeq)
    return uncovered ? [uncovered] : []
  })
  sendTerminalClipboardScannerSync(
    args.stream,
    uncoveredOutput[0]?.osc52StartState ?? args.stream.osc52Scanner?.syncState ?? 'plain',
    args.sendFrame,
    true
  )
  return uncoveredOutput
}

export function sendTerminalClipboardScannerSync(
  stream: TerminalMultiplexStream,
  state: TerminalOsc52ScannerSyncState,
  sendFrame: (opcode: TerminalStreamOpcode, payload: Uint8Array<ArrayBufferLike>) => boolean,
  restoreDeliveryScanner: boolean
): void {
  if (!stream.supportsClipboardScannerSync) {
    return
  }
  if (restoreDeliveryScanner) {
    stream.osc52DeliveryScanner.restoreSyncState(state)
  }
  sendFrame(TerminalStreamOpcode.ClipboardScannerSync, encodeTerminalStreamText(state))
}
