import { getAppEnvironment } from '../../shared/app-environment'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { getOpenCodeFamilyPluginSource } from '../opencode/hook-service'
import {
  ensureOverlayDirectory,
  mirrorEntry,
  mirrorPluginDirectory,
  safeRemoveTree
} from '../pty/overlay-mirror'

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
  for (const entry of readdirSync(sourceConfigDir, { withFileTypes: true })) {
    const sourcePath = join(sourceConfigDir, entry.name)
    if (
      entry.name === 'plugins' &&
      mirrorPluginDirectory(
        sourcePath,
        join(targetConfigDir, 'plugins'),
        entry,
        ORCA_MIMOCODE_PLUGIN_FILE
      ) !== null
    ) {
      continue
    }
    mirrorEntry(sourcePath, join(targetConfigDir, entry.name))
  }
}

export class MimoCodeHookService {
  clearPty(_ptyId: string): void {}

  buildPtyEnv(_ptyId: string, existingMimocodeHome?: string): Record<string, string> {
    // Why: MiMo currently uses a shared home; per-source subdirs can come
    // later if concurrent MiMo panes need isolated runtime state.
    const home = join(
      getAppEnvironment().getPath('userData'),
      MIMOCODE_HOOKS_DIR,
      MIMOCODE_SHARED_HOME
    )
    try {
      for (const sub of ['config', 'data', 'cache', 'state'] as const) {
        mkdirSync(join(home, sub), { recursive: true })
      }
      const overlayConfig = join(home, 'config')
      const sourceConfig = resolveSourceConfigDir(existingMimocodeHome)
      if (sourceConfig) {
        safeRemoveTree(overlayConfig)
      }
      ensureOverlayDirectory(overlayConfig)
      if (sourceConfig) {
        mirrorConfigDir(sourceConfig, overlayConfig)
      }
      const pluginsDir = join(home, 'config', 'plugins')
      ensureOverlayDirectory(pluginsDir)
      const pluginPath = join(pluginsDir, ORCA_MIMOCODE_PLUGIN_FILE)
      try {
        unlinkSync(pluginPath)
      } catch (error) {
        if (!isDefinitiveAbsence(error)) {
          throw error
        }
      }
      writeFileSync(
        pluginPath,
        getOpenCodeFamilyPluginSource('/hook/mimo-code', { emitSessionStart: false }),
        { flag: 'wx' }
      )
    } catch {
      return existingMimocodeHome ? { MIMOCODE_HOME: existingMimocodeHome } : {}
    }
    return { MIMOCODE_HOME: home }
  }
}

export const mimoCodeHookService = new MimoCodeHookService()
