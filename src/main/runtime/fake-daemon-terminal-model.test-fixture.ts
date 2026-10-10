import { HeadlessEmulator } from '../daemon/headless-emulator'
import type { PtyProviderBufferSnapshot } from '../providers/types'

/** Stands in for the terminal daemon: parses every byte and serves settled snapshots. */
export class FakeDaemonModel {
  readonly emulator: HeadlessEmulator
  seq = 0

  constructor(grid: { cols: number; rows: number }) {
    this.emulator = new HeadlessEmulator(grid)
  }

  async feed(data: string): Promise<void> {
    this.seq += data.length
    await this.emulator.write(data)
  }

  snapshot(): PtyProviderBufferSnapshot {
    const snapshot = this.emulator.getSnapshot({ scrollbackRows: 1000 })
    return {
      data: snapshot.rehydrateSequences + snapshot.snapshotAnsi,
      ...(snapshot.scrollbackAnsi ? { scrollbackAnsi: snapshot.scrollbackAnsi } : {}),
      cols: snapshot.cols,
      rows: snapshot.rows,
      seq: this.seq,
      source: 'headless',
      alternateScreen: snapshot.modes.alternateScreen
    }
  }
}
