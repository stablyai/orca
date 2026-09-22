const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const sharedRoot = path.resolve(projectRoot, '..', 'src', 'shared')

const config = getDefaultConfig(projectRoot)

// Why: mobile source-control prompts use the same pure builders as desktop.
// Metro only watches mobile/ by default, so make repo-root shared modules visible.
config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), sharedRoot]))

/**
 * The shell kind the bundle is being built for, by the same rule `mobileShellBuildKind` applies in
 * `src/storage/preferences.ts`. This read runs in Node at config time, so it is not the second
 * inlined read that module's census forbids.
 */
const shellBuildKind = process.env.EXPO_PUBLIC_MOBILE_SHELL === 'ota' ? 'ota' : 'native'

// Why: babel-preset-expo inlines EXPO_PUBLIC_MOBILE_SHELL at transform time, but nothing Metro
// hashes into the transform cache key carries that value, so a warm cache from the opposite kind
// silently bakes the wrong shell into a release.
config.cacheVersion = `${config.cacheVersion}-shell-${shellBuildKind}`

module.exports = config
