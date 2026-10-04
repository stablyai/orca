import { HeadlessEmulator } from '../main/daemon/headless-emulator'
import {
  FreebuffScreenStatusTracker,
  splitFreebuffScreenUpdates
} from '../shared/freebuff-screen-status'

/** Emits the existing status OSC on the execution host, preserving the PTY's raw byte credit. */
export class FreebuffStatusProjection {
  private readonly emulator: HeadlessEmulator
  private readonly tracker = new FreebuffScreenStatusTracker(true)
  private disposed = false

  constructor(cols: number, rows: number) {
    this.emulator = new HeadlessEmulator({ cols, rows, scrollback: 0 })
  }

  project(data: string): string {
    if (this.disposed) {
      return data
    }
    return splitFreebuffScreenUpdates(data, this.emulator.partialEscapeTailAnsi)
      .map((chunk) => {
        if (!this.emulator.writeSync(chunk)) {
          return chunk
        }
        const status = this.tracker.observe(chunk, () => ({
          lines: this.emulator.getVisibleLines(),
          alternate: this.emulator.isAlternateScreen
        }))
        return status ? `${chunk}\x1b]9999;${JSON.stringify(status)}\x07` : chunk
      })
      .join('')
  }

  resize(cols: number, rows: number): void {
    if (!this.disposed) {
      this.emulator.resize(cols, rows)
    }
  }

  dispose(): void {
    this.disposed = true
    this.emulator.dispose()
  }
}
