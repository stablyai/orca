import type { RuntimeTerminalRead } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../records/runtime-terminal-state-records'
import { readTerminalTail } from '../output/tail/terminal-tail-read'

/** A slept agent reads as an idle one: the output its stopped process left, still running. The
 *  stopped process's record can be gone or emptied by its exit; the pane keeps the same tail. */
export function readSleptAgentTerminal(
  handle: string,
  slept: { pty: RuntimePtyWorktreeRecord | null; leaf: RuntimeLeafRecord },
  opts: { cursor?: number; limit?: number },
  readPty: (pty: RuntimePtyWorktreeRecord) => RuntimeTerminalRead
): RuntimeTerminalRead {
  const fromPty = slept.pty ? readPty(slept.pty) : null
  const { leaf } = slept
  const read =
    fromPty && fromPty.tail.length > 0
      ? fromPty
      : readTerminalTail({
          handle,
          status: 'running',
          previewLines: leaf.tailBuffer,
          completedLines: leaf.tailTranscriptBuffer,
          partialLine: leaf.tailPartialLine,
          completedLineCount: leaf.tailLinesTotal,
          bufferTruncated: leaf.tailTruncated,
          cursor: opts.cursor,
          limit: opts.limit
        })
  return { ...read, status: 'running', source: 'stream' }
}
