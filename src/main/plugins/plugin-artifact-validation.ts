import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import {
  parsePluginIconThemeArtifact,
  sanitizePluginIconSvg
} from '../../shared/plugins/plugin-icon-theme-artifact'
import { parsePluginVmRecipeArtifact } from '../../shared/plugins/plugin-vm-recipe-artifact'

export type PluginArtifactValidationResult = { ok: true } | { ok: false; error: string }

export const PLUGIN_PANEL_ENTRY_MAX_BYTES = 10 * 1024 * 1024
export const PLUGIN_WORKER_ENTRY_MAX_BYTES = 50 * 1024 * 1024
const PLUGIN_ICON_MAX_BYTES = 2 * 1024 * 1024
export const PLUGIN_THEME_MAX_BYTES = 256 * 1024
export const PLUGIN_ICON_THEME_MAX_BYTES = 512 * 1024
export const PLUGIN_ICON_SVG_MAX_BYTES = 64 * 1024
export const PLUGIN_ICON_TOTAL_MAX_BYTES = 8 * 1024 * 1024
export const PLUGIN_TERMINAL_THEME_MAX_BYTES = 256 * 1024
export const PLUGIN_LANGUAGE_PACK_MAX_BYTES = 5 * 1024 * 1024
export const PLUGIN_VM_RECIPE_MAX_BYTES = 256 * 1024
const PLUGIN_AGENT_PROFILE_MAX_BYTES = 1024 * 1024

type DeclaredArtifact =
  | { label: string; path: string; kind: 'file'; maxBytes: number }
  | { label: string; path: string; kind: 'directory' }

function declaredArtifactPaths(manifest: PluginManifest): DeclaredArtifact[] {
  return [
    ...(manifest.icon
      ? [
          {
            label: 'icon',
            path: manifest.icon,
            kind: 'file' as const,
            maxBytes: PLUGIN_ICON_MAX_BYTES
          }
        ]
      : []),
    ...(manifest.main
      ? [
          {
            label: 'worker entry',
            path: manifest.main,
            kind: 'file' as const,
            maxBytes: PLUGIN_WORKER_ENTRY_MAX_BYTES
          }
        ]
      : []),
    ...manifest.contributes.panels.map((panel) => ({
      label: `panel "${panel.id}" entry`,
      path: panel.entry,
      kind: 'file' as const,
      maxBytes: PLUGIN_PANEL_ENTRY_MAX_BYTES
    })),
    ...manifest.contributes.themes.map((theme) => ({
      label: `theme "${theme.id}"`,
      path: theme.path,
      kind: 'file' as const,
      maxBytes: PLUGIN_THEME_MAX_BYTES
    })),
    ...manifest.contributes.iconThemes.map((theme) => ({
      label: `icon theme "${theme.id}"`,
      path: theme.path,
      kind: 'file' as const,
      maxBytes: PLUGIN_ICON_THEME_MAX_BYTES
    })),
    ...manifest.contributes.terminalThemes.map((theme) => ({
      label: `terminal theme "${theme.id}"`,
      path: theme.path,
      kind: 'file' as const,
      maxBytes: PLUGIN_TERMINAL_THEME_MAX_BYTES
    })),
    ...manifest.contributes.languagePacks.map((languagePack) => ({
      label: `language pack "${languagePack.locale}"`,
      path: languagePack.path,
      kind: 'file' as const,
      maxBytes: PLUGIN_LANGUAGE_PACK_MAX_BYTES
    })),
    ...manifest.contributes.vmRecipes.map((recipe) => ({
      label: 'VM recipe',
      path: recipe.path,
      kind: 'file' as const,
      maxBytes: PLUGIN_VM_RECIPE_MAX_BYTES
    })),
    ...manifest.contributes.agents.map((agent) => ({
      label: 'agent profile',
      path: agent.path,
      kind: 'file' as const,
      maxBytes: PLUGIN_AGENT_PROFILE_MAX_BYTES
    }))
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
  return Buffer.concat(chunks, totalBytes).toString('utf8')
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

/** Parses and sanitizes icon-theme references at the immutable install boundary. */
export async function validatePluginInstallContent(
  rootDir: string,
  manifest: PluginManifest
): Promise<PluginArtifactValidationResult> {
  let iconBytes = 0
  for (const contribution of manifest.contributes.iconThemes) {
    try {
      const artifact = parsePluginIconThemeArtifact(
        await readContainedPluginArtifactText(
          rootDir,
          contribution.path,
          PLUGIN_ICON_THEME_MAX_BYTES
        )
      )
      const paths = new Set([
        ...Object.values(artifact.icons),
        ...Object.values(artifact.fileNames),
        ...Object.values(artifact.fileExtensions)
      ])
      for (const path of paths) {
        const svg = await readContainedPluginArtifactText(rootDir, path, PLUGIN_ICON_SVG_MAX_BYTES)
        iconBytes += Buffer.byteLength(svg, 'utf8')
        if (iconBytes > PLUGIN_ICON_TOTAL_MAX_BYTES) {
          throw new Error(`icon SVGs exceed ${PLUGIN_ICON_TOTAL_MAX_BYTES} bytes in total`)
        }
        sanitizePluginIconSvg(svg)
      }
    } catch (error) {
      return {
        ok: false,
        error: `icon theme "${contribution.id}": ${error instanceof Error ? error.message : String(error)}`
      }
    }
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
  return { ok: true }
}
