const { existsSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

// Why: `asarUnpack` in config/electron-builder.config.cjs lists
// out/main/daemon-entry.js on every platform, and the packaged daemon fork
// (src/main/daemon/daemon-init.ts) resolves exactly this unpacked path. A
// missing entry means the package layout regressed, so the check throws
// instead of skipping — a silent skip false-passed exactly the layout bug
// this gate exists to catch.
function assertPackagedDaemonEntryExists(resourcesDir) {
  const entryPath = join(resourcesDir, 'app.asar.unpacked', 'out', 'main', 'daemon-entry.js')
  if (!existsSync(entryPath)) {
    throw new Error(
      `[verify-packaged-daemon-entry] missing unpacked daemon entry at ${entryPath} — ` +
        `asarUnpack expects out/main/daemon-entry.js on every platform, so the packaged ` +
        `daemon cannot be forked from this layout`
    )
  }
  return entryPath
}

// Why: v1.4.129-rc.1 shipped a terminal daemon that could not load (an electron
// `require` leaked into its bundle) while every build check passed. This boots
// the PACKAGED daemon-entry under plain Node against the asar-unpacked layout,
// so a bundling / asar-unpack regression fails packaging instead of reaching
// users. Module-load proof only: with no args the entry must reach argv parsing
// and print its "Usage: daemon-entry" error — a MODULE_NOT_FOUND or a missing
// usage line means the packaged graph does not load and the build must fail.
//
// resourcesDir is the packaged Resources dir (Contents/Resources on macOS,
// <appOutDir>/resources elsewhere). execPath defaults to the packaging Node.
function verifyPackagedDaemonEntryBoots(resourcesDir, options = {}) {
  const execPath = options.execPath || process.execPath
  const entryPath = assertPackagedDaemonEntryExists(resourcesDir)

  const result = spawnSync(execPath, [entryPath], { encoding: 'utf8', timeout: 10_000 })
  if (result.error) {
    throw new Error(
      `[verify-packaged-daemon-entry] could not launch daemon-entry.js: ${result.error.message}`
    )
  }
  const stderr = result.stderr || ''
  if (/Cannot find module|MODULE_NOT_FOUND/.test(stderr)) {
    throw new Error(
      `[verify-packaged-daemon-entry] packaged daemon-entry.js failed to load under plain Node:\n${stderr}`
    )
  }
  if (!stderr.includes('Usage: daemon-entry')) {
    throw new Error(
      `[verify-packaged-daemon-entry] packaged daemon-entry.js did not reach argv parsing ` +
        `(expected the "Usage: daemon-entry" error). stderr:\n${stderr}`
    )
  }
  console.log('[verify-packaged-daemon-entry] OK — packaged daemon-entry loads under plain Node')
}

module.exports = { assertPackagedDaemonEntryExists, verifyPackagedDaemonEntryBoots }
