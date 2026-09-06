import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { cp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyScriptWithLocalModules } from './script-module-dependencies.mjs'
import { copyWindowsProcessTreeBuildScripts } from './windows-process-tree-build-fixtures.mjs'
import { assertWindowsProcessTreeArchitecture } from './windows-process-tree-gyp-rebuild.mjs'
import {
  writeFakeLoadableNodePty,
  writeFakeWindowsRegistry,
  writeFakeNodePtyConptyPayload,
  writeWindowsProcessTreePatchFile
} from './rebuild-native-deps-test-fixtures.mjs'
import { RELAY_WINDOWS_PROCESS_TREE_FILENAME } from '../../src/shared/relay-artifacts.ts'

const require = createRequire(import.meta.url)
const enabled =
  process.platform === 'win32' && process.env.ORCA_WINDOWS_PROCESS_TREE_BUILD_TEST === '1'
const root = resolve(import.meta.dirname, '../..')

describe.skipIf(!enabled)('Windows native rebuild from long pnpm physical paths', () => {
  it.each(['Node and Electron', 'arm64 relay'])(
    'rebuilds %s through default entrypoints',
    async (target) => {
      const project = mkdtempSync(join(tmpdir(), 'orca-wpt-live-'))
      try {
        const scripts = join(project, 'config/scripts')
        for (const name of [
          'ensure-native-runtime.mjs',
          'rebuild-native-deps.mjs',
          'build-windows-process-tree-relay-addon.mjs'
        ]) {
          copyScriptWithLocalModules(join(import.meta.dirname, name), scripts)
        }
        copyWindowsProcessTreeBuildScripts(project)
        writeWindowsProcessTreePatchFile(project)
        copyFileSync(
          join(import.meta.dirname, 'node-pty-job-ownership.cjs'),
          join(scripts, 'node-pty-job-ownership.cjs')
        )
        copyFileSync(
          join(root, 'src/shared/relay-artifacts.ts'),
          join(project, 'src/shared/relay-artifacts.ts')
        )
        writeFileSync(join(project, 'package.json'), '{"private":true}')
        const original = dirname(require.resolve('@vscode/windows-process-tree/package.json'))
        const physical = join(
          project,
          'node_modules/.pnpm',
          'windows process 中文 '.repeat(3),
          'node_modules/@vscode/windows-process-tree'
        )
        mkdirSync(physical, { recursive: true })
        for (const entry of ['package.json', 'binding.gyp', 'src', 'lib']) {
          await cp(join(original, entry), join(physical, entry), {
            recursive: true
          })
        }
        const packageLink = join(project, 'node_modules/@vscode/windows-process-tree')
        linkDirectory(physical, packageLink)
        expect(realpathSync(packageLink).length).toBeGreaterThan(170)
        const packageRequire = createRequire(join(original, 'package.json'))
        linkDirectory(
          dirname(packageRequire.resolve('node-addon-api/package.json')),
          join(physical, 'node_modules/node-addon-api')
        )
        for (const name of ['node-gyp', '@electron/rebuild', 'electron']) {
          linkDirectory(
            realpathSync(join(root, 'node_modules', name)),
            join(project, 'node_modules', name)
          )
        }
        writeFakeLoadableNodePty(project, { nativeDir: '../build/Release/' })
        writeFakeNodePtyConptyPayload(project, process.arch)
        const conpty = join(project, 'node_modules/node-pty/build/Release/conpty')
        mkdirSync(conpty, { recursive: true })
        for (const name of ['conpty.dll', 'OpenConsole.exe']) {
          writeFileSync(join(conpty, name), '')
        }
        writeFakeWindowsRegistry(project)
        const sourceBefore = readFileSync(join(physical, 'binding.gyp'))
        if (target === 'arm64 relay') {
          run(project, 'build-windows-process-tree-relay-addon.mjs', ['--arch=arm64'])
          assertWindowsProcessTreeArchitecture(
            join(project, '.build/windows-process-tree/arm64', RELAY_WINDOWS_PROCESS_TREE_FILENAME),
            'arm64'
          )
          expect(readFileSync(join(physical, 'binding.gyp'))).toEqual(sourceBefore)
          return
        }
        run(project, 'ensure-native-runtime.mjs', ['--runtime=node'])
        run(project, 'ensure-native-runtime.mjs', ['--check-only'])
        run(project, 'build-windows-process-tree-relay-addon.mjs', ['--arch=x64'])
        for (const arch of ['x64']) {
          assertWindowsProcessTreeArchitecture(
            join(project, '.build/windows-process-tree', arch, RELAY_WINDOWS_PROCESS_TREE_FILENAME),
            arch
          )
        }
        run(project, 'windows-process-tree-capability.cjs', [
          join(project, '.build/windows-process-tree/x64', RELAY_WINDOWS_PROCESS_TREE_FILENAME),
          '--addon'
        ])
        // Force the default Electron path to build, even when Node's N-API binary can load.
        rmSync(join(physical, 'build'), { recursive: true })
        run(project, 'ensure-native-runtime.mjs', ['--runtime=electron'])
        const electron = require('electron')
        run(project, 'windows-process-tree-capability.cjs', [packageLink], electron)
        expect(readFileSync(join(physical, 'binding.gyp'))).toEqual(sourceBefore)
        expect(existsSync(join(physical, 'deps'))).toBe(false)
      } finally {
        rmSync(project, { recursive: true, force: true })
      }
    },
    600_000
  )
})

function linkDirectory(source, destination) {
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(source, destination, 'junction')
}

function run(project, script, args, executable = process.execPath) {
  const result = spawnSync(executable, [join(project, 'config/scripts', script), ...args], {
    cwd: project,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      ORCA_STRICT_NATIVE_REBUILD: '1',
      ORCA_BACKGROUND_LAUNCH: '1',
      ELECTRON_RUN_AS_NODE: '1'
    }
  })
  console.log(result.stdout)
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
}
