import { app } from 'electron'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { getOpenCodeFamilyPluginSource } from '../opencode/hook-service'
import { mirrorEntry, safeRemoveTree } from '../pty/overlay-mirror'

const ORCA_MIMOCODE_PLUGIN_FILE = 'orca-mimocode-status.js'
const MIMOCODE_CONFIG_OVERLAYS_DIR = 'mimocode-config-overlays'
const MIMOCODE_RUNTIME_DIRS = new Set([
  'data',
  'cache',
  'state',
  'session',
  'sessions',
  'memory',
  'storage'
])

function defaultMimocodeConfigDir(): string {
  return join(homedir(), '.config', 'mimocode')
}

function resolveSourceConfigDir(existingConfigDir: string | undefined): string | undefined {
  if (existingConfigDir) {
    return existsSync(existingConfigDir) ? existingConfigDir : undefined
  }
  const xdg = defaultMimocodeConfigDir()
  return existsSync(xdg) ? xdg : undefined
}

function comparablePath(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function comparableRealPath(path: string): string {
  try {
    return comparablePath(realpathSync(path))
  } catch {
    return comparablePath(path)
  }
}

function isSameOrNestedPath(parentPath: string, childPath: string): boolean {
  const rel = relative(parentPath, childPath)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function pathsHaveUnsafeRelationship(sourcePath: string, targetPath: string): boolean {
  const sourcePaths = new Set([comparablePath(sourcePath), comparableRealPath(sourcePath)])
  const targetPaths = new Set([comparablePath(targetPath), comparableRealPath(targetPath)])
  for (const source of sourcePaths) {
    for (const target of targetPaths) {
      if (isSameOrNestedPath(source, target) || isSameOrNestedPath(target, source)) {
        return true
      }
    }
  }
  return false
}

function isOwnedOverlayTarget(targetPath: string, overlayRoot: string): boolean {
  const rel = relative(resolve(overlayRoot), resolve(targetPath))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function mirrorConfigDir(sourceConfigDir: string, targetConfigDir: string): void {
  mkdirSync(targetConfigDir, { recursive: true })
  for (const entry of readdirSync(sourceConfigDir, { withFileTypes: true })) {
    const normalizedName = entry.name.toLowerCase()
    if (
      normalizedName === 'auth.json' ||
      MIMOCODE_RUNTIME_DIRS.has(normalizedName) ||
      /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(entry.name)
    ) {
      continue
    }
    if (entry.name === 'plugins') {
      const sourcePlugins = join(sourceConfigDir, 'plugins')
      const isSymlink = entry.isSymbolicLink()
      let isDirectory = !isSymlink && entry.isDirectory()
      if (isSymlink) {
        try {
          isDirectory = statSync(sourcePlugins).isDirectory()
        } catch {
          isDirectory = false
        }
      }
      if (!isDirectory) {
        mirrorEntry(sourcePlugins, join(targetConfigDir, entry.name))
        continue
      }

      const overlayPlugins = join(targetConfigDir, 'plugins')
      mkdirSync(overlayPlugins, { recursive: true })
      const resolvedSourcePlugins = isSymlink ? realpathSync(sourcePlugins) : sourcePlugins
      for (const pluginEntry of readdirSync(resolvedSourcePlugins, {
        withFileTypes: true
      })) {
        if (pluginEntry.name === ORCA_MIMOCODE_PLUGIN_FILE) {
          continue
        }
        mirrorEntry(
          join(resolvedSourcePlugins, pluginEntry.name),
          join(overlayPlugins, pluginEntry.name)
        )
      }
      continue
    }
    mirrorEntry(join(sourceConfigDir, entry.name), join(targetConfigDir, entry.name))
  }
}

function ensureRealDirectory(path: string): void {
  mkdirSync(path, { recursive: true })
  const stats = lstatSync(path)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Unsafe MiMoCode overlay directory: ${path}`)
  }
}

function realDirectoryIdentity(path: string): string | undefined {
  try {
    const stats = lstatSync(path)
    return stats.isDirectory() && !stats.isSymbolicLink() ? comparableRealPath(path) : undefined
  } catch {
    return undefined
  }
}

function ensureCleanOverlayTarget(path: string): void {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink() || !stats.isDirectory() || readdirSync(path).length > 0) {
      throw new Error(`MiMoCode overlay cleanup incomplete: ${path}`)
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export class MimoCodeHookService {
  private readonly ownedPtyOverlays = new Map<string, { target: string; rootIdentity: string }>()

  clearPty(ptyId: string): void {
    const owned = this.ownedPtyOverlays.get(ptyId)
    if (!owned) {
      return
    }
    this.ownedPtyOverlays.delete(ptyId)
    const overlayRoot = join(app.getPath('userData'), MIMOCODE_CONFIG_OVERLAYS_DIR)
    if (
      realDirectoryIdentity(overlayRoot) === owned.rootIdentity &&
      isOwnedOverlayTarget(owned.target, overlayRoot)
    ) {
      safeRemoveTree(owned.target)
    }
  }

  buildPtyEnv(ptyId: string, existingConfigDir?: string): Record<string, string> {
    // Why: only config is overlaid so MiMo keeps canonical ownership of auth,
    // sessions, memory, and other runtime data outside Orca's userData.
    const overlayRoot = join(app.getPath('userData'), MIMOCODE_CONFIG_OVERLAYS_DIR)
    const configDir = this.getPtyConfigDir(overlayRoot, ptyId)
    const sourceConfig = resolveSourceConfigDir(existingConfigDir)
    const owned = this.ownedPtyOverlays.get(ptyId)
    if (owned) {
      try {
        const stats = lstatSync(owned.target)
        if (
          owned.target === configDir &&
          realDirectoryIdentity(overlayRoot) === owned.rootIdentity &&
          isOwnedOverlayTarget(owned.target, overlayRoot) &&
          !stats.isSymbolicLink() &&
          stats.isDirectory()
        ) {
          return { MIMOCODE_CONFIG_DIR: owned.target }
        }
      } catch {
        // A missing or replaced target must be rebuilt through the safety checks below.
      }
      this.ownedPtyOverlays.delete(ptyId)
    }
    if (sourceConfig && pathsHaveUnsafeRelationship(sourceConfig, configDir)) {
      return existingConfigDir ? { MIMOCODE_CONFIG_DIR: existingConfigDir } : {}
    }
    if (!isOwnedOverlayTarget(configDir, overlayRoot)) {
      return existingConfigDir ? { MIMOCODE_CONFIG_DIR: existingConfigDir } : {}
    }
    try {
      ensureRealDirectory(overlayRoot)
      const rootIdentity = comparableRealPath(overlayRoot)
      safeRemoveTree(configDir)
      // Why: cleanup is best-effort, so any residue must abort before overlay writes.
      ensureCleanOverlayTarget(configDir)
      ensureRealDirectory(configDir)
      ensureRealDirectory(join(configDir, 'plugins'))
      if (sourceConfig) {
        mirrorConfigDir(sourceConfig, configDir)
      }
      const pluginsDir = join(configDir, 'plugins')
      const pluginPath = join(pluginsDir, ORCA_MIMOCODE_PLUGIN_FILE)
      try {
        unlinkSync(pluginPath)
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error
        }
      }
      writeFileSync(pluginPath, getOpenCodeFamilyPluginSource('/hook/mimo-code'))
      this.ownedPtyOverlays.set(ptyId, { target: configDir, rootIdentity })
    } catch {
      this.ownedPtyOverlays.delete(ptyId)
      return existingConfigDir ? { MIMOCODE_CONFIG_DIR: existingConfigDir } : {}
    }
    return { MIMOCODE_CONFIG_DIR: configDir }
  }

  private getPtyConfigDir(overlayRoot: string, ptyId: string): string {
    // Why: PTY IDs can originate outside this service; hashing keeps them from
    // selecting paths outside the Orca-owned overlay root.
    return join(overlayRoot, createHash('sha256').update(ptyId).digest('hex'))
  }
}

export const mimoCodeHookService = new MimoCodeHookService()
