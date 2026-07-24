import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { getOpenCodeFamilyPluginSource } from '../opencode/hook-service'
import {
  ConfigOverlayCapacityError,
  applyConfigOverlayPlan,
  createConfigOverlayPlan
} from '../pty/config-overlay-mirroring'
import { safeRemoveTree } from '../pty/overlay-mirror'

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

export class MimoCodeHookService {
  private warnedOverlayCapacity = false

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
        const plan = createConfigOverlayPlan(sourceConfig, {
          reservedPluginFile: ORCA_MIMOCODE_PLUGIN_FILE
        })
        if (!safeRemoveTree(overlayConfig)) {
          throw new Error('Unable to clear the MiMo config overlay')
        }
        mkdirSync(overlayConfig, { recursive: true })
        applyConfigOverlayPlan(plan, overlayConfig)
      }
      const pluginsDir = join(home, 'config', 'plugins')
      mkdirSync(pluginsDir, { recursive: true })
      const pluginPath = join(pluginsDir, ORCA_MIMOCODE_PLUGIN_FILE)
      try {
        unlinkSync(pluginPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
      writeFileSync(pluginPath, getOpenCodeFamilyPluginSource('/hook/mimo-code'))
    } catch (error) {
      if (!this.warnedOverlayCapacity && error instanceof ConfigOverlayCapacityError) {
        this.warnedOverlayCapacity = true
        console.warn(
          '[mimocode-hooks] config overlay exceeded its memory limit; using the original MiMo home without Orca status integration'
        )
      }
      return existingMimocodeHome ? { MIMOCODE_HOME: existingMimocodeHome } : {}
    }
    return { MIMOCODE_HOME: home }
  }
}

export const mimoCodeHookService = new MimoCodeHookService()
