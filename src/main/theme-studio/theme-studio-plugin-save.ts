import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

/**
 * Writes the draft as a content-only theme plugin under `pluginsRoot` and returns its folder. A
 * name another folder already installed as `local.<id>` gets a free id, so applying never moves
 * that plugin's source (which would need approval) or overwrites it.
 */
export async function writeThemeStudioPlugin(
  draft: ThemeStudioDraft,
  pluginsRoot: string,
  installedFrom: (pluginKey: string) => Promise<string | null>
): Promise<{ folder: string; replaced: boolean }> {
  const base = themeStudioPluginId(draft.name)
  for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt += 1) {
    const id = attempt === 1 ? base : `${base}-${attempt}`
    const folder = join(pluginsRoot, id)
    const owner = await installedFrom(`${LOCAL_PLUGIN_PUBLISHER}.${id}`)
    if (owner !== null && owner !== folder) {
      continue
    }
    const { files } = themeStudioPluginFiles(draft, id)
    assertLoadable(files)
    const replaced = existsSync(folder)
    await rm(folder, { recursive: true, force: true })
    for (const [path, text] of Object.entries(files)) {
      const file = join(folder, ...path.split('/'))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, text, 'utf8')
    }
    return { folder, replaced }
  }
  throw new ThemeStudioError(
    THEME_STUDIO_ERROR_CODES.invalid,
    `Too many installed plugins are named like ${draft.name}.`,
    { nextSteps: ['Apply with another --name.'] }
  )
}
