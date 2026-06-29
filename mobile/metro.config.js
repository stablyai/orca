// Why: mobile i18n imports the desktop's zh.json from a sibling package.
// Metro must watch the directories that contain those imports, otherwise
// the cross-package import fails at bundle time. We previously watched the
// entire workspace root, which invalidated Metro's transform cache on any
// edit anywhere in the repo — measurable hot-reload latency penalty. This
// config narrows watchFolders to the two specific directories mobile
// actually depends on across the workspace boundary:
//   1. src/renderer/src/i18n/locales/ — the JSON files mobile imports
//   2. src/shared/ — upstream's source-control builders
// Edits to other parts of the repo no longer invalidate Metro cache.
//
// We deliberately do NOT set disableHierarchicalLookup. pnpm's strict
// node_modules layout symlinks expo-router from .pnpm/ into mobile/node_modules
// but keeps peer deps like @expo/metro-runtime inside their own .pnpm
// subtrees; disabling hierarchical lookup broke that resolution. The default
// hierarchical lookup walks up from the importing file's location and
// finds zh.json inside the i18nLocalesRoot watchFolder.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '..')
const sharedRoot = path.resolve(workspaceRoot, 'src', 'shared')
const i18nLocalesRoot = path.resolve(workspaceRoot, 'src', 'renderer', 'src', 'i18n', 'locales')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [sharedRoot, i18nLocalesRoot]

module.exports = config
