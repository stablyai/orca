import type { z } from 'zod'
import {
  adjustThemeStudioVariant,
  applyThemeStudioPatch,
  THEME_STUDIO_MODES,
  type ThemeStudioDraft,
  type ThemeStudioMode,
  type ThemeStudioPatch
} from '../../shared/theme-studio/theme-studio-draft'
import {
  THEME_STUDIO_ERROR_CODES,
  ThemeStudioError
} from '../../shared/theme-studio/theme-studio-errors'
import type {
  ThemeStudioReport,
  ThemeStudioResolveResult
} from '../../shared/theme-studio/theme-studio-protocol'
import type {
  ThemeStudioAdjustParams,
  ThemeStudioEditParams
} from '../../shared/rpc-contract/theme-studio/theme-studio-params'
import type { OrcaChromeCapture } from '../plugins/view/plugin-view-chrome-shot'
import type { ThemeStudioSession, ThemeStudioStatus } from './theme-studio-session'
import {
  draftFromInstalled,
  draftFromResolved,
  withName,
  type InstalledThemes,
  type StartedDraft
} from './theme-studio-draft-sources'
import { writeThemeStudioPlugin } from './theme-studio-plugin-save'

// Why 2.5s: a paint and two contrast checks take milliseconds; this only covers a busy window.
const REPORT_TIMEOUT_MS = 2_500
const MAX_FIX_ROUNDS = 4

export type ThemeStudioWindow = {
  resolve(): Promise<ThemeStudioResolveResult>
  /** Selects an installed theme plugin's themes as the user's, with a toast to switch back. */
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
}

