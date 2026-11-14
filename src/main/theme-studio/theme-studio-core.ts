import { randomUUID } from 'node:crypto'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  applyThemeStudioPatch,
  THEME_STUDIO_MODES,
  type ThemeStudioDraft,
  type ThemeStudioMode
} from '../../shared/theme-studio/theme-studio-draft'
import {
  THEME_STUDIO_ERROR_CODES,
  ThemeStudioError
} from '../../shared/theme-studio/theme-studio-errors'
import type {
  ThemeStudioReport,
  ThemeStudioResolveResult
} from '../../shared/theme-studio/theme-studio-protocol'
import type { OrcaChromeCapture } from '../plugins/view/plugin-view-chrome-shot'
import type { ThemeStudioSession, ThemeStudioStatus } from './theme-studio-session'
import {
  draftFromResolved,
  type InstalledThemes,
  type StartedDraft
} from './theme-studio-draft-sources'
import { fixPatch, paintOutcome, type ThemeStudioPaint } from './theme-studio-fixes'

export const REPORT_TIMEOUT_MS = 2_500
const MAX_RESTORE_POINTS = 8
const MAX_FIX_ROUNDS = 4

export const THEME_STUDIO_CAPABILITIES = [
  'draft',
  'check',
  'fix',
  'adjust',
  'separate',
  'shot',
  'terminal',
  'tokenColors',
  'history',
  'reset',
  'apply',
  'export'
] as const

export type ThemeStudioWindow = {
  resolve(): Promise<ThemeStudioResolveResult>
  /** Selects an installed theme plugin's themes for app and terminal, with Switch back. */
  select(pluginKey: string): Promise<boolean>
  capture(mode: ThemeStudioMode | undefined): Promise<OrcaChromeCapture>
}

export type ThemeStudioServiceDeps = {
  session: ThemeStudioSession
  /** Null on a host without a window, such as `orca serve`. */
  window: () => ThemeStudioWindow | null
  installedThemes: () => Promise<InstalledThemes>
  /** The folder an installed plugin came from, or null when it is not installed from one. */
  installedFrom: (pluginKey: string) => Promise<string | null>
  /** Installs a theme plugin folder like `orca plugin install <dir>`. */
  installFolder: (path: string) => Promise<{ pluginKey: string; version: string }>
  pluginsRoot: string
  /** Settings → Appearance "Let agents edit the theme". */
  agentEditsAllowed: () => boolean
  /** The theme slots in settings, read and written by main directly. */
  slots: {
    snapshot(): Partial<GlobalSettings>
    restore(previous: Partial<GlobalSettings>): void
  }
}

/** Who asked: `key` scopes the rate limit, `by` labels history ("claude · Terminal 2"). */
export type ThemeStudioCaller = { key: string; by?: string; ifRevision?: number }

export type ThemeStudioMutation = ThemeStudioStatus & {
  label: string
  changed?: Partial<Record<ThemeStudioMode, string[]>>
  skipped?: Partial<Record<ThemeStudioMode, string[]>>
  autoFixed?: number
  report: ThemeStudioReport | null
  paint: ThemeStudioPaint
}

function needsDesktop(): ThemeStudioError {
  return new ThemeStudioError(
    THEME_STUDIO_ERROR_CODES.needsDesktop,
    'This Orca has no window to paint a theme in.',
    {
      nextSteps: [
        'Run `orca theme` from a terminal of the Orca desktop app you look at, or pass `--environment` for an Orca desktop server.'
      ]
    }
  )
}

const changedModes = (
  changed: Partial<Record<ThemeStudioMode, string[]>> = {}
): ThemeStudioMode[] => THEME_STUDIO_MODES.filter((mode) => (changed[mode]?.length ?? 0) > 0)

/** What every theme change shares: the window, the draft start, and the reply it returns. */
export function createThemeStudioCore(deps: ThemeStudioServiceDeps) {
  const { session } = deps
  const requireWindow = (): ThemeStudioWindow => {
    const window = deps.window()
    if (!window) {
      throw needsDesktop()
    }
    return window
  }
  const currentDraft = async (name?: string): Promise<StartedDraft> =>
    draftFromResolved(await requireWindow().resolve(), name)

  async function mutation(
    label: string,
    extra: Partial<ThemeStudioMutation> = {}
  ): Promise<ThemeStudioMutation> {
    const revision = session.currentRevision
    const report = await session.waitForReport(REPORT_TIMEOUT_MS)
    const modes = extra.changed ? changedModes(extra.changed) : (session.status().modes ?? [])
    return {
      ...session.status(),
      label,
      ...extra,
      report,
      paint: paintOutcome(report, revision, modes, deps.window() !== null)
    }
  }

  /** Applies `change` to the open draft, or to one started from what Orca paints now; a refused
   *  change leaves no draft behind. */
  async function commitChange<T>(
    caller: ThemeStudioCaller,
    label: string,
    change: (draft: ThemeStudioDraft) => { draft: ThemeStudioDraft } & T
  ): Promise<T> {
    const open = session.draft
    const started = open ? null : await currentDraft()
    const result = change(open ?? started?.draft ?? session.requireDraft())
    if (started) {
      session.begin(started.draft, started.label, caller.by)
    }
    session.commit(result.draft, label, caller.by)
    return result
  }

  /** Applies the smallest fix of every finding into the current step; returns how many. */
  /** Applies the smallest fix of every finding, in rounds, into the current step, or into a new
   *  step `newStep` names once there is something to fix; returns how many were fixed. */
  async function fixIntoCurrentStep(newStep?: { label: string; by?: string }): Promise<number> {
    let total = 0
    for (let round = 0; round < MAX_FIX_ROUNDS; round += 1) {
      const { patch, fixed } = fixPatch(await session.waitForReport(REPORT_TIMEOUT_MS))
      if (fixed.length === 0) {
        break
      }
      const next = applyThemeStudioPatch(session.requireDraft(), patch).draft
      if (newStep && total === 0) {
        session.commit(next, newStep.label, newStep.by)
        session.amend(next, fixed.length)
      } else {
        session.amend(next, fixed.length)
      }
      total += fixed.length
    }
    return total
  }

  const restorePoints = new Map<string, Partial<GlobalSettings>>()
  let writingSlots = false
  /** Runs a studio write of the theme slots, so it is not mistaken for the person picking one. */
  async function writeSlots<T>(work: () => Promise<T>): Promise<T> {
    writingSlots = true
    try {
      return await work()
    } finally {
      writingSlots = false
    }
  }
  /** Keeps the slots a save replaces, so undoing the save can put them back. */
  function rememberSlots(): string {
    const token = randomUUID()
    restorePoints.set(token, deps.slots.snapshot())
    const oldest = restorePoints.keys().next().value
    if (restorePoints.size > MAX_RESTORE_POINTS && oldest !== undefined) {
      restorePoints.delete(oldest)
    }
    return token
  }
  function restoreSlots(token: string): void {
    const previous = restorePoints.get(token)
    if (!previous) {
      throw new ThemeStudioError(
        THEME_STUDIO_ERROR_CODES.historyEnd,
        'Orca restarted since saving, so it no longer knows the themes from before.',
        { nextSteps: ['Ask the user to pick their previous theme in Settings → Appearance.'] }
      )
    }
    deps.slots.restore(previous)
  }

  return {
    deps,
    session,
    requireWindow,
    currentDraft,
    mutation,
    commitChange,
    fixIntoCurrentStep,
    writeSlots,
    rememberSlots,
    restoreSlots,
    isWritingSlots: () => writingSlots
  }
}

export type ThemeStudioCore = ReturnType<typeof createThemeStudioCore>
