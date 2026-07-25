const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const sharedRoot = path.resolve(projectRoot, '..', 'src', 'shared')
// Bundled pet sprite sheets live in repo-root resources/, not mobile/assets,
// so the desktop and the app ship byte-identical art from one source.
const petAssetsRoot = path.resolve(projectRoot, '..', 'resources', 'pets')

const config = getDefaultConfig(projectRoot)

// Why: mobile source-control prompts use the same pure builders as desktop.
// Metro only watches mobile/ by default, so make repo-root shared modules visible.
config.watchFolders = Array.from(
  new Set([...(config.watchFolders ?? []), sharedRoot, petAssetsRoot])
)
// Why: .webp is not in Metro's default asset list on every version; sprite
// sheets silently failing to resolve would render an invisible pet.
if (!config.resolver.assetExts.includes('webp')) {
  config.resolver.assetExts.push('webp')
}

module.exports = config
