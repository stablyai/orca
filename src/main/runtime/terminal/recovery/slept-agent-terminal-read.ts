import type { RuntimeTerminalRead } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../records/runtime-terminal-state-records'
import { readTerminalTail } from '../output/tail/terminal-tail-read'

/** A slept agent reads as an idle one: the output its stopped process left, still running. */
export function readSleptAgentTerminal(
  handle: string,
  slept: { pty: RuntimePtyWorktreeRecord | null; leaf: RuntimeLeafRecord },
  opts: { cursor?: number; limit?: number },
  readPty: (pty: RuntimePtyWorktreeRecord) => RuntimeTerminalRead
): RuntimeTerminalRead {
  const fromPty = slept.pty ? readPty(slept.pty) : null
  if (fromPty && fromPty.tail.length > 0) {
    return { ...fromPty, status: 'running', source: 'stream' }
  }
  const { leaf } = slept
  const preview = sleptPreviewLines(slept.pty, leaf)
  const keptTail = leaf.tailBuffer.length > 0
  const read = readTerminalTail({
    handle,
    status: 'running',
    previewLines: keptTail ? leaf.tailBuffer : preview,
    completedLines: keptTail ? leaf.tailTranscriptBuffer : preview,
    partialLine: keptTail ? leaf.tailPartialLine : '',
    completedLineCount: sleptCursorCount(slept.pty, leaf),
    bufferTruncated: keptTail ? leaf.tailTruncated : false,
    cursor: opts.cursor,
    limit: opts.limit
  })
  return { ...read, status: 'running', source: 'stream' }
}

type SleptLeafTail = Pick<RuntimeLeafRecord, 'tailBuffer' | 'tailLinesTotal' | 'preview'>

/** An exit can clear the tail buffers; the preview list and summary show is then the kept output. */
function sleptPreviewLines(
  stopped: RuntimePtyWorktreeRecord | null | undefined,
  leaf: SleptLeafTail | undefined
): string[] {
  const preview = stopped?.preview || leaf?.preview || ''
  return preview ? preview.split('\n') : []
}

/** Where a slept handle's line cursors stand: what its slept read reports, and where the resumed
 *  process's count continues from, so a cursor issued before the sleep stays valid. */
export function sleptCursorCount(
  stopped: RuntimePtyWorktreeRecord | null | undefined,
  leaf: SleptLeafTail | undefined
): number {
  if (leaf && leaf.tailBuffer.length > 0) {
    return leaf.tailLinesTotal
  }
  const released = Math.max(stopped?.tailLinesTotal ?? 0, stopped?.releasedLinesTotal ?? 0)
  return Math.max(sleptPreviewLines(stopped, leaf).length, released)
}
