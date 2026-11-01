import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { PluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import {
  PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES,
  PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES
} from '../../shared/plugins/artifacts/plugin-syntax-artifact'
import { parsePluginVmRecipeArtifact } from '../../shared/plugins/artifacts/plugin-vm-recipe-artifact'
import { PLUGIN_IMAGE_RULES } from '../../shared/plugins/images/plugin-image-fields'
import { PLUGIN_NEW_FILE_TEMPLATE_MAX_BYTES } from '../../shared/plugins/contributions/plugin-new-file-contribution'
import { validatePluginImageArtifacts } from './plugin-image-artifact-validation'

export type PluginArtifactValidationResult = { ok: true } | { ok: false; error: string }

export const PLUGIN_PANEL_ENTRY_MAX_BYTES = 10 * 1024 * 1024
export const PLUGIN_WORKER_ENTRY_MAX_BYTES = 50 * 1024 * 1024
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
    ])
  ]
}

export async function resolveContainedPluginArtifact(
  rootDir: string,
  relativePath: string,
  maxBytes = PLUGIN_WORKER_ENTRY_MAX_BYTES
): Promise<string> {
  const rootReal = await realpath(resolve(rootDir))
  return resolvePathFromRealRoot(rootDir, rootReal, relativePath, 'file', maxBytes)
}

export async function readContainedPluginArtifactText(
  rootDir: string,
  relativePath: string,
  maxBytes: number
): Promise<string> {
  return (await readContainedPluginArtifactBytes(rootDir, relativePath, maxBytes)).toString('utf8')
}

export async function readContainedPluginArtifactBytes(
  rootDir: string,
  relativePath: string,
  maxBytes: number
): Promise<Buffer> {
  const artifact = await resolveContainedPluginArtifact(rootDir, relativePath, maxBytes)
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of createReadStream(artifact)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += bytes.byteLength
    if (totalBytes > maxBytes) {
      throw new Error(`exceeds the ${maxBytes}-byte artifact limit`)
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, totalBytes)
}

async function resolvePathFromRealRoot(
  rootDir: string,
  rootReal: string,
  relativePath: string,
  kind: 'file' | 'directory',
  maxBytes?: number
): Promise<string> {
  const artifactReal = await realpath(resolve(rootDir, ...relativePath.split(/[\\/]/)))
  const fromRoot = relative(rootReal, artifactReal)
  if (
    fromRoot.length === 0 ||
    isAbsolute(fromRoot) ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error('resolves outside the plugin directory')
  }
  const artifactStat = await stat(artifactReal)
  if (kind === 'file' && !artifactStat.isFile()) {
    throw new Error('is not a regular file')
  }
  if (kind === 'directory' && !artifactStat.isDirectory()) {
    throw new Error('is not a directory')
  }
  if (kind === 'file' && maxBytes !== undefined && artifactStat.size > maxBytes) {
    throw new Error(`exceeds the ${maxBytes}-byte artifact limit`)
  }
  return artifactReal
}

/** Presence and containment checks are bounded by the manifest's declared artifacts. */
export async function validateDeclaredPluginArtifacts(
  rootDir: string,
  manifest: PluginManifest
): Promise<PluginArtifactValidationResult> {
  const artifacts = declaredArtifactPaths(manifest)
  if (artifacts.length === 0) {
    return { ok: true }
  }
  const seen = new Set<string>()
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
