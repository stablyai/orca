import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  THEME_STUDIO_MODES,
  themeStudioDraftSchema,
  type ThemeStudioDraft,
  type ThemeStudioMode
} from '../../shared/theme-studio/theme-studio-draft'
import {
  THEME_STUDIO_ERROR_CODES,
  ThemeStudioError
} from '../../shared/theme-studio/theme-studio-errors'
import type {
  ThemeStudioPreview,
  ThemeStudioReport
} from '../../shared/theme-studio/theme-studio-protocol'

const MAX_HISTORY = 100
// Why a frame: an agent's burst of edits paints once, not once per command.
const PUSH_COALESCE_MS = 16
const PERSIST_DEBOUNCE_MS = 250
const MAX_WAITERS = 64

const persistedSessionSchema = z.object({
  version: z.literal(1),
  cursor: z.number().int().nonnegative(),
  history: z
    .array(z.object({ label: z.string().max(256), draft: themeStudioDraftSchema }))
    .min(1)
    .max(MAX_HISTORY)
})

type HistoryEntry = { label: string; draft: ThemeStudioDraft }

export type ThemeStudioStatus = {
  active: boolean
  name: string | null
  revision: number
  modes: ThemeStudioMode[]
  undo: number
  redo: number
  /** Oldest first; `current` marks where undo and redo stand. */
  history: { label: string; current: boolean }[]
}

export type ThemeStudioSessionDeps = {
  /** Where the session survives a restart. */
  sessionFile: string
  /** Paints a draft (or ends the preview); a no-op without a window. */
  push: (preview: ThemeStudioPreview) => void
}

/** The draft being edited, its undo history, and the coalesced preview pushed to the window.
 *  Idle costs nothing: no timers run unless an edit is waiting to paint or persist. */
export class ThemeStudioSession {
  private history: HistoryEntry[] = []
  private cursor = -1
  private revision = 0
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private latestReport: ThemeStudioReport | null = null
  private waiters: { revision: number; resolve: (report: ThemeStudioReport | null) => void }[] = []

  constructor(private readonly deps: ThemeStudioSessionDeps) {}

  /** Restores a session a restart interrupted; a damaged file is dropped. */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.deps.sessionFile, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = persistedSessionSchema.parse(JSON.parse(raw))
      this.history = parsed.history
      this.cursor = Math.min(parsed.cursor, parsed.history.length - 1)
      this.revision += 1
      this.schedulePush()
    } catch (error) {
      console.warn('[theme-studio] dropping an unreadable session:', error)
      await rm(this.deps.sessionFile, { force: true }).catch(() => undefined)
    }
  }

  get draft(): ThemeStudioDraft | null {
    return this.history[this.cursor]?.draft ?? null
  }

  get currentRevision(): number {
    return this.revision
  }

  requireDraft(): ThemeStudioDraft {
    const draft = this.draft
    if (!draft) {
      throw new ThemeStudioError(THEME_STUDIO_ERROR_CODES.noDraft, 'No theme draft is open.', {
        nextSteps: [
          'Start one with `orca theme edit`, or change a token with `orca theme set` (it starts from the current theme).'
        ]
      })
    }
    return draft
  }

  status(): ThemeStudioStatus {
    const draft = this.draft
    return {
      active: draft !== null,
      name: draft?.name ?? null,
      revision: this.revision,
      modes: draft ? THEME_STUDIO_MODES.filter((mode) => draft[mode] !== null) : [],
      undo: Math.max(0, this.cursor),
      redo: Math.max(0, this.history.length - 1 - this.cursor),
      history: this.history.map((entry, index) => ({
        label: entry.label,
        current: index === this.cursor
      }))
    }
  }

  /** Starts a new session whose first step is `draft`. */
  begin(draft: ThemeStudioDraft, label: string): void {
    this.history = [{ label, draft }]
    this.cursor = 0
    this.changed()
  }

  /** Records `draft` as the next step; anything that was undone is dropped. */
  commit(draft: ThemeStudioDraft, label: string): void {
    this.requireDraft()
    this.history = [...this.history.slice(0, this.cursor + 1), { label, draft }].slice(-MAX_HISTORY)
    this.cursor = this.history.length - 1
    this.changed()
  }

  step(direction: 'undo' | 'redo'): string {
    this.requireDraft()
    const target = direction === 'undo' ? this.cursor - 1 : this.cursor + 1
    const entry = this.history[target]
    if (!entry) {
      throw new ThemeStudioError(
        THEME_STUDIO_ERROR_CODES.historyEnd,
        direction === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.',
        { nextSteps: ['Run `orca theme show --json` to see the history.'] }
      )
    }
    // Why the step's own label: undo names what it took back, redo what it put back.
    const label = direction === 'undo' ? (this.history[this.cursor]?.label ?? '') : entry.label
    this.cursor = target
    this.changed()
    return label
  }

  /** Ends the session: the preview stops and nothing is kept. */
  end(): void {
    this.history = []
    this.cursor = -1
    this.latestReport = null
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    void rm(this.deps.sessionFile, { force: true }).catch(() => undefined)
    this.revision += 1
    this.schedulePush()
    this.settleWaiters(null)
  }

  /** The renderer painted a revision and checked it. */
  receiveReport(report: ThemeStudioReport): void {
    if (report.revision !== this.revision || !this.draft) {
      return
    }
    this.latestReport = report
    this.settleWaiters(report)
  }

  /** The report for the current revision, waiting up to `timeoutMs` for the window to paint it. */
  waitForReport(timeoutMs: number): Promise<ThemeStudioReport | null> {
    const revision = this.revision
    if (this.latestReport?.revision === revision) {
      return Promise.resolve(this.latestReport)
    }
    if (!this.draft || this.waiters.length >= MAX_WAITERS) {
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      const waiter = {
        revision,
        resolve: (report: ThemeStudioReport | null) => {
          clearTimeout(timer)
          resolve(report)
        }
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter)
        resolve(null)
      }, timeoutMs)
      timer.unref?.()
      this.waiters.push(waiter)
    })
  }

  /** Re-sends the current draft, e.g. to a window that just loaded. */
  repaint(): void {
    if (this.draft) {
      this.schedulePush()
    }
  }

  private settleWaiters(report: ThemeStudioReport | null): void {
    const settled = this.waiters.filter(
      (waiter) => report === null || waiter.revision <= report.revision
    )
    this.waiters = this.waiters.filter((waiter) => !settled.includes(waiter))
    for (const waiter of settled) {
      waiter.resolve(report)
    }
  }

  private changed(): void {
    this.revision += 1
    this.latestReport = null
    this.schedulePush()
    this.schedulePersist()
  }

  private schedulePush(): void {
    if (this.pushTimer) {
      return
    }
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      const draft = this.draft
      this.deps.push(draft ? { revision: this.revision, draft } : null)
    }, PUSH_COALESCE_MS)
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, PERSIST_DEBOUNCE_MS)
  }

  private async persist(): Promise<void> {
    if (!this.draft) {
      return
    }
    const file = this.deps.sessionFile
    const body = JSON.stringify({ version: 1, cursor: this.cursor, history: this.history })
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(`${file}.tmp`, body, 'utf8')
      await rename(`${file}.tmp`, file)
      // Why: a discard while this write was in flight must not leave the draft to come back.
      if (!this.draft) {
        await rm(file, { force: true })
      }
    } catch (error) {
      console.warn('[theme-studio] could not save the session:', error)
    }
  }
}
