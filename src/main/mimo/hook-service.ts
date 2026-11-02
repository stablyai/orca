import { getAppEnvironment } from '../../shared/app-environment'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { getOpenCodeFamilyPluginSource } from '../opencode/hook-service'
import { sourceOverlayDirName } from '../opencode/overlay-dir-names'
import {
  clearOpenCodeOverlayManifestEntries,
  readOpenCodeOverlayManifest,
  writeOpenCodeOverlayManifest,
  type OpenCodeOverlayManifest
} from '../opencode/opencode-overlay-manifest'
import { isSafeDescendCandidate, mirrorEntry, safeRemoveOverlay } from '../pty/overlay-mirror'

const ORCA_MIMOCODE_PLUGIN_FILE = 'orca-mimocode-status.js'
const MIMOCODE_HOOKS_DIR = 'mimocode-hooks'
const PLUGIN_ONLY_CONFIG_DIR = 'config'
const SOURCE_CONFIG_OVERLAYS_DIR = 'config-overlays'
const LEGACY_SHARED_HOME = 'shared'

function isDirectoryFollowingLinks(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function mirrorInto(sourcePath: string, targetDir: string, name: string): void {
  // MiMo may have created a same-named file in the overlay since the last launch.
  safeRemoveOverlay(join(targetDir, name), targetDir)
  mirrorEntry(sourcePath, join(targetDir, name))
}

// Keep MiMo-written overlay files (installed plugin deps); replace only what was mirrored last time.
function mirrorConfigDir(sourceConfigDir: string, targetConfigDir: string): void {
  clearOpenCodeOverlayManifestEntries(
    targetConfigDir,
    readOpenCodeOverlayManifest(targetConfigDir),
    ORCA_MIMOCODE_PLUGIN_FILE
  )
  const manifest: OpenCodeOverlayManifest = {
    topLevelEntries: [],
    pluginEntries: [],
    sourceConfigDir
  }
  for (const entry of readdirSync(sourceConfigDir, { withFileTypes: true })) {
    const sourcePath = join(sourceConfigDir, entry.name)
    // A linked plugins dir must not be linked through, or Orca's plugin lands in the user's folder.
    if (entry.name === 'plugins' && isDirectoryFollowingLinks(sourcePath)) {
      const overlayPlugins = join(targetConfigDir, 'plugins')
      if (!ensureRealDirectory(overlayPlugins)) {
        throw new Error('MiMo overlay plugins folder is not a real directory')
      }
      for (const pluginName of readdirSync(sourcePath)) {
        if (pluginName !== ORCA_MIMOCODE_PLUGIN_FILE) {
          mirrorInto(join(sourcePath, pluginName), overlayPlugins, pluginName)
          manifest.pluginEntries.push(pluginName)
        }
      }
      continue
    }
    mirrorInto(sourcePath, targetConfigDir, entry.name)
    manifest.topLevelEntries.push(entry.name)
  }
  writeOpenCodeOverlayManifest(targetConfigDir, manifest)
}

function ensureRealDirectory(path: string): boolean {
  mkdirSync(path, { recursive: true })
  return isSafeDescendCandidate(lstatSync(path))
}

export class MimoCodeHookService {
  clearPty(_ptyId: string): void {}

  /** MIMOCODE_CONFIG_DIR adds a config layer; MIMOCODE_HOME would also move auth and session data. */
  buildPtyEnv(_ptyId: string, existingConfigDir?: string): { MIMOCODE_CONFIG_DIR?: string } {
    const fallback = { MIMOCODE_CONFIG_DIR: existingConfigDir }
    const root = join(getAppEnvironment().getPath('userData'), MIMOCODE_HOOKS_DIR)
    const overlay = existingConfigDir
      ? join(root, SOURCE_CONFIG_OVERLAYS_DIR, sourceOverlayDirName(existingConfigDir))
      : join(root, PLUGIN_ONLY_CONFIG_DIR)
    try {
      if (!ensureRealDirectory(root) || !ensureRealDirectory(overlay)) {
        return fallback
      }
      if (existingConfigDir && existsSync(existingConfigDir)) {
        mirrorConfigDir(existingConfigDir, overlay)
      }
      const pluginsDir = join(overlay, 'plugins')
      if (!ensureRealDirectory(pluginsDir)) {
        return fallback
      }
      writeFileSync(
        join(pluginsDir, ORCA_MIMOCODE_PLUGIN_FILE),
        getOpenCodeFamilyPluginSource('/hook/mimo-code', { emitSessionStart: false })
      )
    } catch {
      return fallback
    }
    return { MIMOCODE_CONFIG_DIR: overlay }
  }

  /** Older builds kept MiMo data under Orca's MIMOCODE_HOME; move a login made there over once, then mark it migrated. */
  carryOverLegacyAuth(env: Record<string, string | undefined>): void {
    const legacyAuth = join(
      getAppEnvironment().getPath('userData'),
      MIMOCODE_HOOKS_DIR,
      LEGACY_SHARED_HOME,
      'data',
      'auth.json'
    )
    // MiMo rejects a relative MIMOCODE_HOME; Orca would otherwise write relative to its own cwd.
    if (env.MIMOCODE_HOME && !isAbsolute(env.MIMOCODE_HOME)) {
      return
    }
    // Mirrors MiMo's Global.Path.data resolution (xdg-basedir, or MIMOCODE_HOME/data).
    const dataDir = env.MIMOCODE_HOME
      ? join(env.MIMOCODE_HOME, 'data')
      : join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'mimocode')
    const auth = join(dataDir, 'auth.json')
    try {
      if (!existsSync(legacyAuth)) {
        return
      }
      if (!existsSync(auth)) {
        mkdirSync(dataDir, { recursive: true })
        copyFileSync(legacyAuth, auth, constants.COPYFILE_EXCL)
        chmodSync(auth, 0o600)
      }
      // Never restore the Orca-only login later, e.g. after the user deletes the canonical one.
      renameSync(legacyAuth, `${legacyAuth}.migrated`)
    } catch {
      // A failed carry-over leaves MiMo logged out, as before; never block the launch.
    }
  }
}

export const mimoCodeHookService = new MimoCodeHookService()
