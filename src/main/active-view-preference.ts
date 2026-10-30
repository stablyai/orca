import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TopLevelView } from '../shared/ui-chrome-types'
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
  private pendingFlush: Promise<void> | null = null
  private flushSignals = new Set<AbortSignal>()
  private unabortableFlushConsumers = 0
  private writeGeneration = 0
  /** Deleting this temp path vetoes an async rename during synchronous flush. */
  private inFlightTmpFile: string | null = null
  private quitFlushStarted = false
  private quitFlushPromise: Promise<void> | null = null
  private maintenancePaused = false

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
    // A debounce after quit flush would write unawaited during exit.
    if (this.quitFlushStarted) {
      return
    }
    this.writeGeneration += 1
    if (this.maintenancePaused) {
      return
    }
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.enqueueWrite(this.activeView, this.writeGeneration)
    }, SAVE_DEBOUNCE_MS)
  }

  private enqueueWrite(activeView: TopLevelView, generation: number): Promise<void> {
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
    return nextWrite
  }

  private async writeAsync(activeView: TopLevelView, generation: number): Promise<void> {
    const tmpFile = `${this.file}.${process.pid}.${generation}.tmp`
    let renamed = false
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(tmpFile, serializeActiveView(activeView), 'utf-8')
      // Async writes serialize; sync flush can still veto the rename after this generation check.
      if (generation !== this.writeGeneration) {
        return
      }
      this.inFlightTmpFile = tmpFile
      try {
        await rename(tmpFile, this.file)
        renamed = true
        if (generation === this.writeGeneration) {
          this.persistedActiveView = activeView
        }
      } catch (err) {
        // ENOENT: flushOrThrow removed this temp file because it already wrote a fresher view.
        if (
          (err as NodeJS.ErrnoException).code !== 'ENOENT' ||
          generation === this.writeGeneration
        ) {
          throw err
        }
      } finally {
        if (this.inFlightTmpFile === tmpFile) {
          this.inFlightTmpFile = null
        }
      }
    } finally {
      if (!renamed) {
        await rm(tmpFile).catch(() => {})
      }
    }
  }

  flushOrThrow(): void {
    if (this.quitFlushStarted) {
      throw new Error('Cannot synchronously flush active view after final persistence has started')
    }
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    const asyncWriteWasInFlight = this.pendingWrite !== null
    this.writeGeneration += 1
    if (!asyncWriteWasInFlight && this.activeView === this.persistedActiveView) {
      return
    }
    // Veto a stale rename that already passed its generation check before the sync flush.
    if (this.inFlightTmpFile) {
      try {
        unlinkSync(this.inFlightTmpFile)
        this.inFlightTmpFile = null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          void this.enqueueWrite(this.activeView, this.writeGeneration)
          throw error
        }
      }
    }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmpFile = `${this.file}.${process.pid}.${this.writeGeneration}.tmp`
    writeFileSync(tmpFile, serializeActiveView(this.activeView), 'utf-8')
    renameSync(tmpFile, this.file)
    this.persistedActiveView = this.activeView
  }

  /** Quit persistence must settle without rejecting the teardown barrier. */
  flushAsync(): Promise<void> {
    if (this.quitFlushPromise) {
      return this.quitFlushPromise
    }
    this.quitFlushStarted = true
    this.quitFlushPromise = this.flushPendingAsync()
    return this.quitFlushPromise
  }

  flushPendingAsync(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Active-view flush aborted'))
    }
    if (signal) {
      this.flushSignals.add(signal)
    } else {
      this.unabortableFlushConsumers += 1
    }
    if (this.pendingFlush) {
      return this.pendingFlush
    }
    const run = this.drainPendingWrites()
    const tracked = run.finally(() => {
      if (this.pendingFlush === tracked) {
        this.pendingFlush = null
        this.flushSignals.clear()
        this.unabortableFlushConsumers = 0
      }
    })
    this.pendingFlush = tracked
    return tracked
  }

  private async drainPendingWrites(): Promise<void> {
    for (;;) {
      if (this.allFlushConsumersAborted()) {
        throw new Error('Active-view flush aborted')
      }
      if (this.writeTimer) {
        clearTimeout(this.writeTimer)
        this.writeTimer = null
      }
      if (this.pendingWrite === null && this.activeView === this.persistedActiveView) {
        return
      }
      const generation = ++this.writeGeneration
      await this.enqueueWrite(this.activeView, generation)
      if (this.allFlushConsumersAborted()) {
        throw new Error('Active-view flush aborted')
      }
      if (generation === this.writeGeneration) {
        return
      }
    }
  }

  private allFlushConsumersAborted(): boolean {
    return (
      this.unabortableFlushConsumers === 0 &&
      this.flushSignals.size > 0 &&
      [...this.flushSignals].every((signal) => signal.aborted)
    )
  }

  async waitForPendingWrite(): Promise<void> {
    if (this.pendingWrite) {
      await this.pendingWrite
    }
  }

  pauseForMaintenance(): () => void {
    if (this.maintenancePaused || this.quitFlushStarted) {
      throw new Error('Active-view persistence is already paused')
    }
    this.maintenancePaused = true
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    return () => {
      this.maintenancePaused = false
      if (this.activeView !== this.persistedActiveView) {
        this.scheduleSave()
      }
    }
  }
}
