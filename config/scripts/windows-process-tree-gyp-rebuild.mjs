/**
 * Where and how `@vscode/windows-process-tree` is rebuilt from source.
 *
 * node-gyp must run from the package's physical directory, never the
 * `node_modules` symlink/junction pnpm installs there: gyp expands the
 * node-addon-api dependency by probing node (whose cwd resolves to the
 * physical path), gets back a store-relative `../../../../node-addon-api@…`
 * hop, then resolves that hop against the rebuild cwd. From the link path the
 * hop escapes the store and configure fails with "node_addon_api.gyp not
 * found" (run 32999886072).
 */
import { copyFileSync, mkdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')

export const WINDOWS_PROCESS_TREE_PACKAGE_DIR = join(
  ROOT,
  'node_modules',
  '@vscode',
  'windows-process-tree'
)

export const WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS = [
  'napi.h',
  'napi-inl.h',
  'napi-inl.deprecated.h'
]

export function nodeGypRebuildInvocation(arch, packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR) {
  return {
    args: [
      join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
      'rebuild',
      `--arch=${arch}`
    ],
    cwd: realpathSync(packageDir)
  }
}

// Patched binding.gyp includes deps/node-addon-api; the tarball does not ship those headers.
export function stageWindowsProcessTreeNodeAddonApiHeaders(
  packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR
) {
  const nodeAddonApiDir = dirname(
    createRequire(join(packageDir, 'package.json')).resolve('node-addon-api/package.json')
  )
  const stagedHeaderDir = join(packageDir, 'deps', 'node-addon-api')
  mkdirSync(stagedHeaderDir, { recursive: true })
  for (const header of WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS) {
    copyFileSync(join(nodeAddonApiDir, header), join(stagedHeaderDir, header))
  }
  return stagedHeaderDir
}
