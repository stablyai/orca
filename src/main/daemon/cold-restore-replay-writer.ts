import type { HeadlessEmulator } from './headless-emulator'

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
      // Why: xterm must receive UTF-16 surrogate pairs together when a replay slice lands between them.
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
