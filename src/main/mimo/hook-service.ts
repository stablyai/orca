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
import { getOpenCodeFamilyPluginSource } from '../opencode/hook-service'
import { mirrorEntry, safeRemoveTree } from '../pty/overlay-mirror'

const ORCA_MIMOCODE_PLUGIN_FILE = 'orca-mimocode-status.js'
const MIMOCODE_CONFIG_OVERLAYS_DIR = 'mimocode-config-overlays'
const MIMOCODE_SHARED_CONFIG_DIR = 'shared'

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

function pathsReferToSameEntity(sourcePath: string, targetPath: string): boolean {
  if (comparablePath(sourcePath) === comparablePath(targetPath)) {
    return true
  }
  try {
    return comparablePath(realpathSync(sourcePath)) === comparablePath(realpathSync(targetPath))
  } catch {
    return false
  }
}

function isOwnedOverlayTarget(targetPath: string, overlayRoot: string): boolean {
  const rel = relative(resolve(overlayRoot), resolve(targetPath))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function mirrorConfigDir(sourceConfigDir: string, targetConfigDir: string): void {
  mkdirSync(targetConfigDir, { recursive: true })
  for (const entry of readdirSync(sourceConfigDir, { withFileTypes: true })) {
    if (['auth.json', 'data', 'cache', 'state'].includes(entry.name)) {
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
  clearPty(_ptyId: string): void {}

  buildPtyEnv(_ptyId: string, existingConfigDir?: string): Record<string, string> {
    // Why: only config is overlaid so MiMo keeps canonical ownership of auth,
    // sessions, memory, and other runtime data outside Orca's userData.
    const overlayRoot = join(app.getPath('userData'), MIMOCODE_CONFIG_OVERLAYS_DIR)
    const configDir = join(overlayRoot, MIMOCODE_SHARED_CONFIG_DIR)
    const sourceConfig = resolveSourceConfigDir(existingConfigDir)
    if (sourceConfig && pathsReferToSameEntity(sourceConfig, configDir)) {
      return existingConfigDir ? { MIMOCODE_CONFIG_DIR: existingConfigDir } : {}
    }
    if (!isOwnedOverlayTarget(configDir, overlayRoot)) {
      return existingConfigDir ? { MIMOCODE_CONFIG_DIR: existingConfigDir } : {}
    }
    try {
      ensureRealDirectory(overlayRoot)
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
    } catch {
      return existingConfigDir ? { MIMOCODE_CONFIG_DIR: existingConfigDir } : {}
    }
    return { MIMOCODE_CONFIG_DIR: configDir }
  }
}

export const mimoCodeHookService = new MimoCodeHookService()
