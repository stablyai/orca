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
  // An exit can clear the tail buffers; the preview list and summary show is then the kept output.
  const preview = (slept.pty?.preview || leaf.preview || '').split('\n')
  const keptTail = leaf.tailBuffer.length > 0
  const read = readTerminalTail({
    handle,
    status: 'running',
    previewLines: keptTail ? leaf.tailBuffer : preview,
    completedLines: keptTail ? leaf.tailTranscriptBuffer : preview,
    partialLine: keptTail ? leaf.tailPartialLine : '',
    // Counted in the stopped stream's cursors, so a cursor issued before the sleep stays valid.
    completedLineCount: keptTail
      ? leaf.tailLinesTotal
      : Math.max(preview.length, sleptLineCount(slept.pty)),
    bufferTruncated: keptTail ? leaf.tailTruncated : false,
    cursor: opts.cursor,
    limit: opts.limit
  })
  return { ...read, status: 'running', source: 'stream' }
}

/** How far a stopped process's line cursors reached, after its transcript may have been released. */
export function sleptLineCount(stopped: RuntimePtyWorktreeRecord | null | undefined): number {
  return Math.max(stopped?.tailLinesTotal ?? 0, stopped?.releasedLinesTotal ?? 0)
}
