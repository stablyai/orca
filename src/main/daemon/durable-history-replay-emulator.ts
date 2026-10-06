import { HeadlessEmulator } from './headless-emulator'
import { collectNormalBufferOscLinkRanges } from './headless-osc-link-ranges'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

export type NormalBufferHead = {
  rowCount: number
  ansi: string
  oscLinks: TerminalOscLinkRange[]
}

/** Replays durable history so a checkpoint can take the rows the live window evicted. */
export class DurableHistoryReplayEmulator extends HeadlessEmulator {
  /** Normal-buffer rows older than the newest `keepRows`, as content-only ANSI, whichever buffer is active. */
  serializeNormalBufferHead(keepRows: number): NormalBufferHead {
    const rowCount = Math.max(0, this.terminal.buffer.normal.length - keepRows)
    if (rowCount === 0) {
      return { rowCount: 0, ansi: '', oscLinks: [] }
    }
    return {
      rowCount,
      ansi: this.serializer.serialize({
        range: { start: 0, end: rowCount - 1 },
        excludeAltBuffer: true,
        excludeModes: true
      }),
      oscLinks: collectNormalBufferOscLinkRanges(this.terminal, rowCount)
    }
  }
}
