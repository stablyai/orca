const { existsSync, readdirSync, renameSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const {
  NATIVE_BUILD_PACKAGES,
  isNativeBuildEntryName,
  nativeBuildEntryName
} = require('./scripts/native-build-entry.cjs')

// Normalize shared-store dev build/<entry> to packaged build/Release, matching CI and daemon/mac terminal/job-ownership consumers (scripts/native-build-entry.cjs).
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
