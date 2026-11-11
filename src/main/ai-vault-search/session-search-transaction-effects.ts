import type { SessionSearchFileRow } from './storage/session-search-store-types'

type EffectsFrame = { restore: () => void; wakes: Map<string, SessionSearchFileRow> }

/** Derived summaries and source notifications follow the writer's nested SQL acceptance. */
export class SessionSearchTransactionEffects {
  private readonly frames: EffectsFrame[] = []
  constructor(
    private readonly snapshot: () => () => void,
    private readonly read: (path: string) => SessionSearchFileRow | undefined,
    private readonly publish: (previous: SessionSearchFileRow, row: SessionSearchFileRow) => void
  ) {}
  begin(): { commit: () => void; rollback: () => void } {
    const frame: EffectsFrame = { restore: this.snapshot(), wakes: new Map() }
    this.frames.push(frame)
    return {
      rollback: () => {
        this.frames.pop()
        frame.restore()
      },
      commit: () => {
        this.frames.pop()
        const parent = this.frames.at(-1)
        for (const [path, previous] of frame.wakes) {
          if (parent) {
            if (!parent.wakes.has(path)) {
              parent.wakes.set(path, previous)
            }
          } else {
            const row = this.read(path)
            if (row) {
              this.publish(previous, row)
            }
          }
        }
      }
    }
  }
  wake(previous: SessionSearchFileRow, row: SessionSearchFileRow): void {
    const frame = this.frames.at(-1)
    if (frame) {
      if (!frame.wakes.has(row.path)) {
        frame.wakes.set(row.path, previous)
      }
    } else {
      this.publish(previous, row)
    }
  }
}
