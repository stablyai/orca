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
  /** Selects an installed theme plugin's themes, returning the settings it replaced. */
  select(pluginKey: string): Promise<{ selected: boolean; previous: Record<string, unknown> }>
  /** Puts back settings a `select` replaced. */
  restore(settings: Record<string, unknown>): Promise<void>
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
  async function fixIntoCurrentStep(): Promise<number> {
    let total = 0
    for (let round = 0; round < MAX_FIX_ROUNDS; round += 1) {
      const { patch, fixed } = fixPatch(await session.waitForReport(REPORT_TIMEOUT_MS))
      if (fixed.length === 0) {
        break
      }
      session.amend(applyThemeStudioPatch(session.requireDraft(), patch).draft, fixed.length)
      total += fixed.length
    }
    return total
  }

  return { deps, session, requireWindow, currentDraft, mutation, commitChange, fixIntoCurrentStep }
}

export type ThemeStudioCore = ReturnType<typeof createThemeStudioCore>
