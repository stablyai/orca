import { spawnSync } from 'node:child_process'
import { parseMissingSharedLibrary } from '../../src/shared/missing-shared-library.ts'

// Enough for Electron to start on clean ubuntu:24.04 and debian:12 images; the loader names only
// one missing library per run. Why t64: on Ubuntu 24.04+ plain `libasound2` is a virtual package.
const ELECTRON_LINUX_RUNTIME_PACKAGES = [
  'libgtk-3-0t64',
  'libatk1.0-0t64',
  'libatk-bridge2.0-0t64',
  'libatspi2.0-0t64',
  'libcups2t64',
  'libxdamage1',
  'libasound2t64',
  'libnss3',
  'libgbm1'
]

/**
 * The shared library that stops `executable` from starting at all, or null when it starts.
 * Why separate from the addon probe: that probe runs inside Electron, so a host missing GTK
 * reported every freshly built addon as broken.
 */
export function findMissingElectronLibrary(executable, { run = spawnSync } = {}) {
  const result = run(executable, ['-e', ''], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000
  })
  if (result.error || result.status === 0) {
    return null
  }
  return parseMissingSharedLibrary(`${result.stderr ?? ''}\n${result.stdout ?? ''}`)
}

function describeMissingElectronLibrary(library) {
  return (
    `Electron can't start on this host: ${library} is missing, so native modules can't be ` +
    'checked against it. On Debian/Ubuntu run `sudo apt-get install -y ' +
    `${ELECTRON_LINUX_RUNTIME_PACKAGES.join(' ')}\` (on Ubuntu 23.10 or Debian 12 and ` +
    'earlier, drop the `t64` suffixes), then `pnpm run rebuild:electron`.'
  )
}

const ENSURE_RUNTIME_NOTE =
  'Electron-consuming package scripts and release jobs run ' +
  'config/scripts/ensure-native-runtime.mjs --runtime=electron before launching Electron.'

function isPostinstall() {
  return process.env.npm_lifecycle_event === 'postinstall'
}

export function continuePostinstallWithoutElectron() {
  if (!isPostinstall() || process.env.ORCA_STRICT_ELECTRON_INSTALL === '1') {
    return false
  }
  console.error(
    `[rebuild] Continuing postinstall because Electron binary installation failed. ${ENSURE_RUNTIME_NOTE}`
  )
  return true
}

/**
 * A host without Electron's desktop libraries can't vouch for any addon, so none is blamed.
 * Returns what can vouch: a forced build (e.g. electron-builder's hook) must not need Electron,
 * so it gets Node, which loads an N-API build as well, instead of an exit.
 */
export function exitWhenElectronCannotStart(executable, { forced = false } = {}) {
  const library = findMissingElectronLibrary(executable)
  if (!library) {
    return executable
  }
  if (forced) {
    console.log(`[rebuild] Electron can't start here without ${library}; checking in Node instead.`)
    return process.execPath
  }
  console.error(`[rebuild] ${describeMissingElectronLibrary(library)}`)
  if (isPostinstall() && process.env.ORCA_STRICT_NATIVE_REBUILD !== '1') {
    console.error(`[rebuild] Continuing postinstall. ${ENSURE_RUNTIME_NOTE}`)
    process.exit(0)
  }
  process.exit(1)
}
