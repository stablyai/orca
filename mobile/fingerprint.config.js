// pnpm installs the local native package under node_modules/.pnpm, which the fingerprint skips as a
// nested node_modules; hash its sources here so native edits to it still invalidate builds.
const localNativePackageSources = ['android', 'ios', 'expo-module.config.json'].map((entry) => ({
  type: entry.includes('.') ? 'file' : 'dir',
  filePath: `packages/expo-two-way-audio/${entry}`,
  reasons: ['localNativePackage']
}))

module.exports = {
  extraSources: localNativePackageSources,
  // These never change native code but would force a dev-client rebuild: package.json scripts,
  // .gitignore, and the version/build numbers that release bump PRs and fastlane rewrite.
  sourceSkips: ['PackageJsonScriptsAll', 'GitIgnore', 'ExpoConfigVersions']
}
