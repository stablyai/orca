import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TopLevelView } from '../shared/types'
import { isTopLevelView } from '../shared/top-level-view'

const ACTIVE_VIEW_FILE_NAME = 'active-view.json'
const SAVE_DEBOUNCE_MS = 100

type ActiveViewFile = {
  activeView: TopLevelView
}

export function getActiveViewPreferenceFile(dataFile: string): string {
  return join(dirname(dataFile), ACTIVE_VIEW_FILE_NAME)
}

function readActiveView(file: string): TopLevelView | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ActiveViewFile>
    return isTopLevelView(parsed.activeView) ? parsed.activeView : null
  } catch {
    return null
  }
}

function serializeActiveView(activeView: TopLevelView): string {
  return `${JSON.stringify({ activeView } satisfies ActiveViewFile)}\n`
}

export class ActiveViewPreference {
  private readonly file: string
  private activeView: TopLevelView
  private persistedActiveView: TopLevelView | null
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private pendingWrite: Promise<void> | null = null
  private writeGeneration = 0

  constructor(dataFile: string, legacyActiveView: unknown) {
    this.file = getActiveViewPreferenceFile(dataFile)
    const storedActiveView = readActiveView(this.file)
    const fallbackActiveView = isTopLevelView(legacyActiveView) ? legacyActiveView : 'terminal'
    this.activeView = storedActiveView ?? fallbackActiveView
    this.persistedActiveView = storedActiveView
  }

  get(): TopLevelView {
    return this.activeView
  }

  set(value: unknown): boolean {
    if (!isTopLevelView(value)) {
      return false
    }
    const changed = value !== this.activeView
    this.activeView = value
    if (
      value !== this.persistedActiveView ||
      this.writeTimer !== null ||
      this.pendingWrite !== null
    ) {
      this.scheduleSave()
    }
    return changed
  }

  private scheduleSave(): void {
    this.writeGeneration += 1
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      const generation = this.writeGeneration
      const activeView = this.activeView
      const previousWrite = this.pendingWrite ?? Promise.resolve()
      const nextWrite = previousWrite
        .then(() => this.writeAsync(activeView, generation))
        .catch((error) => {
          console.error('[active-view] Failed to persist preference:', error)
        })
        .finally(() => {
          if (this.pendingWrite === nextWrite) {
            this.pendingWrite = null
          }
        })
      this.pendingWrite = nextWrite
    }, SAVE_DEBOUNCE_MS)
  }

  private async writeAsync(activeView: TopLevelView, generation: number): Promise<void> {
    const tmpFile = `${this.file}.${process.pid}.${generation}.tmp`
    let renamed = false
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(tmpFile, serializeActiveView(activeView), 'utf-8')
      // Why: keep the generation guard and the swap synchronous (no await between),
      // or a concurrent flushOrThrow could rename a newer view that this stale write
      // then clobbers, restoring the prior view on next launch.
      if (generation !== this.writeGeneration) {
        return
      }
      renameSync(tmpFile, this.file)
      renamed = true
      this.persistedActiveView = activeView
    } finally {
      if (!renamed) {
        await rm(tmpFile).catch(() => {})
      }
    }
  }

  flushOrThrow(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    const asyncWriteWasInFlight = this.pendingWrite !== null
    this.writeGeneration += 1
    this.pendingWrite = null
    if (!asyncWriteWasInFlight && this.activeView === this.persistedActiveView) {
      return
    }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmpFile = `${this.file}.${process.pid}.${this.writeGeneration}.tmp`
    writeFileSync(tmpFile, serializeActiveView(this.activeView), 'utf-8')
    renameSync(tmpFile, this.file)
    this.persistedActiveView = this.activeView
  }

  async waitForPendingWrite(): Promise<void> {
    if (this.pendingWrite) {
      await this.pendingWrite
    }
  }
}
