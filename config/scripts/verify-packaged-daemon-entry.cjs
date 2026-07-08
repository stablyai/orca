const { existsSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

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
  const entryPath = join(resourcesDir, 'app.asar.unpacked', 'out', 'main', 'daemon-entry.js')
  if (!existsSync(entryPath)) {
    // Why: some targets/layouts do not unpack here; skip rather than fail so
    // the hook stays safe across platforms it has not verified.
    console.log(`[verify-packaged-daemon-entry] skipped — no unpacked entry at ${entryPath}`)
    return
  }

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

module.exports = { verifyPackagedDaemonEntryBoots }
