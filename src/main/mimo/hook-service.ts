import { getAppEnvironment } from '../../shared/app-environment'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { getOpenCodeFamilyPluginSource } from '../opencode/hook-service'
import { mirrorEntry, safeRemoveTree } from '../pty/overlay-mirror'
import { resolveMimocodeDirectories, type MimocodeDirectories } from './mimocode-directories'

const ORCA_MIMOCODE_PLUGIN_FILE = 'orca-mimocode-status.js'
const MIMOCODE_HOOKS_DIR = 'mimocode-hooks'
// Why: keep the old overlay intact because it may contain MiMo data created before source-backed runtime directories were introduced.
const MIMOCODE_SOURCE_HOME_PREFIX = 'source-'

function sourceHomeName(sourceDirectories: MimocodeDirectories): string {
  const sourceKey = JSON.stringify(sourceDirectories)
  const digest = createHash('sha256').update(sourceKey).digest('hex').slice(0, 16)
  return `${MIMOCODE_SOURCE_HOME_PREFIX}${digest}`
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

  buildPtyEnv(
    _ptyId: string,
    existingMimocodeHome?: string,
    environment: Record<string, string> = {}
  ): Record<string, string> {
    try {
      const sourceDirectories = resolveMimocodeDirectories(existingMimocodeHome, environment)
      const home = join(
        getAppEnvironment().getPath('userData'),
        MIMOCODE_HOOKS_DIR,
        sourceHomeName(sourceDirectories)
      )
      mkdirSync(home, { recursive: true })
      for (const sub of ['data', 'cache', 'state'] as const) {
        mkdirSync(sourceDirectories[sub], { recursive: true })
        safeRemoveTree(join(home, sub))
        mirrorEntry(sourceDirectories[sub], join(home, sub))
      }
      const overlayConfig = join(home, 'config')
      safeRemoveTree(overlayConfig)
      if (existsSync(sourceDirectories.config)) {
        mirrorConfigDir(sourceDirectories.config, overlayConfig)
      } else {
        mkdirSync(overlayConfig, { recursive: true })
      }
      const pluginsDir = join(home, 'config', 'plugins')
      mkdirSync(pluginsDir, { recursive: true })
      writeFileSync(
        join(pluginsDir, ORCA_MIMOCODE_PLUGIN_FILE),
        getOpenCodeFamilyPluginSource('/hook/mimo-code', { emitSessionStart: false })
      )
      return { MIMOCODE_HOME: home }
    } catch {
      return existingMimocodeHome ? { MIMOCODE_HOME: existingMimocodeHome } : {}
    }
  }
}

export const mimoCodeHookService = new MimoCodeHookService()