export type ThemeStudioMutation = ThemeStudioStatus & {
  label: string
  changed?: Partial<Record<ThemeStudioMode, string[]>>
  skipped?: Partial<Record<ThemeStudioMode, string[]>>
  report: ThemeStudioReport | null
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

function fixesFrom(report: ThemeStudioReport | null): ThemeStudioPatch {
  const edit: ThemeStudioPatch = {}
  for (const { mode, issues } of report?.modes ?? []) {
    const set: Record<string, string> = {}
    for (const { fix } of issues) {
      if (fix && !(fix.token in set)) {
        set[fix.token] = fix.value
      }
    }
    if (Object.keys(set).length) {
      edit[mode] = { set }
    }
  }
  return edit
}

export function createThemeStudioService(deps: ThemeStudioServiceDeps) {
  const { session } = deps
  // Why one queue: two agents (or a burst) must not both start a draft or interleave a fix loop.
  let queue: Promise<unknown> = session.ready
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
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
    const report = await session.waitForReport(REPORT_TIMEOUT_MS)
    return { ...session.status(), label, ...extra, report }
  }

  /** The open draft, or one started from what Orca paints now. */
  async function ensureDraft(): Promise<ThemeStudioDraft> {
    requireWindow()
    if (session.draft) {
      return session.draft
    }
    const { draft, label } = await currentDraft()
    session.begin(draft, label)
    return draft
  }

  async function edit(params: z.infer<typeof ThemeStudioEditParams>): Promise<ThemeStudioMutation> {
    requireWindow()
    const { from } = params
    const started =
      from.kind === 'current'
        ? await currentDraft(params.name)
        : from.kind === 'installed'
          ? draftFromInstalled(await deps.installedThemes(), from.target, params.name)
          : { draft: withName(from.draft, params.name), label: `Start from ${from.draft.name}` }
    if (!started.draft.light && !started.draft.dark) {
      throw new ThemeStudioError(
        THEME_STUDIO_ERROR_CODES.invalid,
        'The theme has no light or dark variant.',
        { nextSteps: ['Pass a theme plugin folder or a theme JSON file with `base` and `tokens`.'] }
      )
    }
    session.begin(started.draft, started.label)
    return mutation(started.label)
  }

  async function patch(change: ThemeStudioPatch, label: string): Promise<ThemeStudioMutation> {
    const { draft, changed } = applyThemeStudioPatch(await ensureDraft(), change)
    session.commit(draft, label)
    return mutation(label, { changed })
  }

  async function adjust(
    params: z.infer<typeof ThemeStudioAdjustParams>
  ): Promise<ThemeStudioMutation> {
    const draft = await ensureDraft()
    const next: ThemeStudioDraft = { ...draft }
    const changed: Partial<Record<ThemeStudioMode, string[]>> = {}
    const skipped: Partial<Record<ThemeStudioMode, string[]>> = {}
    for (const mode of params.modes) {
      const variant = draft[mode]
      if (!variant) {
        continue
      }
      const adjusted = adjustThemeStudioVariant(variant, params.adjustment, params.only)
      next[mode] = adjusted.variant
      changed[mode] = adjusted.changed
      if (adjusted.skipped.length) {
        skipped[mode] = adjusted.skipped
      }
    }
    const label = `Adjust ${Object.entries(params.adjustment)
      .map(([key, value]) => `${key} ${value}`)
      .join(', ')}`
    session.commit(next, label)
    return mutation(label, { changed, ...(Object.keys(skipped).length ? { skipped } : {}) })
  }

  async function check(fix: boolean): Promise<ThemeStudioMutation> {
    requireWindow()
    session.requireDraft()
    if (!fix) {
      return mutation('Check')
    }
    const fixed: Partial<Record<ThemeStudioMode, string[]>> = {}
    // Why rounds: a fixed color can expose the next pair the check had not reached yet.
    for (let round = 0; round < MAX_FIX_ROUNDS; round += 1) {
      const fixes = fixesFrom(await session.waitForReport(REPORT_TIMEOUT_MS))
      if (Object.keys(fixes).length === 0) {
        break
      }
      for (const mode of THEME_STUDIO_MODES) {
        const keys = Object.keys(fixes[mode]?.set ?? {})
        if (keys.length) {
          fixed[mode] = [...new Set([...(fixed[mode] ?? []), ...keys])]
        }
      }
      session.commit(applyThemeStudioPatch(session.requireDraft(), fixes).draft, 'Fix contrast')
    }
    return mutation('Fix contrast', { changed: fixed })
  }

  async function apply(name: string | undefined) {
    const window = requireWindow()
    const draft = withName(session.requireDraft(), name)
    const { folder, replaced } = await writeThemeStudioPlugin(
      draft,
      deps.pluginsRoot,
      deps.installedFrom
    )
    const installed = await deps.installFolder(folder)
    const selected = await window.select(installed.pluginKey)
    session.end()
    return {
      ...installed,
      name: draft.name,
      folder,
      replaced,
      selected,
      modes: THEME_STUDIO_MODES.filter((mode) => draft[mode] !== null)
    }
  }

  return {
    async status(options: { resolved: boolean; report: boolean }) {
      await session.ready
      const draft = session.draft
      const window = deps.window()
      return {
        ...session.status(),
        draft,
        hasWindow: window !== null,
        ...(options.resolved && window ? { resolved: await window.resolve() } : {}),
        ...(options.report && draft && window
          ? { report: await session.waitForReport(REPORT_TIMEOUT_MS) }
          : {})
      }
    },
    edit: (params: z.infer<typeof ThemeStudioEditParams>) => exclusive(() => edit(params)),
    patch: (change: ThemeStudioPatch, label: string) => exclusive(() => patch(change, label)),
    adjust: (params: z.infer<typeof ThemeStudioAdjustParams>) => exclusive(() => adjust(params)),
    check: (fix: boolean) => exclusive(() => check(fix)),
    step: (direction: 'undo' | 'redo') =>
      exclusive(async () => {
        requireWindow()
        const label = session.step(direction)
        return mutation(`${direction === 'undo' ? 'Undo' : 'Redo'} ${label}`)
      }),
    shot: (mode: ThemeStudioMode | undefined) =>
      exclusive(async () => {
        const window = requireWindow()
        if (session.draft) {
          await session.waitForReport(REPORT_TIMEOUT_MS)
        }
        return { draft: session.draft !== null, ...(await window.capture(mode)) }
      }),
    apply: (name: string | undefined) => exclusive(() => apply(name)),
    discard: () =>
      exclusive(async () => {
        const status = session.status()
        session.end()
        return { discarded: status.active, name: status.name }
      }),
    /** The user pressed Keep on the preview notice; a failure shows the notice again. */
    keepFromWindow: (): Promise<void> =>
      exclusive(async () => {
        await apply(undefined)
      }).catch((error: unknown) => {
        console.warn('[theme-studio] could not keep the draft:', error)
        session.repaint()
      }),
    discardFromWindow: (): Promise<void> => exclusive(async () => session.end())
  }
}

export type ThemeStudioService = ReturnType<typeof createThemeStudioService>
