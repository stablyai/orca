import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import {
  NodeFileReadTooLargeError,
  readNodeFileSyncWithinLimit
} from '../../shared/node-bounded-file-reader'
import {
  CONFIG_OVERLAY_MAX_SOURCE_ENTRIES,
  ConfigOverlayCapacityError,
  ConfigOverlayEntryBudget,
  applyConfigOverlayPlan,
  createConfigOverlayPlan,
  type AppliedConfigOverlayEntries
} from '../pty/config-overlay-mirroring'
import { safeRemoveTree } from '../pty/overlay-mirror'

export const ORCA_OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'
export const OPENCODE_OVERLAY_MANIFEST_FILE = '.orca-opencode-overlay-manifest.json'
export const OPENCODE_OVERLAY_MANIFEST_MAX_BYTES = 2 * 1_024 * 1_024

type OpenCodeOverlayManifest = {
  topLevelEntries: string[]
  pluginEntries: string[]
}

const RESERVED_TOP_LEVEL_ENTRIES = new Set([OPENCODE_OVERLAY_MANIFEST_FILE])

function emptyManifest(): OpenCodeOverlayManifest {
  return { topLevelEntries: [], pluginEntries: [] }
}

function parseManifestEntryNames(
  value: unknown,
  kind: 'top-level' | 'plugin',
  budget: ConfigOverlayEntryBudget
): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const names: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      continue
    }
    budget.reserve(candidate)
    if (
      (kind === 'top-level' &&
        (candidate === 'plugins' || candidate === OPENCODE_OVERLAY_MANIFEST_FILE)) ||
      (kind === 'plugin' && candidate === ORCA_OPENCODE_PLUGIN_FILE)
    ) {
      continue
    }
    names.push(candidate)
  }
  return names
}

function parseOverlayManifest(contents: string): OpenCodeOverlayManifest {
  const parsed = JSON.parse(contents) as Partial<OpenCodeOverlayManifest>
  const topLevelCount = Array.isArray(parsed.topLevelEntries) ? parsed.topLevelEntries.length : 0
  const pluginCount = Array.isArray(parsed.pluginEntries) ? parsed.pluginEntries.length : 0
  if (topLevelCount + pluginCount > CONFIG_OVERLAY_MAX_SOURCE_ENTRIES) {
    throw new ConfigOverlayCapacityError(
      'entries',
      topLevelCount + pluginCount,
      CONFIG_OVERLAY_MAX_SOURCE_ENTRIES
    )
  }

  const budget = new ConfigOverlayEntryBudget()
  return {
    topLevelEntries: parseManifestEntryNames(parsed.topLevelEntries, 'top-level', budget),
    pluginEntries: parseManifestEntryNames(parsed.pluginEntries, 'plugin', budget)
  }
}

function readOverlayManifest(overlayDir: string): OpenCodeOverlayManifest {
  try {
    const contents = readNodeFileSyncWithinLimit(
      join(overlayDir, OPENCODE_OVERLAY_MANIFEST_FILE),
      OPENCODE_OVERLAY_MANIFEST_MAX_BYTES
    ).buffer.toString('utf8')
    return parseOverlayManifest(contents)
  } catch (error) {
    if (error instanceof ConfigOverlayCapacityError || error instanceof NodeFileReadTooLargeError) {
      throw error
    }
    return emptyManifest()
  }
}

function removePathBeforeWrite(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

function writeOverlayManifest(overlayDir: string, manifest: OpenCodeOverlayManifest): void {
  const manifestPath = join(overlayDir, OPENCODE_OVERLAY_MANIFEST_FILE)
  const { serialized } = stringifyJsonWithinByteLimit(
    manifest,
    OPENCODE_OVERLAY_MANIFEST_MAX_BYTES - 1
  )
  removePathBeforeWrite(manifestPath)
  writeFileSync(manifestPath, `${serialized}\n`)
}

function clearManifestEntries(overlayDir: string, manifest: OpenCodeOverlayManifest): void {
  for (const entryName of manifest.topLevelEntries) {
    if (!safeRemoveTree(join(overlayDir, entryName))) {
      throw new Error('Unable to clear an OpenCode config overlay entry')
    }
  }

  const overlayPluginsDir = join(overlayDir, 'plugins')
  for (const entryName of manifest.pluginEntries) {
    if (!safeRemoveTree(join(overlayPluginsDir, entryName))) {
      throw new Error('Unable to clear an OpenCode plugin overlay entry')
    }
  }
}

function toManifest(applied: AppliedConfigOverlayEntries): OpenCodeOverlayManifest {
  return {
    topLevelEntries: applied.topLevelEntryNames,
    pluginEntries: applied.pluginEntryNames
  }
}

export function mirrorOpenCodeConfigWithManifest(sourceDir: string, overlayDir: string): void {
  const plan = createConfigOverlayPlan(sourceDir, {
    reservedPluginFile: ORCA_OPENCODE_PLUGIN_FILE,
    reservedTopLevelEntryNames: RESERVED_TOP_LEVEL_ENTRIES
  })
  const previousManifest = readOverlayManifest(overlayDir)
  clearManifestEntries(overlayDir, previousManifest)

  const applied: AppliedConfigOverlayEntries = {
    topLevelEntryNames: [],
    pluginEntryNames: []
  }
  try {
    applyConfigOverlayPlan(plan, overlayDir, applied)
    writeOverlayManifest(overlayDir, toManifest(applied))
  } catch (error) {
    try {
      clearManifestEntries(overlayDir, toManifest(applied))
    } catch {
      // Preserve the original mirror/write failure; a later spawn can retry cleanup.
    }
    throw error
  }
}

export const _configOverlayManifestInternals = {
  parseOverlayManifest,
  writeOverlayManifest
}
