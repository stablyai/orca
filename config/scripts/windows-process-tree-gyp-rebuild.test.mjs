import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  inspectWindowsProcessTreeAddon,
  nodeGypRebuildInvocation,
  stageWindowsProcessTreeNodeAddonApiHeaders,
  WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS,
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

  it('copies node-addon-api headers into the patched include dir', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'orca-windows-process-tree-headers-'))
    try {
      const nodeAddonApiDir = join(packageDir, 'node_modules', 'node-addon-api')
      mkdirSync(nodeAddonApiDir, { recursive: true })
      writeFileSync(join(packageDir, 'package.json'), '{"dependencies":{"node-addon-api":"*"}}\n')
      writeFileSync(join(nodeAddonApiDir, 'package.json'), '{"name":"node-addon-api"}\n')
      for (const header of WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS) {
        writeFileSync(join(nodeAddonApiDir, header), `// ${header}\n`)
      }

      const stagedDir = stageWindowsProcessTreeNodeAddonApiHeaders(packageDir)
      expect(stagedDir).toBe(join(packageDir, 'deps', 'node-addon-api'))
      for (const header of WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS) {
        expect(readFileSync(join(stagedDir, header), 'utf8')).toBe(`// ${header}\n`)
      }
    } finally {
      rmSync(packageDir, { recursive: true, force: true })
    }
  })
})

describe('inspecting a compiled windows-process-tree addon', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-windows-process-tree-addon-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports a binary that still imports ReadProcessMemory as unpatched', () => {
    const addonPath = join(dir, 'windows_process_tree.node')
    writeFileSync(addonPath, Buffer.from('MZ\0\0KERNEL32.dll\0ReadProcessMemory\0', 'binary'))
    expect(inspectWindowsProcessTreeAddon(addonPath)).toBe('unpatched')
  })

  it('reports a binary without the import as clean', () => {
    const addonPath = join(dir, 'windows_process_tree.node')
    writeFileSync(addonPath, Buffer.from('MZ\0\0ntdll.dll\0NtQueryInformationProcess\0', 'binary'))
    expect(inspectWindowsProcessTreeAddon(addonPath)).toBe('clean')
  })

  // The whole point of the tri-state: absence is not evidence of safety, and a
  // boolean made "there is no binary" indistinguishable from "checked, clean".
  it('reports an absent binary as missing rather than clean', () => {
    expect(inspectWindowsProcessTreeAddon(join(dir, 'windows_process_tree.node'))).toBe('missing')
  })

  it('inspects whatever path it is handed, including a relay-staged addon', () => {
    // The relay loads `./windows-process-tree.node` beside its bundle, which is
    // nowhere near a node_modules package directory.
    const staged = join(dir, 'windows-process-tree.node')
    writeFileSync(staged, Buffer.from('MZ\0\0ReadProcessMemory\0', 'binary'))
    expect(inspectWindowsProcessTreeAddon(staged)).toBe('unpatched')
  })
})
