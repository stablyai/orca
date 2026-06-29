import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { getOpenCodeFamilyPluginSource } from '../opencode/hook-service'
import { mirrorEntry, safeRemoveTree } from '../pty/overlay-mirror'

const ORCA_MIMOCODE_PLUGIN_FILE = 'orca-mimocode-status.js'
const MIMOCODE_HOOKS_DIR = 'mimocode-hooks'
const MIMOCODE_SHARED_HOME = 'shared'

function defaultMimocodeConfigDir(): string {
  return join(homedir(), '.config', 'mimocode')
}

function resolveSourceConfigDir(existingHome: string | undefined): string | undefined {
  if (existingHome) {
    const fromHome = join(existingHome, 'config')
    if (existsSync(fromHome)) {
      return fromHome
    }
  }
  const xdg = defaultMimocodeConfigDir()
  return existsSync(xdg) ? xdg : undefined
}

function mirrorConfigDir(sourceConfigDir: string, targetConfigDir: string): void {
  mkdirSync(targetConfigDir, { recursive: true })
  for (const entry of readdirSync(sourceConfigDir, { withFileTypes: true })) {
    if (entry.name === 'plugins' && entry.isDirectory()) {
      const overlayPlugins = join(targetConfigDir, 'plugins')
      mkdirSync(overlayPlugins, { recursive: true })
      for (const pluginEntry of readdirSync(join(sourceConfigDir, 'plugins'), {
        withFileTypes: true
      })) {
        if (pluginEntry.name === ORCA_MIMOCODE_PLUGIN_FILE) {
          continue
        }
        mirrorEntry(
          join(sourceConfigDir, 'plugins', pluginEntry.name),
          join(overlayPlugins, pluginEntry.name)
        )
      }
      continue
    }
    mirrorEntry(join(sourceConfigDir, entry.name), join(targetConfigDir, entry.name))
  }
}

export class MimoCodeHookService {
  clearPty(_ptyId: string): void {}

  buildPtyEnv(_ptyId: string, existingMimocodeHome?: string): Record<string, string> {
    // Why: MiMo currently uses a shared home; per-source subdirs can come
    // later if concurrent MiMo panes need isolated runtime state.
    const home = join(app.getPath('userData'), MIMOCODE_HOOKS_DIR, MIMOCODE_SHARED_HOME)
    try {
      for (const sub of ['config', 'data', 'cache', 'state'] as const) {
        mkdirSync(join(home, sub), { recursive: true })
      }
      const overlayConfig = join(home, 'config')
      const sourceConfig = resolveSourceConfigDir(existingMimocodeHome)
      if (sourceConfig) {
        safeRemoveTree(overlayConfig)
        mirrorConfigDir(sourceConfig, overlayConfig)
      }
      const pluginsDir = join(home, 'config', 'plugins')
      mkdirSync(pluginsDir, { recursive: true })
      writeFileSync(
        join(pluginsDir, ORCA_MIMOCODE_PLUGIN_FILE),
        getOpenCodeFamilyPluginSource('/hook/mimo-code')
      )
    } catch {
      return existingMimocodeHome ? { MIMOCODE_HOME: existingMimocodeHome } : {}
    }
    return { MIMOCODE_HOME: home }
  }
}

export const mimoCodeHookService = new MimoCodeHookService()
