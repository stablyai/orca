import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parsePluginAppThemeArtifact } from '../../shared/plugins/artifacts/plugin-theme-artifact'
import { parsePluginTerminalThemeArtifact } from '../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import { LOCAL_PLUGIN_PUBLISHER } from '../../shared/plugins/installation/plugin-publisher-derivation'
import type { ThemeStudioDraft } from '../../shared/theme-studio/theme-studio-draft'
import {
  THEME_STUDIO_ERROR_CODES,
  ThemeStudioError
} from '../../shared/theme-studio/theme-studio-errors'
import {
  themeStudioPluginFiles,
  themeStudioPluginId
} from '../../shared/theme-studio/theme-studio-plugin-files'

const MAX_ID_ATTEMPTS = 20

/** Throws a theme error when Orca would refuse to load one of the files. */
function assertLoadable(files: Record<string, string>): void {
  try {
    for (const [path, text] of Object.entries(files)) {
      if (path.startsWith('themes/')) {
        parsePluginAppThemeArtifact(text, 'strict')
      } else if (path.startsWith('terminal/')) {
        parsePluginTerminalThemeArtifact(text, 'strict')
      }
    }
  } catch (error) {
    throw new ThemeStudioError(
      THEME_STUDIO_ERROR_CODES.invalid,
      `The draft would not load as a theme: ${error instanceof Error ? error.message : String(error)}`,
      { nextSteps: ['Fix the named token with `orca theme set`, then apply again.'] }
    )
  }
}

/** Whether two paths name one folder; macOS temp paths reach the same place by two names. */
export async function sameFolder(left: string, right: string): Promise<boolean> {
  const real = (path: string): Promise<string> => realpath(path).catch(() => resolve(path))
  return (await real(left)) === (await real(right))
}

/** Writes plugin files (paths with `/`) into `folder`, replacing what was there. */
export async function writeThemeStudioFiles(
  folder: string,
  files: Record<string, string>
): Promise<void> {
  assertLoadable(files)
  await rm(folder, { recursive: true, force: true })
  for (const [path, text] of Object.entries(files)) {
    const file = join(folder, ...path.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text, 'utf8')
  }
}

/**
 * Writes the draft as a content-only theme plugin under `pluginsRoot` and returns its folder. A
 * name another folder already installed as `local.<id>` gets a free id, so applying never moves
 * that plugin's source (which would need approval) or overwrites it. `id` keeps a saved theme's
 * id (rename); `fresh` skips ids already saved here too (duplicate).
 */
export async function writeThemeStudioPlugin(
  draft: ThemeStudioDraft,
  pluginsRoot: string,
  installedFrom: (pluginKey: string) => Promise<string | null>,
  options: { id?: string; fresh?: boolean; strict?: boolean } = {}
): Promise<{ folder: string; replaced: boolean; id: string }> {
  const base = options.id ?? themeStudioPluginId(draft.name)
  for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt += 1) {
    const id = attempt === 1 ? base : `${base}-${attempt}`
    const folder = join(pluginsRoot, id)
    const owner = await installedFrom(`${LOCAL_PLUGIN_PUBLISHER}.${id}`)
    const exists = await stat(folder).then(
      () => true,
      () => false
    )
    const ownedElsewhere = owner !== null && !(await sameFolder(owner, folder))
    if (ownedElsewhere && options.strict) {
      throw new ThemeStudioError(
        THEME_STUDIO_ERROR_CODES.invalid,
        `${LOCAL_PLUGIN_PUBLISHER}.${id} is now installed from another folder.`,
        { nextSteps: ['Duplicate the theme and rename the copy instead.'] }
      )
    }
    if (ownedElsewhere || (options.fresh && (exists || owner !== null))) {
      continue
    }
    await writeThemeStudioFiles(folder, themeStudioPluginFiles(draft, id).files)
    return { folder, replaced: exists, id }
  }
  throw new ThemeStudioError(
    THEME_STUDIO_ERROR_CODES.invalid,
    `Too many installed plugins are named like ${draft.name}.`,
    { nextSteps: ['Apply with another --name.'] }
  )
}
