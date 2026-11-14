const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const sharedRoot = path.resolve(projectRoot, '..', 'src', 'shared')

const config = getDefaultConfig(projectRoot)

// Watch repo root: mobile source-control uses desktop’s pure prompt builders, outside Metro’s default mobile-only scope.
config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), sharedRoot]))

// RN 0.88 registers assets through the bare `react-native/asset-registry` import, which Metro resolves from
// the asset's own folder. Shared assets live outside mobile/, so fall back to mobile's react-native.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  'react-native': path.join(projectRoot, 'node_modules', 'react-native')
}

module.exports = config
