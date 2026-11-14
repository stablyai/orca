import type { z } from 'zod'
import {
  adjustThemeStudioVariant,
  applyThemeStudioPatch,
  THEME_STUDIO_MODES,
  type ThemeStudioDraft,
  type ThemeStudioMode
} from '../../shared/theme-studio/theme-studio-draft'
import { separateThemeStudioVariant } from '../../shared/theme-studio/theme-studio-separate'
import {
  THEME_STUDIO_ERROR_CODES,
  ThemeStudioError
} from '../../shared/theme-studio/theme-studio-errors'
import type {
  ThemeStudioAdjustParams,
  ThemeStudioEditParams
} from '../../shared/rpc-contract/theme-studio/theme-studio-params'
import { draftFromInstalled, withName } from './theme-studio-draft-sources'
import { writeThemeStudioPlugin } from './theme-studio-plugin-save'
import { fixPatch } from './theme-studio-fixes'
import {
  REPORT_TIMEOUT_MS,
  type ThemeStudioCaller,
  type ThemeStudioCore,
  type ThemeStudioMutation
} from './theme-studio-core'

// Each change runs inside the service's queue, after its guards.

export async function editDraft(
  core: ThemeStudioCore,
  params: z.infer<typeof ThemeStudioEditParams>,
  caller: ThemeStudioCaller
): Promise<ThemeStudioMutation> {
  const { from } = params
  const started =
    from.kind === 'current'
      ? await core.currentDraft(params.name)
      : from.kind === 'installed'
        ? draftFromInstalled(await core.deps.installedThemes(), from.target, params.name)
        : { draft: withName(from.draft, params.name), label: `Start from ${from.draft.name}` }
  if (!started.draft.light && !started.draft.dark) {
    throw new ThemeStudioError(
      THEME_STUDIO_ERROR_CODES.invalid,
      'The theme has no light or dark variant.',
      { nextSteps: ['Pass a theme plugin folder or a theme JSON file with `base` and `tokens`.'] }
    )
  }
  core.session.begin(started.draft, started.label, caller.by)
  return core.mutation(started.label)
}

export async function adjustDraft(
  core: ThemeStudioCore,
  params: z.infer<typeof ThemeStudioAdjustParams>,
  caller: ThemeStudioCaller
): Promise<ThemeStudioMutation> {
  const { separate } = params
  const parts = [
    ...Object.entries(params.adjustment).map(([key, value]) => `${key} ${value}`),
    ...(separate ? [`separate ${separate.scope} ${separate.amount}`] : [])
  ]
  const label = `Adjust ${parts.join(', ')}`
  const { changed, skipped } = await core.commitChange(caller, label, (draft) => {
    const next: ThemeStudioDraft = { ...draft }
    const changedKeys: Partial<Record<ThemeStudioMode, string[]>> = {}
    const skippedKeys: Partial<Record<ThemeStudioMode, string[]>> = {}
    for (const mode of params.modes) {
      let variant = draft[mode]
      if (!variant) {
        continue
      }
      const keys: string[] = []
      if (Object.keys(params.adjustment).length) {
        const adjusted = adjustThemeStudioVariant(variant, params.adjustment, params.only)
        variant = adjusted.variant
        keys.push(...adjusted.changed)
        if (adjusted.skipped.length) {
          skippedKeys[mode] = adjusted.skipped
        }
      }
      if (separate) {
        const moved = separateThemeStudioVariant(variant, separate.scope, separate.amount)
        variant = moved.variant
        keys.push(...moved.changed.filter((key) => !keys.includes(key)))
      }
      next[mode] = variant
      changedKeys[mode] = keys
    }
    return { draft: next, changed: changedKeys, skipped: skippedKeys }
  })
  const autoFixed = params.fix === false ? 0 : await core.fixIntoCurrentStep()
  return core.mutation(label, {
    changed,
    ...(Object.keys(skipped).length ? { skipped } : {}),
    ...(autoFixed ? { autoFixed } : {})
  })
}

export async function checkDraft(
  core: ThemeStudioCore,
  fix: boolean,
  ids: readonly string[] | undefined,
  caller: ThemeStudioCaller
) {
  core.session.requireDraft()
  if (!fix) {
    return core.mutation('Check')
  }
  if (!ids?.length) {
    const autoFixed = await core.fixIntoCurrentStep({ label: 'Fix contrast', by: caller.by })
    return core.mutation(autoFixed ? 'Fix contrast' : 'Check', { autoFixed })
  }
  const report = await core.session.waitForReport(REPORT_TIMEOUT_MS)
  if (!report) {
    throw new ThemeStudioError(
      THEME_STUDIO_ERROR_CODES.invalid,
      'The window did not report its contrast check in time.',
      { nextSteps: ['Run the same command again.'] }
    )
  }
  const { patch, fixed } = fixPatch(report, new Set(ids))
  if (fixed.length === 0) {
    throw new ThemeStudioError(THEME_STUDIO_ERROR_CODES.invalid, `No fix for ${ids.join(', ')}.`, {
      nextSteps: ['Run `orca theme check --json` for the current finding ids.']
    })
  }
  const label = `Fix ${fixed.length} contrast finding${fixed.length === 1 ? '' : 's'}`
  core.session.commit(
    applyThemeStudioPatch(core.session.requireDraft(), patch).draft,
    label,
    caller.by
  )
  return core.mutation(label, { autoFixed: fixed.length })
}

/** Undo/redo; stepping across a save puts back or re-selects the saved theme first, so a
 *  failure leaves history where it was. */
export async function stepDraft(
  core: ThemeStudioCore,
  direction: 'undo' | 'redo'
): Promise<ThemeStudioMutation> {
  const window = core.requireWindow()
  const { from, to } = core.session.peek(direction)
  if (direction === 'undo' && from.saved) {
    const { restorePoint } = from.saved
    await core.writeSlots(async () => core.restoreSlots(restorePoint))
  } else if (direction === 'redo' && to.saved) {
    const { pluginKey } = to.saved
    await core.writeSlots(() => window.select(pluginKey))
  }
  core.session.step(direction)
  return core.mutation(
    `${direction === 'undo' ? 'Undo' : 'Redo'} ${(direction === 'undo' ? from : to).label}`
  )
}

export async function applyDraft(core: ThemeStudioCore, name: string | undefined, by?: string) {
  const window = core.requireWindow()
  const draft = withName(core.session.requireDraft(), name)
  const { folder, replaced } = await writeThemeStudioPlugin(
    draft,
    core.deps.pluginsRoot,
    core.deps.installedFrom
  )
  const installed = await core.deps.installFolder(folder)
  const restorePoint = core.rememberSlots()
  const selected = await core.writeSlots(() => window.select(installed.pluginKey))
  core.session.markSaved(
    `Save as ${draft.name}`,
    { pluginKey: installed.pluginKey, restorePoint },
    by
  )
  return {
    ...installed,
    name: draft.name,
    folder,
    replaced,
    selected,
    revision: core.session.currentRevision,
    modes: THEME_STUDIO_MODES.filter((mode) => draft[mode] !== null)
  }
}
