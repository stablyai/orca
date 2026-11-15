import { z } from 'zod'
import {
  themeStudioDraftSchema,
  type ThemeStudioDraft
} from '../../shared/theme-studio/theme-studio-draft'
import {
  THEME_STUDIO_ERROR_CODES,
  ThemeStudioError
} from '../../shared/theme-studio/theme-studio-errors'

export const MAX_THEME_STUDIO_HISTORY = 100

const savedSchema = z.object({
  pluginKey: z.string(),
  /** Names the slots saving replaced, kept by main; undoing the save puts them back. */
  restorePoint: z.string().max(64)
})

export const themeStudioEntrySchema = z.object({
  label: z.string().max(256),
  /** Who made the change: the agent and pane, when the caller named its terminal. */
  by: z.string().max(256).optional(),
  at: z.number(),
  draft: themeStudioDraftSchema,
  /** Contrast issues fixed as part of this change. */
  autoFixed: z.number().int().nonnegative().optional(),
  saved: savedSchema.optional()
})
export type ThemeStudioEntry = z.infer<typeof themeStudioEntrySchema>
export type ThemeStudioSaved = z.infer<typeof savedSchema>

export type ThemeStudioHistoryRow = {
  index: number
  label: string
  by?: string
  at: number
  current: boolean
  saved?: string
  autoFixed?: number
}

/** A linear undo stack of whole drafts; the first entry is where the draft started. */
export class ThemeStudioHistory {
  entries: ThemeStudioEntry[] = []
  cursor = -1

  get current(): ThemeStudioEntry | null {
    return this.entries[this.cursor] ?? null
  }

  restore(entries: ThemeStudioEntry[], cursor: number): void {
    this.entries = entries
    this.cursor = Math.min(cursor, entries.length - 1)
  }

  begin(entry: ThemeStudioEntry): void {
    this.entries = [entry]
    this.cursor = 0
  }

  /** Adds the next step; anything that was undone is dropped. The start stays when capped. */
  push(entry: ThemeStudioEntry): void {
    const kept = [...this.entries.slice(0, this.cursor + 1), entry]
    this.entries =
      kept.length > MAX_THEME_STUDIO_HISTORY
        ? [kept[0], ...kept.slice(kept.length - MAX_THEME_STUDIO_HISTORY + 1)]
        : kept
    this.cursor = this.entries.length - 1
  }

  /** Folds follow-up work (such as automatic contrast fixes) into the current step. */
  amend(draft: ThemeStudioDraft, autoFixed: number): void {
    const entry = this.current
    if (entry) {
      this.entries[this.cursor] = {
        ...entry,
        draft,
        autoFixed: (entry.autoFixed ?? 0) + autoFixed
      }
    }
  }

  /** The step left behind (undo) or reached (redo), without moving. */
  peek(direction: 'undo' | 'redo'): { from: ThemeStudioEntry; to: ThemeStudioEntry } {
    const from = this.current
    const to = this.entries[direction === 'undo' ? this.cursor - 1 : this.cursor + 1]
    if (!from || !to) {
      throw new ThemeStudioError(
        THEME_STUDIO_ERROR_CODES.historyEnd,
        direction === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.',
        { nextSteps: ['Run `orca theme history --json` to see the steps.'] }
      )
    }
    return { from, to }
  }

  /** Moves one step and returns the step left behind (undo) or reached (redo). */
  step(direction: 'undo' | 'redo'): { from: ThemeStudioEntry; to: ThemeStudioEntry } {
    const moved = this.peek(direction)
    this.cursor += direction === 'undo' ? -1 : 1
    return moved
  }

  clear(): void {
    this.entries = []
    this.cursor = -1
  }

  rows(): ThemeStudioHistoryRow[] {
    return this.entries.map((entry, index) => ({
      index,
      label: entry.label,
      ...(entry.by ? { by: entry.by } : {}),
      at: entry.at,
      current: index === this.cursor,
      ...(entry.saved ? { saved: entry.saved.pluginKey } : {}),
      ...(entry.autoFixed ? { autoFixed: entry.autoFixed } : {})
    }))
  }
}
