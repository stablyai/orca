import { readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PluginManifest } from '../../../shared/plugins/manifest/plugin-manifest'
import {
  PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES,
  PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES
} from '../../../shared/plugins/artifacts/plugin-syntax-artifact'
import { parsePluginVmRecipeArtifact } from '../../../shared/plugins/artifacts/plugin-vm-recipe-artifact'
import { PLUGIN_IMAGE_RULES } from '../../../shared/plugins/images/plugin-image-fields'
import { PLUGIN_NEW_FILE_TEMPLATE_MAX_BYTES } from '../../../shared/plugins/contributions/plugin-new-file-contribution'
import { validatePluginImageArtifacts } from '../media/plugin-image-artifact-validation'
import { validatePluginFontArtifacts } from '../media/plugin-font-files'
import { PLUGIN_FONT_FILE_MAX_BYTES } from '../../../shared/plugins/contributions/plugin-font-contribution'
import { PLUGIN_PANEL_ENTRY_MAX_BYTES } from '../../../shared/plugins/frames/plugin-frame-entry-limits'
import {
  isPluginWorktreeBadgeSvgIcon,
  PLUGIN_WORKTREE_BADGE_SVG_MAX_BYTES
} from '../../../shared/plugins/contributions/plugin-worktree-badge-contribution'
import {
  PLUGIN_WORKER_ENTRY_MAX_BYTES,
  readContainedPluginArtifactBytes,
  readContainedPluginArtifactText,
  resolvePathFromRealRoot
} from './plugin-contained-artifact'

export type PluginArtifactValidationResult = { ok: true } | { ok: false; error: string }

const PLUGIN_ICON_MAX_BYTES = 2 * 1024 * 1024
export const PLUGIN_LANGUAGE_PACK_MAX_BYTES = 5 * 1024 * 1024
export const PLUGIN_VM_RECIPE_MAX_BYTES = 256 * 1024
// Why 16 KiB: a theme is a few dozen tokens or palette slots.
export const PLUGIN_THEME_MAX_BYTES = 16 * 1024
// Why larger: an icon theme maps up to 512 file names and extensions.
export const PLUGIN_ICON_THEME_MAX_BYTES = 64 * 1024

type DeclaredArtifact =
  | { label: string; path: string; kind: 'file'; maxBytes: number }
  | { label: string; path: string; kind: 'directory' }

function declaredFile(label: string, path: string | undefined, maxBytes: number) {
  return path === undefined ? [] : [{ label, path, kind: 'file' as const, maxBytes }]
}

function declaredArtifactPaths(manifest: PluginManifest): DeclaredArtifact[] {
  const c = manifest.contributes
  return [
    ...declaredFile('icon', manifest.icon, PLUGIN_ICON_MAX_BYTES),
    ...(manifest.manifestVersion === 2
      ? [
          ...declaredFile('cover', manifest.cover?.path, PLUGIN_IMAGE_RULES.cover.maxBytes),
          ...(manifest.screenshots ?? []).flatMap((shot) =>
            declaredFile('screenshot', shot.path, PLUGIN_IMAGE_RULES.screenshot.maxBytes)
          )
        ]
      : []),
    ...declaredFile('worker entry', manifest.main, PLUGIN_WORKER_ENTRY_MAX_BYTES),
    ...c.panels.flatMap((panel) =>
      declaredFile(`panel "${panel.id}" entry`, panel.entry, PLUGIN_PANEL_ENTRY_MAX_BYTES)
    ),
    ...c.customEditors.flatMap((editor) => [
      ...declaredFile(
        `custom editor "${editor.id}" entry`,
        editor.entry,
        PLUGIN_PANEL_ENTRY_MAX_BYTES
      ),
      ...declaredFile(
        `custom editor "${editor.id}" icon`,
        editor.icon,
        PLUGIN_IMAGE_RULES.icon.maxBytes
      )
    ]),
    ...c.newFiles.flatMap((newFile) => [
      ...declaredFile(
        `new file "${newFile.id}" template`,
        newFile.template,
        PLUGIN_NEW_FILE_TEMPLATE_MAX_BYTES
      ),
      ...declaredFile(
        `new file "${newFile.id}" icon`,
        newFile.icon,
        PLUGIN_IMAGE_RULES.icon.maxBytes
      )
    ]),
    ...c.languagePacks.flatMap((pack) =>
      declaredFile(`language pack "${pack.locale}"`, pack.path, PLUGIN_LANGUAGE_PACK_MAX_BYTES)
    ),
    ...c.vmRecipes.flatMap((recipe) =>
      declaredFile('VM recipe', recipe.path, PLUGIN_VM_RECIPE_MAX_BYTES)
    ),
    ...c.themes.flatMap((theme) =>
      declaredFile(`theme "${theme.id}"`, theme.path, PLUGIN_THEME_MAX_BYTES)
    ),
    ...c.terminalThemes.flatMap((theme) =>
      declaredFile(`terminal theme "${theme.id}"`, theme.path, PLUGIN_THEME_MAX_BYTES)
    ),
    ...c.iconThemes.flatMap((theme) =>
      declaredFile(`icon theme "${theme.id}"`, theme.path, PLUGIN_ICON_THEME_MAX_BYTES)
    ),
    ...c.fonts.flatMap((font) =>
      font.faces.flatMap((face) =>
        declaredFile(`font "${font.family}"`, face.path, PLUGIN_FONT_FILE_MAX_BYTES)
      )
    ),
    ...c.syntaxes.flatMap((syntax) => [
      ...declaredFile(
        `syntax "${syntax.id}" grammar`,
        syntax.path,
        PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES
      ),
      ...declaredFile(
        `syntax "${syntax.id}" configuration`,
        syntax.configuration,
        PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES
      )
    ]),
    ...c.worktreeBadges
      .filter((badge) => isPluginWorktreeBadgeSvgIcon(badge.icon))
      .flatMap((badge) =>
        declaredFile(
          `worktree badge "${badge.id}" icon`,
          badge.icon,
          PLUGIN_WORKTREE_BADGE_SVG_MAX_BYTES
        )
      )
  ]
}

