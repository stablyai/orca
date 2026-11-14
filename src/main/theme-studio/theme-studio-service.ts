import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
import { themeStudioPluginFiles } from '../../shared/theme-studio/theme-studio-plugin-files'
import { parsePluginAppThemeArtifact } from '../../shared/plugins/artifacts/plugin-theme-artifact'
import { parsePluginTerminalThemeArtifact } from '../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
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

export function createThemeStudioService(deps: ThemeStudioServiceDeps) {
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
  const installedDraft = async (target: string, name?: string): Promise<StartedDraft> =>
    draftFromInstalled(await deps.installedThemes(), target, name)

  async function mutation(
    label: string,
    extra: Partial<ThemeStudioMutation> = {}
  ): Promise<ThemeStudioMutation> {
    const report = await session.waitForReport(REPORT_TIMEOUT_MS)
    return { ...session.status(), label, ...extra, report }
  }

  /** The open draft, or one started from what Orca paints now. */
  async function ensureDraft(): Promise<ThemeStudioDraft> {
    if (session.draft) {
      return session.draft
    }
    const { draft, label } = await currentDraft()
    session.begin(draft, label)
    return draft
  }

  async function patch(edit: ThemeStudioPatch, label: string): Promise<ThemeStudioMutation> {
    requireWindow()
    const draft = await ensureDraft()
    const { draft: next, changed } = applyThemeStudioPatch(draft, edit)
    session.commit(next, label)
    return mutation(label, { changed })
  }

  return {
    async status(resolved: boolean) {
      const status = session.status()
      const draft = session.draft
      const window = deps.window()
      return {
        ...status,
        draft,
        hasWindow: window !== null,
        ...(resolved && window ? { resolved: await window.resolve() } : {}),
        ...(draft && window ? { report: await session.waitForReport(REPORT_TIMEOUT_MS) } : {})
      }
    },

    async edit(params: z.infer<typeof ThemeStudioEditParams>): Promise<ThemeStudioMutation> {
      requireWindow()
      const { from } = params
      const started =
        from.kind === 'current'
          ? await currentDraft(params.name)
          : from.kind === 'installed'
            ? await installedDraft(from.target, params.name)
            : { draft: withName(from.draft, params.name), label: `Start from ${from.draft.name}` }
      if (!started.draft.light && !started.draft.dark) {
        throw new ThemeStudioError(
          THEME_STUDIO_ERROR_CODES.invalid,
          'The theme has no light or dark variant.',
          {
            nextSteps: ['Pass a theme plugin folder or a theme JSON file with `base` and `tokens`.']
          }
        )
      }
      session.begin(started.draft, started.label)
      return mutation(started.label)
    },

    patch,

    async adjust(params: z.infer<typeof ThemeStudioAdjustParams>): Promise<ThemeStudioMutation> {
      requireWindow()
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
    },

    async check(fix: boolean): Promise<ThemeStudioMutation> {
      requireWindow()
      session.requireDraft()
      if (!fix) {
        return mutation('Check')
      }
      const fixed: Partial<Record<ThemeStudioMode, string[]>> = {}
      for (let round = 0; round < MAX_FIX_ROUNDS; round += 1) {
        const report = await session.waitForReport(REPORT_TIMEOUT_MS)
        const edit: ThemeStudioPatch = {}
        for (const { mode, issues } of report?.modes ?? []) {
          const set: Record<string, string> = {}
          for (const issue of issues) {
            if (issue.fix && !(issue.fix.token in set)) {
              set[issue.fix.token] = issue.fix.value
            }
          }
          if (Object.keys(set).length) {
            edit[mode] = { set }
            fixed[mode] = [...new Set([...(fixed[mode] ?? []), ...Object.keys(set)])]
          }
        }
        if (Object.keys(edit).length === 0) {
          break
        }
        session.commit(applyThemeStudioPatch(session.requireDraft(), edit).draft, 'Fix contrast')
      }
      return mutation('Fix contrast', { changed: fixed })
    },

    async step(direction: 'undo' | 'redo'): Promise<ThemeStudioMutation> {
      requireWindow()
      const label = session.step(direction)
      return mutation(`${direction === 'undo' ? 'Undo' : 'Redo'} ${label}`)
    },

    async shot(mode: ThemeStudioMode | undefined) {
      const window = requireWindow()
      if (session.draft) {
        await session.waitForReport(REPORT_TIMEOUT_MS)
      }
      return { draft: session.draft !== null, ...(await window.capture(mode)) }
    },

    async apply(name: string | undefined) {
      const window = requireWindow()
      const draft = withName(session.requireDraft(), name)
      const { id, files } = themeStudioPluginFiles(draft)
      const folder = join(deps.pluginsRoot, id)
      // Why check before writing: a draft that would not load must never replace a saved theme.
      for (const [path, text] of Object.entries(files)) {
        if (path.startsWith('themes/')) {
          parsePluginAppThemeArtifact(text, 'strict')
        } else if (path.startsWith('terminal/')) {
          parsePluginTerminalThemeArtifact(text, 'strict')
        }
      }
      await rm(folder, { recursive: true, force: true })
      for (const [path, text] of Object.entries(files)) {
        const file = join(folder, ...path.split('/'))
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, text, 'utf8')
      }
      const installed = await deps.installFolder(folder)
      const selected = await window.select(installed.pluginKey)
      session.end()
      return {
        ...installed,
        name: draft.name,
        folder,
        selected,
        modes: THEME_STUDIO_MODES.filter((mode) => draft[mode] !== null)
      }
    },

    discard() {
      const status = session.status()
      session.end()
      return { discarded: status.active, name: status.name }
    }
  }
}

export type ThemeStudioService = ReturnType<typeof createThemeStudioService>
