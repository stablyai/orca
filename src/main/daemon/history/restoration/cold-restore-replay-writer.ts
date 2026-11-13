import type { HeadlessEmulator } from '../../emulation/headless-emulator'
import type { PendingOutputRecord } from '../../protocol/daemon-rpc-contract'
import { isValidTerminalHistorySize } from './terminal-history-dimensions'

/**
 * Records read by position at each synchronous slice. Undefined ends the source; null means it
 * was revoked. Nothing a slice reads survives the next yield.
 */
export type ReplayRecordSource = (index: number) => PendingOutputRecord | undefined | null

const REPLAY_CHARS_PER_TURN = 64 * 1024
const REPLAY_OPERATIONS_PER_TURN = 1024

export class ColdRestoreReplayWriter {
  private chars = 0
  private operations = 0

  constructor(private readonly emulator: HeadlessEmulator) {}

  async write(data: string): Promise<boolean> {
    let offset = 0
    while (offset < data.length) {
      const pendingYield = this.takeBudgetYield()
      if (pendingYield) {
        await pendingYield
      }
      const remainingBudget = REPLAY_CHARS_PER_TURN - this.chars
      let end = Math.min(data.length, offset + remainingBudget)
      // Keep UTF-16 surrogate pairs together across xterm replay slices.
      const leftCodeUnit = data.charCodeAt(end - 1)
      const rightCodeUnit = data.charCodeAt(end)
      const splitsSurrogatePair =
        end < data.length &&
        leftCodeUnit >= 0xd800 &&
        leftCodeUnit <= 0xdbff &&
        rightCodeUnit >= 0xdc00 &&
        rightCodeUnit <= 0xdfff
      if (splitsSurrogatePair) {
        end += end === offset + 1 ? 1 : -1
      }
      if (!this.emulator.writeSync(data.slice(offset, end))) {
        return false
      }
      this.chars += end - offset
      this.operations += 1
      offset = end
    }
    return true
  }

  /**
   * Replays the source with no record, string or slice held across a yield. A positioned folder
   * is set once before that record (or at the end), so later real OSC 7 still wins.
   */
  async replayRecords(
    source: ReplayRecordSource,
    isCanceled: () => boolean,
    cwdAt?: { index: number; cwd: string }
  ): Promise<boolean> {
    const position = { index: 0, offset: 0 }
    let cwdPending = cwdAt !== undefined
    for (;;) {
      const pendingYield = this.takeBudgetYield()
      if (pendingYield) {
        await pendingYield
      }
      if (isCanceled()) {
        return false
      }
      if (cwdPending && position.index === cwdAt!.index && position.offset === 0) {
        cwdPending = false
        this.emulator.setCwd(cwdAt!.cwd)
      }
      const step = this.replayStep(source, position)
      if (step !== 'more') {
        return step === 'done'
      }
    }
  }

  // One synchronous slice: its record and string locals end when it returns.
  private replayStep(
    source: ReplayRecordSource,
    position: { index: number; offset: number }
  ): 'more' | 'done' | 'failed' {
    const record = source(position.index)
    if (record === undefined) {
      return 'done'
    }
    if (record === null) {
      return 'failed'
    }
    this.operations += 1
    if (record.kind === 'resize') {
      if (!isValidTerminalHistorySize(record.cols, record.rows)) {
        return 'failed'
      }
      this.emulator.resize(record.cols, record.rows)
    } else if (record.kind === 'clear') {
      this.emulator.clearScrollback()
    } else {
      const end = this.sliceEnd(record.data, position.offset)
      if (
        end > position.offset &&
        !this.emulator.writeSync(record.data.slice(position.offset, end))
      ) {
        return 'failed'
      }
      this.chars += end - position.offset
      position.offset = end
      if (end < record.data.length) {
        return 'more'
      }
    }
    position.index += 1
    position.offset = 0
    return 'more'
  }

  private sliceEnd(data: string, offset: number): number {
    let end = Math.min(data.length, offset + Math.max(1, REPLAY_CHARS_PER_TURN - this.chars))
    // Keep UTF-16 surrogate pairs together across xterm replay slices.
    const left = data.charCodeAt(end - 1)
    const right = data.charCodeAt(end)
    if (
      end < data.length &&
      left >= 0xd800 &&
      left <= 0xdbff &&
      right >= 0xdc00 &&
      right <= 0xdfff
    ) {
      end += end === offset + 1 ? 1 : -1
    }
    return end
  }

  async resize(cols: number, rows: number): Promise<void> {
    const pendingYield = this.takeBudgetYield()
    if (pendingYield) {
      await pendingYield
    }
    this.emulator.resize(cols, rows)
    this.operations += 1
  }

  async clearScrollback(): Promise<void> {
    const pendingYield = this.takeBudgetYield()
    if (pendingYield) {
      await pendingYield
    }
    this.emulator.clearScrollback()
    this.operations += 1
  }

  private takeBudgetYield(): Promise<void> | null {
    if (this.chars < REPLAY_CHARS_PER_TURN && this.operations < REPLAY_OPERATIONS_PER_TURN) {
      return null
    }
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        this.chars = 0
        this.operations = 0
        resolve()
      })
    })
  }
}
