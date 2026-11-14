import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { RuntimeClientError } from '../runtime/types'
import {
  isThemeColorValue,
  parsePluginAppThemeArtifact
} from '../../shared/plugins/artifacts/plugin-theme-artifact'
import { parsePluginTerminalThemeArtifact } from '../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import type {
  ThemeStudioDraft,
  ThemeStudioMode,
  ThemeStudioVariant
} from '../../shared/theme-studio/theme-studio-draft'
import { isRecord } from './theme-command-args'

// Why only plain colors: derivations are refilled when the theme loads, and a draft holds colors.
function plainTokens(tokens: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tokens).filter(([, value]) => isThemeColorValue(value)))
}

async function variantFromFile(
  file: string
): Promise<{ mode: ThemeStudioMode; variant: ThemeStudioVariant }> {
  const theme = parsePluginAppThemeArtifact(await readFile(file, 'utf8'), 'tolerant')
  return {
    mode: theme.base,
    variant: {
      tokens: plainTokens(theme.tokens),
      ...(theme.tokenColors?.length ? { tokenColors: theme.tokenColors } : {})
    }
  }
}

function contributionPaths(manifest: unknown, key: 'themes' | 'terminalThemes'): string[] {
  const contributes =
    isRecord(manifest) && isRecord(manifest.contributes) ? manifest.contributes : {}
  const list = contributes[key]
  return Array.isArray(list)
    ? list.flatMap((entry) =>
        isRecord(entry) && typeof entry.path === 'string' ? [entry.path] : []
      )
    : []
}

function insideFolder(root: string, path: string): string {
  const file = resolve(root, path)
  const fromRoot = relative(root, file)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new RuntimeClientError('invalid_argument', `${path} is outside the plugin folder.`)
  }
  return file
}

/** A theme plugin folder or theme JSON as a draft; read as data, never loaded as a plugin. */
export async function draftFromLocal(path: string): Promise<ThemeStudioDraft> {
  const draft: ThemeStudioDraft = {
    name:
      basename(path)
        .replace(/\.json$/i, '')
        .slice(0, 64) || 'My Theme',
    light: null,
    dark: null
  }
  if (!readdirSafe(path)) {
    const { mode, variant } = await variantFromFile(path)
    draft[mode] = variant
    return draft
  }
  const manifest: unknown = JSON.parse(await readFile(join(path, 'orca-plugin.json'), 'utf8'))
  if (isRecord(manifest) && typeof manifest.name === 'string') {
    draft.name = manifest.name.slice(0, 64)
  }
  for (const themePath of contributionPaths(manifest, 'themes')) {
    const { mode, variant } = await variantFromFile(insideFolder(path, themePath))
    draft[mode] ??= variant
  }
  for (const terminalPath of contributionPaths(manifest, 'terminalThemes')) {
    const { mode, terminal } = parsePluginTerminalThemeArtifact(
      await readFile(insideFolder(path, terminalPath), 'utf8'),
      'tolerant'
    )
    const target = mode === 'unknown' ? null : draft[mode]
    if (target && !target.terminal) {
      target.terminal = terminal
    }
  }
  if (!draft.light && !draft.dark) {
    throw new RuntimeClientError('invalid_argument', `${path} contributes no app theme.`)
  }
  return draft
}

function readdirSafe(path: string): boolean {
  try {
    readdirSync(path)
    return true
  } catch {
    return false
  }
}
