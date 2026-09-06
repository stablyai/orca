const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const sharedRoot = path.resolve(projectRoot, '..', 'src', 'shared')

const config = getDefaultConfig(projectRoot)

// Why: mobile source-control prompts use the same pure builders as desktop.
// Metro only watches mobile/ by default, so make repo-root shared modules visible.
config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), sharedRoot]))

// Native source builds generate large trees that are never Metro inputs.
const nativeBuildArtifacts =
  /[/\\]react-native[/\\](?:ReactAndroid[/\\](?:hermes-engine[/\\])?(?:build|\.cxx)|sdks[/\\]hermes)(?:[/\\]|$)/
const existingBlockList = config.resolver.blockList ?? []
config.resolver.blockList = [
  ...(Array.isArray(existingBlockList) ? existingBlockList : [existingBlockList]),
  nativeBuildArtifacts
]

module.exports = config
