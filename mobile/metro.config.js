// Why: mobile i18n imports the desktop's zh.json from a sibling package.
// Metro must watch the workspace root and resolve modules from there too,
// otherwise `import zh from '../../../src/renderer/src/i18n/locales/zh.json'`
// fails at bundle time.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '..')
// Why: mobile source-control prompts use the same pure builders as desktop.
// Metro only watches mobile/ by default, so make repo-root shared modules visible.
const sharedRoot = path.resolve(projectRoot, '..', 'src', 'shared')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot, sharedRoot]

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules')
]

config.resolver.disableHierarchicalLookup = true

module.exports = config
