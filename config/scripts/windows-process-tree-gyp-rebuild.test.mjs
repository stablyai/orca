import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'
import {
  assertWindowsProcessTreeCreationTimePatch,
  assertWindowsProcessTreeRuntimeCreationTime,
  inspectWindowsProcessTreeAddon,
  nodeGypRebuildInvocation,
  nodeGypRebuildTimeoutMs,
  stageWindowsProcessTreeNodeAddonApiHeaders,
  WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS,
  WINDOWS_PROCESS_TREE_PACKAGE_DIR
} from './windows-process-tree-gyp-rebuild.mjs'
import { writeFakeWindowsProcessTreeWithNodeAddonApi } from './rebuild-native-deps-test-fixtures.mjs'

describe('windows-process-tree node-gyp rebuild', () => {
  // The installed Windows dependency is exercised by the Windows CI lane.
  it.runIf(process.platform === 'win32')(
    "resolves node-addon-api's gyp target from the rebuild cwd",
    () => {
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
    }
  )

  it('forwards the requested arch to node-gyp', () => {
    const { args } = nodeGypRebuildInvocation('arm64', import.meta.dirname)
    expect(args).toContain('rebuild')
    expect(args).toContain('--arch=arm64')
  })

  it('preserves an external node-gyp entry and the physical addon cwd', () => {
    const entry = join(tmpdir(), 'external-node-gyp', 'bin', 'node-gyp.js')
    expect(nodeGypRebuildInvocation('arm64', import.meta.dirname, entry)).toEqual({
      args: [entry, 'rebuild', '--arch=arm64'],
      cwd: realpathSync(import.meta.dirname)
    })
  })

  it('allows cold setup and compilation only for node-pty on a Windows ARM CI host', () => {
    expect(
      nodeGypRebuildTimeoutMs('node-pty', { platform: 'win32', arch: 'arm64', ci: 'true' })
    ).toBe(600_000)
  })

  it.each([
    { moduleName: 'node-pty', platform: 'win32', arch: 'x64', ci: 'true' },
    { moduleName: 'node-pty', platform: 'linux', arch: 'arm64', ci: 'true' },
    { moduleName: 'node-pty', platform: 'darwin', arch: 'arm64', ci: 'true' },
    { moduleName: 'node-pty', platform: 'win32', arch: 'arm64', ci: '' },
    { moduleName: 'node-pty', platform: 'win32', arch: 'arm64', ci: 'false' },
    { moduleName: 'node-pty', platform: 'win32', arch: 'arm64', ci: '1' },
    { moduleName: '@orca/windows-registry', platform: 'win32', arch: 'arm64', ci: 'true' },
    { moduleName: '@vscode/windows-process-tree', platform: 'win32', arch: 'arm64', ci: 'true' }
  ])('keeps the five-minute bound for $moduleName on $platform/$arch with CI=$ci', (host) => {
    expect(nodeGypRebuildTimeoutMs(host.moduleName, host)).toBe(300_000)
  })

  it('uses the execution host rather than an ARM cross-compilation target', () => {
    const { args } = nodeGypRebuildInvocation('arm64', import.meta.dirname)
    expect(args).toContain('--arch=arm64')
    expect(
      nodeGypRebuildTimeoutMs('node-pty', { platform: 'win32', arch: 'x64', ci: 'true' })
    ).toBe(300_000)
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
      removeTreeSync(packageDir)
    }
  })
})

describe('inspecting a compiled windows-process-tree addon', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-windows-process-tree-addon-'))
  })
  afterEach(() => {
    removeTreeSync(dir)
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

describe('windows-process-tree CreationTime patch assertion', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-windows-process-tree-creation-time-'))
  })
  afterEach(() => {
    removeTreeSync(dir)
  })

  it('accepts a package whose source and JS surfaces expose process creation time', () => {
    writeFakeWindowsProcessTreeWithNodeAddonApi(dir)

    expect(() =>
      assertWindowsProcessTreeCreationTimePatch(
        join(dir, 'node_modules', '@vscode', 'windows-process-tree')
      )
    ).not.toThrow()
  })

  it('rejects a package missing the process creation-time patch', () => {
    writeFakeWindowsProcessTreeWithNodeAddonApi(dir, { creationTimePatchApplied: false })

    expect(() =>
      assertWindowsProcessTreeCreationTimePatch(
        join(dir, 'node_modules', '@vscode', 'windows-process-tree')
      )
    ).toThrow('process creation-time patch')
  })

  it('requires the runtime ProcessDataFlag.CreationTime enum', () => {
    expect(() =>
      assertWindowsProcessTreeRuntimeCreationTime({
        ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 }
      })
    ).not.toThrow()
    expect(() =>
      assertWindowsProcessTreeRuntimeCreationTime({
        ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 }
      })
    ).toThrow('ProcessDataFlag.CreationTime')
  })
})
