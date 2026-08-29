import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  nodeGypRebuildInvocation,
  WINDOWS_PROCESS_TREE_PACKAGE_DIR
} from './windows-process-tree-gyp-rebuild.mjs'

describe('windows-process-tree node-gyp rebuild', () => {
  it("resolves node-addon-api's gyp target from the rebuild cwd", () => {
    // gyp probes node-addon-api with the package's physical directory as cwd,
    // so the emitted target is store-relative; gyp then resolves that hop
    // against the rebuild cwd. Rebuilding from pnpm's node_modules link sends
    // the hop outside the store and configure fails (run 32999886072).
    const { cwd } = nodeGypRebuildInvocation('x64')
    const targets = execFileSync(process.execPath, ['-p', "require('node-addon-api').targets"], {
      cwd: realpathSync(WINDOWS_PROCESS_TREE_PACKAGE_DIR),
      encoding: 'utf8'
    }).trim()
    expect(existsSync(resolve(cwd, targets))).toBe(true)
  })

  it('forwards the requested arch to node-gyp', () => {
    const { args } = nodeGypRebuildInvocation('arm64')
    expect(args).toContain('rebuild')
    expect(args).toContain('--arch=arm64')
  })
})
