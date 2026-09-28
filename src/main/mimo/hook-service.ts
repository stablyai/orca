import { getAppEnvironment } from '../../shared/app-environment'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { getOpenCodeFamilyPluginSource } from '../opencode/hook-service'
import { writeManagedConfigFile } from '../pty/managed-config-file'
import {
  ensureOverlayDirectory,
  isSameOverlayPath,
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
      const resolvedSource = resolveSourceConfigDir(existingMimocodeHome)
      // A pane spawned from a MiMo pane inherits MIMOCODE_HOME=<overlay>, which
      // resolves back to this shared overlay. Tearing it down and re-mirroring
      // from itself would strip every pane's view of the user's real config.
      const sourceConfig =
        resolvedSource && !isSameOverlayPath(resolvedSource, overlayConfig)
          ? resolvedSource
          : undefined
      if (sourceConfig) {
        safeRemoveTree(overlayConfig)
      }
      ensureOverlayDirectory(overlayConfig)
      if (sourceConfig) {
        mirrorConfigDir(sourceConfig, overlayConfig)
      }
      const pluginsDir = join(home, 'config', 'plugins')
      ensureOverlayDirectory(pluginsDir)
      // Exclusive create: MiMo's overlay is a single shared home, so a losing
      // concurrent write is a no-op rather than a pane left without its plugin.
      writeManagedConfigFile(
        join(pluginsDir, ORCA_MIMOCODE_PLUGIN_FILE),
        getOpenCodeFamilyPluginSource('/hook/mimo-code', { emitSessionStart: false }),
        { exclusive: true }
      )
    } catch {
      return existingMimocodeHome ? { MIMOCODE_HOME: existingMimocodeHome } : {}
    }
    return { MIMOCODE_HOME: home }
  }
}

export const mimoCodeHookService = new MimoCodeHookService()
