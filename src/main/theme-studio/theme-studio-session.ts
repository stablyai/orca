import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  THEME_STUDIO_MODES,
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
import {
  MAX_THEME_STUDIO_HISTORY,
  ThemeStudioHistory,
  themeStudioEntrySchema,
  type ThemeStudioEntry,
  type ThemeStudioHistoryRow,
  type ThemeStudioSaved
} from './theme-studio-history'

// Why a frame: steps inside one command (start, change, fix rounds) paint once.
const PUSH_COALESCE_MS = 16
const PERSIST_DEBOUNCE_MS = 250
const MAX_WAITERS = 64

const persistedSessionSchema = z.object({
  version: z.literal(1),
  cursor: z.number().int().nonnegative(),
  history: z.array(themeStudioEntrySchema).min(1).max(MAX_THEME_STUDIO_HISTORY)
})

export type ThemeStudioStatus = {
  active: boolean
  name: string | null
  revision: number
  modes: ThemeStudioMode[]
  undo: number
  redo: number
  /** Oldest first; `current` marks where undo and redo stand. */
  history: ThemeStudioHistoryRow[]
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
  private readonly history = new ThemeStudioHistory()
  // Why a random start: a revision from before a restart must not match by accident.
  private revision = Math.floor(Math.random() * 1_000) * 1_000
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persisting: Promise<void> = Promise.resolve()
  private latestReport: ThemeStudioReport | null = null
  private waiters: { revision: number; resolve: (report: ThemeStudioReport | null) => void }[] = []
  /** Set when the person ended the draft; cleared only when an agent starts a new one. */
  private endedByUser: string | null = null
  /** Settles once a session a restart interrupted is restored; edits wait for it. */
  readonly ready: Promise<void>

  constructor(private readonly deps: ThemeStudioSessionDeps) {
    this.ready = this.restore()
  }

  private async restore(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.deps.sessionFile, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = persistedSessionSchema.parse(JSON.parse(raw))
      this.history.restore(parsed.history, parsed.cursor)
      this.revision += 1
      this.schedulePush()
    } catch (error) {
      console.warn('[theme-studio] dropping an unreadable session:', error)
      await rm(this.deps.sessionFile, { force: true }).catch(() => undefined)
    }
  }

  /** The draft being previewed; null when none is open or the current step is a save. */
  get draft(): ThemeStudioDraft | null {
    const entry = this.history.current
    return entry && !entry.saved ? entry.draft : null
  }

  /** The current step, previewed or saved. */
  get current(): ThemeStudioEntry | null {
    return this.history.current
  }

  get start(): ThemeStudioDraft | null {
    return this.history.entries[0]?.draft ?? null
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

  /** Why the person ended the last draft; agents are refused until one explicitly starts anew. */
  get endedByUserReason(): string | null {
    return this.endedByUser
  }

  status(): ThemeStudioStatus {
    const draft = this.draft
    const { cursor, entries } = this.history
    return {
      active: draft !== null,
      name: this.history.current?.draft.name ?? null,
      revision: this.revision,
      modes: draft ? THEME_STUDIO_MODES.filter((mode) => draft[mode] !== null) : [],
      undo: Math.max(0, cursor),
      redo: Math.max(0, entries.length - 1 - cursor),
      history: this.history.rows()
    }
  }

  begin(draft: ThemeStudioDraft, label: string, by?: string): void {
    this.endedByUser = null
    this.history.begin(entry(draft, label, by))
    this.changed()
  }

  commit(draft: ThemeStudioDraft, label: string, by?: string): void {
    this.history.push(entry(draft, label, by))
    this.changed()
  }

  /** Folds automatic fixes into the current step, so one change stays one undo. */
  amend(draft: ThemeStudioDraft, autoFixed: number): void {
    this.history.amend(draft, autoFixed)
    this.changed()
  }

  /** Records a save as a step; the preview ends while the saved theme is in use. */
  markSaved(label: string, saved: ThemeStudioSaved, by?: string): void {
    const draft = this.requireDraft()
    this.history.push({ ...entry(draft, label, by), saved })
    this.changed()
  }

  peek(direction: 'undo' | 'redo'): { from: ThemeStudioEntry; to: ThemeStudioEntry } {
    return this.history.peek(direction)
  }

  step(direction: 'undo' | 'redo'): { from: ThemeStudioEntry; to: ThemeStudioEntry } {
    const moved = this.history.step(direction)
    this.changed()
    return moved
  }

  /** Ends the session: the preview stops and nothing more is kept. */
  end(by: 'agent' | 'user', reason = 'Discarded'): void {
    this.history.clear()
    this.endedByUser = by === 'user' ? reason : null
    this.latestReport = null
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    // Why queued: a write still in flight must not land after the file is gone.
    this.persisting = this.persisting.then(() =>
      rm(this.deps.sessionFile, { force: true }).catch(() => undefined)
    )
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
        this.waiters = this.waiters.filter((other) => other !== waiter)
        resolve(null)
      }, timeoutMs)
      timer.unref?.()
      this.waiters.push(waiter)
    })
  }

  /** Re-sends the current preview, e.g. after a failed Keep closed the notice. */
  repaint(): void {
    this.schedulePush()
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

  /** What the window should paint now, with the notice's details. */
  preview(): ThemeStudioPreview {
    const draft = this.draft
    const current = this.history.current
    if (!draft || !current) {
      return null
    }
    return {
      revision: this.revision,
      draft,
      last: {
        label: current.label,
        ...(current.by ? { by: current.by } : {}),
        ...(current.autoFixed ? { autoFixed: current.autoFixed } : {})
      },
      canUndo: this.history.cursor > 0
    }
  }

  private schedulePush(): void {
    if (this.pushTimer) {
      return
    }
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.deps.push(this.preview())
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

  private persist(): Promise<void> {
    // Why chained: a slow disk must not let two writes share the temporary file.
    this.persisting = this.persisting.then(() => this.writeSession())
    return this.persisting
  }

  private async writeSession(): Promise<void> {
    if (!this.history.current) {
      return
    }
    const file = this.deps.sessionFile
    const body = JSON.stringify({
      version: 1,
      cursor: this.history.cursor,
      history: this.history.entries
    })
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(`${file}.tmp`, body, 'utf8')
      await rename(`${file}.tmp`, file)
    } catch (error) {
      console.warn('[theme-studio] could not save the session:', error)
    }
  }
}

function entry(draft: ThemeStudioDraft, label: string, by: string | undefined): ThemeStudioEntry {
  return { label: label.slice(0, 256), ...(by ? { by } : {}), at: Date.now(), draft }
}
