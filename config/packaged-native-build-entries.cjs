const { existsSync, readdirSync, renameSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const {
  NATIVE_BUILD_PACKAGES,
  isNativeBuildEntryName,
  nativeBuildEntryName
} = require('./scripts/native-build-entry.cjs')

/**
 * Ship a dev install's per-ABI native build as build/Release.
 *
 * A package dir shared across worktrees (pnpm's global virtual store) holds Orca's source build
 * in build/<entry> rather than build/Release; see scripts/native-build-entry.cjs. Packaged
 * consumers (daemon relocation, the macOS terminal host, the job-ownership gate) all read
 * build/Release, so the packaged copy gets exactly the layout a CI install produces.
 */
function adoptPackagedNativeBuildEntries(resourcesDir, electronPlatformName, architecture) {
  for (const moduleName of Object.keys(NATIVE_BUILD_PACKAGES)) {
    const buildDir = join(resourcesDir, 'node_modules', ...moduleName.split('/'), 'build')
    if (!existsSync(buildDir)) {
      continue
    }
    const entryDir = join(
      buildDir,
      nativeBuildEntryName(moduleName, { platform: electronPlatformName, arch: architecture })
    )
    if (existsSync(entryDir)) {
      rmSync(join(buildDir, 'Release'), { recursive: true, force: true })
      renameSync(entryDir, join(buildDir, 'Release'))
    }
    // Other arches, plus any staging or quarantine leftovers, are dead weight in this slice.
    for (const name of readdirSync(buildDir)) {
      if (isNativeBuildEntryName(name)) {
        rmSync(join(buildDir, name), { recursive: true, force: true })
      }
    }
  }
}

module.exports = { adoptPackagedNativeBuildEntries }