/** Why: APFS and NTFS resolve `dark.json` to a committed `DARK.json`, but Linux does not. */
async function assertExactPathSpelling(
  rootDir: string,
  relativePath: string,
  listDirectory: (dir: string) => Promise<string[]>
): Promise<void> {
  let dir = resolve(rootDir)
  for (const segment of relativePath.split(/[\\/]/)) {
    const names = await listDirectory(dir)
    if (!names.includes(segment)) {
      const lower = segment.toLowerCase()
      const actual = names.find((name) => name.toLowerCase() === lower)
      throw new Error(
        actual === undefined
          ? `"${segment}" does not match its on-disk name (check case and Unicode normalization)`
          : `"${segment}" is spelled "${actual}" on disk; paths are case-sensitive on Linux`
      )
    }
    dir = join(dir, segment)
  }
}

/** Presence and containment checks are bounded by the manifest's declared artifacts. */
export async function validateDeclaredPluginArtifacts(
  rootDir: string,
  manifest: PluginManifest,
  // Why: installed plugins predate the case rule, so startup must not drop them on macOS/Windows.
  { allowCaseMismatch = false }: { allowCaseMismatch?: boolean } = {}
): Promise<PluginArtifactValidationResult> {
  const artifacts = declaredArtifactPaths(manifest)
  if (artifacts.length === 0) {
    return { ok: true }
  }
  const seen = new Set<string>()
  const listings = new Map<string, Promise<string[]>>()
  const listDirectory = (dir: string): Promise<string[]> => {
    let listing = listings.get(dir)
    if (!listing) {
      listing = readdir(dir)
      listings.set(dir, listing)
    }
    return listing
  }
  let rootReal: string
  try {
    rootReal = await realpath(resolve(rootDir))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  for (const artifact of artifacts) {
    if (seen.has(artifact.path)) {
      continue
    }
    seen.add(artifact.path)
    try {
      await resolvePathFromRealRoot(
        rootDir,
        rootReal,
        artifact.path,
        artifact.kind,
        artifact.kind === 'file' ? artifact.maxBytes : undefined
      )
      if (!allowCaseMismatch) {
        await assertExactPathSpelling(rootDir, artifact.path, listDirectory)
      }
    } catch (error) {
      return {
        ok: false,
        error: `${artifact.label} ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  return { ok: true }
}

export async function validatePluginInstallContent(
  rootDir: string,
  manifest: PluginManifest
): Promise<PluginArtifactValidationResult> {
  const images = await validatePluginImageArtifacts(
    rootDir,
    manifest,
    readContainedPluginArtifactBytes
  )
  if (!images.ok) {
    return images
  }
  const fonts = await validatePluginFontArtifacts(rootDir, manifest)
  if (!fonts.ok) {
    return fonts
  }
  const vmRecipeIds = new Set<string>()
  for (const contribution of manifest.contributes.vmRecipes) {
    try {
      const recipe = parsePluginVmRecipeArtifact(
        await readContainedPluginArtifactText(
          rootDir,
          contribution.path,
          PLUGIN_VM_RECIPE_MAX_BYTES
        )
      )
      if (vmRecipeIds.has(recipe.id)) {
        throw new Error(`duplicate VM recipe id "${recipe.id}"`)
      }
      vmRecipeIds.add(recipe.id)
    } catch (error) {
      return {
        ok: false,
        error: `VM recipe ${contribution.path}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  for (const newFile of manifest.contributes.newFiles) {
    if (newFile.template === undefined) {
      continue
    }
    try {
      await readPluginNewFileTemplate(rootDir, newFile.template)
    } catch (error) {
      return {
        ok: false,
        error: `new file "${newFile.id}" template ${newFile.template}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  return { ok: true }
}

/** Every check install runs on a plugin's files, in install's order. */
export async function validatePluginInstallTree(
  rootDir: string,
  manifest: PluginManifest
): Promise<PluginArtifactValidationResult> {
  const declared = await validateDeclaredPluginArtifacts(rootDir, manifest)
  return declared.ok ? validatePluginInstallContent(rootDir, manifest) : declared
}

/** A new-file template's text; refuses bytes that are not UTF-8 so a file never starts garbled. */
export async function readPluginNewFileTemplate(
  rootDir: string,
  relativePath: string
): Promise<string> {
  const bytes = await readContainedPluginArtifactBytes(
    rootDir,
    relativePath,
    PLUGIN_NEW_FILE_TEMPLATE_MAX_BYTES
  )
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('is not UTF-8 text')
  }
}
