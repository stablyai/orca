import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { ensureRelocatedRuntime } from './install-dir-runtime-relocation'

/**
 * Relocates node-pty's Windows native runtime (conpty.node, conpty.dll,
 * OpenConsole.exe, winpty binaries) from the install directory to userData.
 *
 * Why: the NSIS update installer force-closes every process whose image path
 * is under the install directory before replacing files. conpty.dll spawns
 * OpenConsole.exe from beside itself, so while these binaries live in the
 * install dir every live terminal's console host is killed mid-update.
 * Loading them from userData (via the ORCA_NODE_PTY_NATIVE_DIR override
 * patched into node-pty's loader) takes them out of the installer's kill
 * zone, and the detached daemon inherits the env var so its PTYs are covered.
 */
export const NODE_PTY_NATIVE_DIR_ENV_VAR = 'ORCA_NODE_PTY_NATIVE_DIR'

export function resolveNodePtyNativeSourceDir(nodePtyPackageDir: string): string | null {
  // Packaged builds carry the rebuilt binding in build/Release; dev installs
  // (and the forced-relocation test path) load from prebuilds.
  const candidates = [
    join(nodePtyPackageDir, 'build', 'Release'),
    join(nodePtyPackageDir, 'prebuilds', `win32-${process.arch}`)
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'conpty.node'))) {
      return candidate
    }
  }
  return null
}

export function installRelocatedNodePtyNativeRuntime(): void {
  if (process.platform !== 'win32') {
    return
  }
  if (!app.isPackaged && process.env.ORCA_FORCE_CONPTY_RELOCATION !== '1') {
    return
  }
  // Note: a pre-set env var is deliberately NOT honored here. The update
  // relaunch chain (old app -> installer -> new app) inherits the previous
  // version's value, which would pin the new process to stale binaries and
  // skip copying the current version.
  let nodePtyPackageDir: string
  try {
    const requireFromHere = createRequire(import.meta.url)
    nodePtyPackageDir = dirname(requireFromHere.resolve('node-pty/package.json'))
  } catch {
    return
  }
  const sourceDir = resolveNodePtyNativeSourceDir(nodePtyPackageDir)
  if (!sourceDir) {
    return
  }
  const userData = app.getPath('userData')
  const destDir = ensureRelocatedRuntime({
    sourceDir,
    destRoot: join(userData, 'node-pty-runtime'),
    version: app.getVersion(),
    // Keyed to daemon-init's runtimeDir (userData/daemon), where surviving
    // daemons write daemon-v<N>.pid recording the runtime version they pin.
    daemonRuntimeDir: join(userData, 'daemon')
  })
  if (destDir) {
    process.env[NODE_PTY_NATIVE_DIR_ENV_VAR] = destDir
  }
}
