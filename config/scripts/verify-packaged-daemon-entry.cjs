const { existsSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

function assertPackagedDaemonEntryExists(resourcesDir, platform = process.platform) {
  const entryPath = join(resourcesDir, 'terminal-daemon', 'daemon-entry.js')
  if (!existsSync(entryPath)) {
    throw new Error(
      `[verify-packaged-daemon-entry] missing terminal daemon entry at ${entryPath}; run build:terminal-daemon`
    )
  }
  if (
    platform === 'win32' &&
    !existsSync(join(resourcesDir, 'terminal-daemon', 'windows-bun-pty-gate-entry.js'))
  ) {
    throw new Error(
      '[verify-packaged-daemon-entry] missing Windows Bun PTY gate; run build:terminal-daemon'
    )
  }
  return entryPath
}

// Check the real resource layout with its shipped runtime before signing.
function verifyPackagedDaemonEntryBoots(resourcesDir, options = {}) {
  const platform = options.platform ?? process.platform
  const execPath =
    options.execPath ??
    join(resourcesDir, 'cli-runtime', platform === 'win32' ? 'bun-runtime.exe' : 'bun-runtime')
  const entryPath = assertPackagedDaemonEntryExists(resourcesDir, platform)

  const result = spawnSync(execPath, [entryPath], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  if (result.error) {
    throw new Error(
      `[verify-packaged-daemon-entry] could not launch daemon-entry.js: ${result.error.message}`
    )
  }
  const stderr = result.stderr || ''
  if (/Cannot find module|MODULE_NOT_FOUND/.test(stderr)) {
    throw new Error(
      `[verify-packaged-daemon-entry] packaged daemon-entry.js failed to load under bundled Bun:\n${stderr}`
    )
  }
  if (!stderr.includes('Usage: daemon-entry')) {
    throw new Error(
      `[verify-packaged-daemon-entry] packaged daemon-entry.js did not reach argv parsing ` +
        `(expected the "Usage: daemon-entry" error). stderr:\n${stderr}`
    )
  }
  console.log('[verify-packaged-daemon-entry] OK — packaged daemon-entry loads under bundled Bun')
}

module.exports = { assertPackagedDaemonEntryExists, verifyPackagedDaemonEntryBoots }
