// pnpm installs local native packages under node_modules/.pnpm, which the fingerprint skips as
// nested node_modules; hash their sources here so native edits still invalidate builds.
const localNativePackageSources = ['expo-two-way-audio', 'expo-iroh'].flatMap((name) =>
  ['android', 'ios', 'expo-module.config.json'].map((entry) => ({
    type: entry.includes('.') ? 'file' : 'dir',
    filePath: `packages/${name}/${entry}`,
    reasons: ['localNativePackage']
  }))
)

module.exports = {
  extraSources: localNativePackageSources,
  // These never change native code but would force a dev-client rebuild: package.json scripts,
  // .gitignore, and the version/build numbers that release bump PRs and fastlane rewrite.
  sourceSkips: ['PackageJsonScriptsAll', 'GitIgnore', 'ExpoConfigVersions']
}
