import { rm, stat } from 'node:fs/promises'
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
import {
  sameFolder,
  writeThemeStudioFiles,
  writeThemeStudioPlugin
} from './theme-studio-plugin-save'
import type { ThemeStudioCore } from './theme-studio-core'

const COPY_SUFFIX = ' copy'
const MAX_NAME_LENGTH = 64
const MAX_FREE_NAME_ATTEMPTS = 50

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

/** Drops saved entries whose plugin is gone or now comes from another folder, so the Custom
 *  badge and Delete never reach a plugin `orca theme` did not write. */
export async function reconcileSavedThemes(core: ThemeStudioCore): Promise<void> {
  const { deps } = core
  await deps.savedThemes.ready
  for (const entry of deps.savedThemes.entriesNow()) {
    const owner = await deps.installedFrom(entry.pluginKey)
    if (owner === null || !(await sameFolder(owner, join(deps.pluginsRoot, entry.id)))) {
      deps.savedThemes.remove(entry.pluginKey)
    }
  }
}

/** "Ember copy", then "Ember copy 2", … among the saved names. */
function copyName(name: string, taken: ReadonlySet<string>): string {
  const base = `${name.slice(0, MAX_NAME_LENGTH - COPY_SUFFIX.length - 3)}${COPY_SUFFIX}`
  for (let index = 1; index < MAX_FREE_NAME_ATTEMPTS; index += 1) {
    const candidate = index === 1 ? base : `${base} ${index}`
    if (!taken.has(candidate)) {
      return candidate
    }
  }
  return base
}

/** A folder under `parent` that does not exist yet, so an export never replaces anything. */
async function freeFolder(parent: string, id: string): Promise<string> {
  for (let index = 1; index < MAX_FREE_NAME_ATTEMPTS; index += 1) {
    const folder = join(parent, index === 1 ? id : `${id}-${index}`)
    if (!(await exists(folder))) {
      return folder
    }
  }
  throw new ThemeStudioError(THEME_STUDIO_ERROR_CODES.invalid, `${parent} has too many exports.`, {
    nextSteps: ['Pick another folder.']
  })
}

/** Rename, Duplicate, Export and Delete for a theme `orca theme` saved, from Settings. */
export async function runSavedThemeAction(
  core: ThemeStudioCore,
  request: ThemeStudioSavedAction
): Promise<ThemeStudioSavedActionResult> {
  const { deps } = core
  await reconcileSavedThemes(core)
  const entry = deps.savedThemes.find(request.pluginKey)
  if (!entry) {
    throw new ThemeStudioError(
      THEME_STUDIO_ERROR_CODES.invalid,
      'This theme was not made with `orca theme`.',
      { nextSteps: ['Manage it in Settings → Plugins instead.'] }
    )
  }
  switch (request.action) {
    case 'rename': {
      const draft = { ...entry.draft, name: request.name }
      // Why strict: a rename that moved to another id would switch the person's theme.
      const { folder } = await writeThemeStudioPlugin(draft, deps.pluginsRoot, deps.installedFrom, {
        id: entry.id,
        strict: true
      })
      await deps.installFolder(folder)
      deps.savedThemes.record({ ...entry, name: request.name, draft })
      return { ok: true, pluginKey: entry.pluginKey }
    }
    case 'duplicate': {
      const name = copyName(entry.name, new Set(deps.savedThemes.list().map((theme) => theme.name)))
      const draft = { ...entry.draft, name }
      const { folder, id } = await writeThemeStudioPlugin(
        draft,
        deps.pluginsRoot,
        deps.installedFrom,
        {
          fresh: true
        }
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
        return { ok: false, cancelled: true }
      }
      const folder = await freeFolder(parent, entry.id)
      await writeThemeStudioFiles(folder, themeStudioPluginFiles(entry.draft, entry.id).files)
      return { ok: true, path: folder }
    }
    case 'delete': {
      const { restorePoint } = entry
      // Why inside writeSlots: removing the plugin also clears its slots, which is not the
      // person picking another theme.
      const restored = await core.writeSlots(async () => {
        // Why restore first: while this run still knows the themes before the save, go back to them.
        const back =
          restorePoint !== undefined &&
          (() => {
            try {
              core.restoreSlots(restorePoint, entry.pluginKey)
              return true
            } catch {
              return false
            }
          })()
        await deps.uninstall(entry.pluginKey)
        return back
      })
      deps.savedThemes.remove(entry.pluginKey)
      await rm(join(deps.pluginsRoot, entry.id), { recursive: true, force: true })
      return { ok: true, restored }
    }
  }
}
