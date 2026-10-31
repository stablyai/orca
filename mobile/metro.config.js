const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const sharedRoot = path.resolve(projectRoot, '..', 'src', 'shared')
const pushContractRoot = path.resolve(
  projectRoot,
  '..',
  'cloud',
  'packages',
  'push-contract',
  'src'
)

const config = getDefaultConfig(projectRoot)

// Prompt builders and the signed push contract live outside Metro's mobile project root.
config.watchFolders = Array.from(
  new Set([...(config.watchFolders ?? []), sharedRoot, pushContractRoot])
)

module.exports = config
