const fs = require('node:fs')
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const sharedRoot = path.resolve(projectRoot, '..', 'src', 'shared')
const lowlightAllStub = path.join(
  projectRoot,
  'src',
  'files',
  'session-documents',
  'lowlight-unused-all-stub.js'
)
const zodLocalesStub = path.join(projectRoot, 'scripts', 'zod-locales-en-only-stub.cjs')
const emptyModuleStub = path.join(projectRoot, 'scripts', 'metro-empty-module-stub.cjs')
const {
  ensureCompressedLocaleCatalogsSync
} = require('./scripts/sync-compressed-locale-catalogs.cjs')

ensureCompressedLocaleCatalogsSync()

const UNUSED_REANIMATED_ANIMATION_MODULES = new Set([
  './Bounce',
  './Flip',
  './Lightspeed',
  './Pinwheel',
  './Roll',
  './Rotate',
  './Slide',
  './Stretch',
  './Zoom',
  './CurvedTransition',
  './EntryExitTransition',
  './FadingTransition',
  './JumpingTransition',
  './LinearTransition',
  './SequencedTransition'
])

const config = getDefaultConfig(projectRoot)

// Watch repo root: mobile source-control uses desktop’s pure prompt builders, outside Metro’s default mobile-only scope.
config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), sharedRoot]))

// RN 0.88 registers assets through the bare `react-native/asset-registry` import, which Metro resolves from
// the asset's own folder. Shared assets live outside mobile/, so fall back to mobile's react-native.
// React Compiler also compiles those shared files, whose `react/compiler-runtime` import must reach mobile's React.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  react: path.join(projectRoot, 'node_modules', 'react'),
  'react-native': path.join(projectRoot, 'node_modules', 'react-native')
}

const defaultResolveRequest = config.resolver.resolveRequest
const lucideIconsPrefix = 'lucide-react-native/dist/esm/icons/'
const lucideIconsDir = fs.realpathSync(
  path.join(projectRoot, 'node_modules', 'lucide-react-native', 'dist', 'esm', 'icons')
)

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'expo-router/_ctx' && (platform === 'android' || platform === 'ios')) {
    return {
      type: 'sourceFile',
      filePath: path.join(projectRoot, 'scripts', `expo-router-ctx.${platform}.js`)
    }
  }
  if (moduleName.startsWith(lucideIconsPrefix)) {
    return {
      type: 'sourceFile',
      filePath: path.join(lucideIconsDir, moduleName.slice(lucideIconsPrefix.length))
    }
  }
  if (
    moduleName === './lib/all.js' &&
    context.originModulePath.includes(`${path.sep}lowlight${path.sep}`)
  ) {
    return { type: 'sourceFile', filePath: lowlightAllStub }
  }
  if (
    context.originModulePath.includes(`${path.sep}zod${path.sep}`) &&
    (moduleName === '../locales/index.cjs' || moduleName === './locales/index.cjs')
  ) {
    return { type: 'sourceFile', filePath: zodLocalesStub }
  }
  if (
    UNUSED_REANIMATED_ANIMATION_MODULES.has(moduleName) &&
    context.originModulePath.includes(`${path.sep}react-native-reanimated${path.sep}`) &&
    context.originModulePath.includes(`${path.sep}layoutReanimation${path.sep}`)
  ) {
    return { type: 'sourceFile', filePath: emptyModuleStub }
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
