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
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')

export const WINDOWS_PROCESS_TREE_PACKAGE_DIR = join(
  ROOT,
  'node_modules',
  '@vscode',
  'windows-process-tree'
)

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
