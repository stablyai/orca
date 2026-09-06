const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const sharedRoot = path.resolve(projectRoot, '..', 'src', 'shared')
const mobileWebRoot = path.resolve(projectRoot, '..', 'src', 'mobile-web')
const disabledPageStorage = path.resolve(
  projectRoot,
  'src',
  'mobile-web',
  'disabled-page-async-storage.ts'
)
const disabledPageClientContext = path.resolve(
  projectRoot,
  'src',
  'mobile-web',
  'disabled-page-client-context.tsx'
)
const disabledPageHostStore = path.resolve(
  projectRoot,
  'src',
  'mobile-web',
  'disabled-page-host-store.ts'
)
const nativeClientContext = path.resolve(projectRoot, 'src', 'transport', 'client-context.tsx')
const nativeHostStore = path.resolve(projectRoot, 'src', 'transport', 'host-store.ts')

const config = getDefaultConfig(projectRoot)

// Why: mobile source-control prompts use the same pure builders as desktop.
// Metro only watches mobile/ by default, so make repo-root shared modules visible.
config.watchFolders = Array.from(
  new Set([...(config.watchFolders ?? []), sharedRoot, mobileWebRoot])
)
config.resolver.nodeModulesPaths = Array.from(
  new Set([...(config.resolver.nodeModulesPaths ?? []), path.resolve(projectRoot, 'node_modules')])
)
if (process.env.ORCA_EXPO_ROUTER_ROOT === 'host-web-app') {
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (platform !== 'web') {
      return context.resolveRequest(context, moduleName, platform)
    }
    if (moduleName === '@react-native-async-storage/async-storage') {
      return { filePath: disabledPageStorage, type: 'sourceFile' }
    }
    const resolution = context.resolveRequest(context, moduleName, platform)
    const aliases = new Map([
      [nativeClientContext, disabledPageClientContext],
      [nativeHostStore, disabledPageHostStore]
    ])
    const alias = resolution.filePath ? aliases.get(path.resolve(resolution.filePath)) : undefined
    return alias ? { filePath: alias, type: 'sourceFile' } : resolution
  }
}

module.exports = config
