import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { getOpenCodeFamilyPluginSource } from '../opencode/hook-service'
import { mirrorEntry, safeRemoveTree } from '../pty/overlay-mirror'

const ORCA_KILO_PLUGIN_FILE = 'orca-kilo-status.js'
const KILO_HOOKS_DIR = 'kilo-hooks'
const KILO_SHARED_CONFIG = 'shared'

function defaultKiloConfigDir(): string {
  // Why: Kilo 1.0 reads global config from ~/.config/kilo (XDG); Windows uses the same layout under the user profile.
  return process.env.XDG_CONFIG_HOME?.trim()
    ? join(process.env.XDG_CONFIG_HOME.trim(), 'kilo')
    : join(homedir(), '.config', 'kilo')
}

function resolveSourceConfigDir(existingConfigDir: string | undefined): string | undefined {
  if (existingConfigDir && existsSync(existingConfigDir)) {
    return existingConfigDir
  }
  const xdg = defaultKiloConfigDir()
  return existsSync(xdg) ? xdg : undefined
}

function mirrorConfigDir(sourceConfigDir: string, targetConfigDir: string): void {
  mkdirSync(targetConfigDir, { recursive: true })
  for (const entry of readdirSync(sourceConfigDir, { withFileTypes: true })) {
    if (
      (entry.name === 'plugins' || entry.name === 'plugin') &&
      entry.isDirectory()
    ) {
      const overlayPlugins = join(targetConfigDir, entry.name)
      mkdirSync(overlayPlugins, { recursive: true })
      for (const pluginEntry of readdirSync(join(sourceConfigDir, entry.name), {
        withFileTypes: true
      })) {
        if (pluginEntry.name === ORCA_KILO_PLUGIN_FILE) {
          continue
        }
        mirrorEntry(
          join(sourceConfigDir, entry.name, pluginEntry.name),
          join(overlayPlugins, pluginEntry.name)
        )
      }
      continue
    }
    mirrorEntry(join(sourceConfigDir, entry.name), join(targetConfigDir, entry.name))
  }
}

export class KiloHookService {
  clearPty(_ptyId: string): void {}

  buildPtyEnv(_ptyId: string, existingConfigDir?: string): Record<string, string> {
    // Why: KILO_CONFIG_DIR is additive for Kilo's config loader, so a shared overlay with
    // Orca's status plugin coexists with ~/.config/kilo without replacing user auth/models.
    const configDir = join(app.getPath('userData'), KILO_HOOKS_DIR, KILO_SHARED_CONFIG)
    try {
      mkdirSync(configDir, { recursive: true })
      const sourceConfig = resolveSourceConfigDir(existingConfigDir)
      if (sourceConfig) {
        safeRemoveTree(configDir)
        mirrorConfigDir(sourceConfig, configDir)
      }
      // Why: Kilo auto-loads every .js/.ts under plugins/ (and legacy plugin/) at startup.
      const pluginsDir = join(configDir, 'plugins')
      mkdirSync(pluginsDir, { recursive: true })
      writeFileSync(
        join(pluginsDir, ORCA_KILO_PLUGIN_FILE),
        getOpenCodeFamilyPluginSource('/hook/kilo')
      )
    } catch {
      return existingConfigDir ? { KILO_CONFIG_DIR: existingConfigDir } : {}
    }
    return { KILO_CONFIG_DIR: configDir }
  }
}

export const kiloHookService = new KiloHookService()
