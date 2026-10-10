const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

// Keep in sync with NATIVE_PROCESS_INFO_BUILD_PATH / _RESOURCE_PATH in src/shared/native-process-info.ts.
const PROC_INFO_ADDON_BUILD_PATH = 'native/proc-info-darwin/.build/release/orca-proc-info.node'
const PROC_INFO_ADDON_RESOURCE_PATH = 'native/orca-proc-info.node'

const procInfoMacExtraResource = {
  from: PROC_INFO_ADDON_BUILD_PATH,
  to: PROC_INFO_ADDON_RESOURCE_PATH
}

const LIPO_ARCH_BY_ELECTRON_ARCH = { 1: 'x86_64', 3: 'arm64' }

// Why a guard: electron-builder only warns on a missing extraResources source, and the app would
// silently return to blocking ps calls for explicit terminal repaint signals.
function assertProcInfoAddonBuilt(platform, arch, projectDir = join(__dirname, '..')) {
  if (platform !== 'darwin') {
    return
  }
  const addonPath = join(projectDir, PROC_INFO_ADDON_BUILD_PATH)
  if (!existsSync(addonPath)) {
    throw new Error(
      `Missing ${PROC_INFO_ADDON_BUILD_PATH}; run pnpm run build:proc-info-macos before packaging.`
    )
  }
  const required = LIPO_ARCH_BY_ELECTRON_ARCH[arch]
  const slices = execFileSync('lipo', ['-archs', addonPath], { encoding: 'utf8' })
    .trim()
    .split(/\s+/)
  // Why universal also needs x86_64: that artifact runs on both architectures.
  const missing = (arch === 4 ? ['arm64', 'x86_64'] : [required]).filter(
    (slice) => slice && !slices.includes(slice)
  )
  if (missing.length > 0) {
    throw new Error(
      `${PROC_INFO_ADDON_BUILD_PATH} lacks ${missing.join(', ')} (has ${slices.join(', ')})`
    )
  }
}

module.exports = {
  PROC_INFO_ADDON_BUILD_PATH,
  PROC_INFO_ADDON_RESOURCE_PATH,
  assertProcInfoAddonBuilt,
  procInfoMacExtraResource
}
