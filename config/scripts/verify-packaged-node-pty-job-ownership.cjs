const { existsSync } = require('node:fs')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const {
  assertNodePtyJobOwnership,
  assertCygwinBreakawayDenied,
  nodePtyAddonPath
} = require('./node-pty-job-ownership.cjs')

/** Where electron-builder lands the addon; the only layout `loadPackagedConpty` produces. */
function packagedConptyPath(resourcesDir) {
  return join(resourcesDir, 'node_modules', 'node-pty', 'build', 'Release', 'conpty.node')
}

/** The last entry in node-pty's loader order, and the one the published tarball fills. */
function prebuiltConptyPath(resourcesDir, arch) {
  return arch
    ? join(resourcesDir, 'node_modules', 'node-pty', 'prebuilds', `win32-${arch}`, 'conpty.node')
    : null
}

function loadPackagedConpty(resourcesDir) {
  const packagedRequire = createRequire(join(resourcesDir, 'package.json'))
  const utilsPath = packagedRequire.resolve('./node_modules/node-pty/lib/utils')
  const { loadNativeModule } = packagedRequire(utilsPath)
  const native = loadNativeModule('conpty')
  return { native, addonPath: nodePtyAddonPath(utilsPath, native, 'conpty') }
}

function verifyPackagedNodePtyJobOwnership(resourcesDir, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return
  }

  const { native, addonPath } = (options.loadNative ?? loadPackagedConpty)(resourcesDir)
  assertNodePtyJobOwnership({ platform, nativeName: 'conpty', native, addonPath })
  if (!native.dir.replace(/\\/g, '/').includes('build/Release/')) {
    throw new Error(`Packaged node-pty resolved to ${native.dir}; expected patched build/Release`)
  }
  console.log('[verify-packaged-node-pty] OK — packaged ConPTY owns process trees')
}

/**
 * The half of the packaged check that survives a cross-host build.
 *
 * The export check has to load the addon, so it cannot run when the packaging
 * host is not the target platform/arch -- and that skip is how a Windows
 * release built elsewhere could ship a node-pty that leaks every MSYS pane
 * child out of its job. Reading the binary needs neither.
 *
 * Absence is logged rather than thrown ONLY when nothing else would load: an
 * unrecognised layout must not fail a release that was packaging fine, and the
 * export check still covers the same-host case. A binary that IS there and
 * lacks the marker is fatal.
 *
 * Why the prebuild is checked too: node-pty's loader falls through
 * build/Release -> build/Debug -> prebuilds/<platform>-<arch>, so a package
 * with no build/Release addon loads the prebuild -- and the published prebuild
 * has never carried the breakaway denial. Warning there would pass exactly the
 * package that ships the bug.
 */
function verifyPackagedConptyBreakawayMarker(resourcesDir, options = {}) {
  // Deliberately no host-platform gate: the caller has already established that
  // the *target* is Windows, and gating on the host is the very skip this
  // closes.
  const exists = options.exists ?? existsSync
  const addonPath = (options.packagedConptyPath ?? packagedConptyPath)(resourcesDir)
  if (!exists(addonPath)) {
    const fallbackPath = (options.prebuiltConptyPath ?? prebuiltConptyPath)(
      resourcesDir,
      options.arch
    )
    if (fallbackPath && exists(fallbackPath)) {
      assertCygwinBreakawayDenied(fallbackPath, { dir: fallbackPath })
      console.log(
        '[verify-packaged-node-pty] OK — packaged ConPTY denies MSYS job breakaway (prebuild fallback)'
      )
      return
    }
    console.warn(
      `[verify-packaged-node-pty] no addon at ${addonPath}; could not check the MSYS ` +
        'job-breakaway denial for this cross-host package.'
    )
    return
  }
  assertCygwinBreakawayDenied(addonPath, { dir: addonPath })
  console.log('[verify-packaged-node-pty] OK — packaged ConPTY denies MSYS job breakaway')
}

module.exports = { verifyPackagedNodePtyJobOwnership, verifyPackagedConptyBreakawayMarker }
