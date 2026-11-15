import { join } from 'node:path'
import type {
  ThemeStudioSavedAction,
  ThemeStudioSavedActionResult
} from '../../shared/theme-studio/theme-studio-protocol'
import { themeStudioPluginFiles } from '../../shared/theme-studio/theme-studio-plugin-files'
import {
  THEME_STUDIO_ERROR_CODES,
  ThemeStudioError
} from '../../shared/theme-studio/theme-studio-errors'
import { writeThemeStudioFiles, writeThemeStudioPlugin } from './theme-studio-plugin-save'
import type { ThemeStudioCore } from './theme-studio-core'

const COPY_SUFFIX = ' copy'
const MAX_NAME_LENGTH = 64

/** Rename, Duplicate, Export and Delete for a theme `orca theme` saved, from Settings. */
export async function runSavedThemeAction(
  core: ThemeStudioCore,
  request: ThemeStudioSavedAction
): Promise<ThemeStudioSavedActionResult> {
  const { deps } = core
  const entry = deps.savedThemes.find(request.pluginKey)
  if (!entry) {
    throw new ThemeStudioError(
      THEME_STUDIO_ERROR_CODES.invalid,
      'This theme was not made with `orca theme`.',
      {
        nextSteps: ['Manage it in Settings → Plugins instead.']
      }
    )
  }
  switch (request.action) {
    case 'rename': {
      const draft = { ...entry.draft, name: request.name }
      // Why the same id: the slots keep pointing at it, so a rename never switches themes.
      const { folder, id } = await writeThemeStudioPlugin(
        draft,
        deps.pluginsRoot,
        deps.installedFrom,
        { id: entry.id }
      )
      const installed = await deps.installFolder(folder)
      deps.savedThemes.record({
        ...entry,
        pluginKey: installed.pluginKey,
        id,
        name: request.name,
        draft
      })
      return { ok: true, pluginKey: installed.pluginKey }
    }
    case 'duplicate': {
      const name = `${entry.name.slice(0, MAX_NAME_LENGTH - COPY_SUFFIX.length)}${COPY_SUFFIX}`
      const draft = { ...entry.draft, name }
      const { folder, id } = await writeThemeStudioPlugin(
        draft,
        deps.pluginsRoot,
        deps.installedFrom,
        { fresh: true }
      )
      const installed = await deps.installFolder(folder)
      deps.savedThemes.record({
        pluginKey: installed.pluginKey,
        id,
        name,
        by: 'you',
        savedAt: Date.now(),
        draft
      })
      return { ok: true, pluginKey: installed.pluginKey }
    }
    case 'export': {
      const parent = await deps.chooseExportFolder(entry.id)
      if (!parent) {
        return { ok: false, message: 'cancelled' }
      }
      const folder = join(parent, entry.id)
      await writeThemeStudioFiles(folder, themeStudioPluginFiles(entry.draft, entry.id).files)
      return { ok: true, path: folder }
    }
    case 'delete': {
      // Why restore first: while this run still knows the themes before the save, go back to them.
      const restored =
        entry.restorePoint !== undefined &&
        (await core
          .writeSlots(async () => core.restoreSlots(entry.restorePoint ?? ''))
          .then(
            () => true,
            () => false
          ))
      await deps.uninstall(entry.pluginKey)
      deps.savedThemes.remove(entry.pluginKey)
      return { ok: true, restored }
    }
  }
}
