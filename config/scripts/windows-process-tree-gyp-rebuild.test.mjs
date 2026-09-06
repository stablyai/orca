import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withWindowsProcessTreeBuild } from './windows-process-tree-gyp-rebuild.mjs'
import {
  writeWindowsProcessTreeBinary,
  writeWindowsProcessTreeSource
} from './windows-process-tree-build-fixtures.mjs'

const roots = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wpt-test-'))
  roots.push(root)
  const packageDir = join(
    root,
    'nested pnpm 中文',
    'x'.repeat(70),
    '@vscode',
    'windows-process-tree'
  )
  writeWindowsProcessTreeSource(packageDir)
  return { root, packageDir, arch: 'x64' }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('windows-process-tree private build directory', () => {
  it.each(['x64', 'arm64'])(
    'builds %s away from the pnpm physical path and preserves source and hardlinks',
    async (arch) => {
      const options = { ...fixture(), arch }
      const original = writeWindowsProcessTreeBinary(options.packageDir, arch)
      const hardlink = join(options.root, 'store-binary')
      linkSync(original, hardlink)
      const binding = readFileSync(join(options.packageDir, 'binding.gyp'))
      let buildPath
      const destination = await withWindowsProcessTreeBuild(options, async (buildDir) => {
        buildPath = buildDir
        expect(buildDir.length).toBeLessThan(options.packageDir.length)
        expect(buildDir.startsWith(options.root)).toBe(false)
        expect(existsSync(join(buildDir, 'build'))).toBe(false)
        expect(existsSync(join(buildDir, 'node_modules'))).toBe(false)
        expect(readFileSync(join(buildDir, 'deps/node-addon-api/napi.h'), 'utf8')).toBe(
          '// napi.h\n'
        )
        const binary = writeWindowsProcessTreeBinary(buildDir, arch)
        const bytes = readFileSync(binary)
        bytes[127] = 12
        writeFileSync(binary, bytes)
      })
      expect(destination).toBe(original)
      expect(readFileSync(destination)[127]).toBe(12)
      expect(readFileSync(hardlink)[127]).toBe(0)
      expect(readFileSync(join(options.packageDir, 'binding.gyp'))).toEqual(binding)
      expect(existsSync(join(options.packageDir, 'deps'))).toBe(false)
      expect(existsSync(buildPath)).toBe(false)
    }
  )
  it('repairs legacy build settings only in the copied source', async () => {
    const options = fixture()
    const binding =
      '{"dependencies": [\n"../../node-addon-api/node_addon_api.gyp:node_addon_api_except",\n], "include_dirs": [], "VCCLCompilerTool": {}}'
    writeFileSync(join(options.packageDir, 'binding.gyp'), binding)
    await withWindowsProcessTreeBuild(options, async (buildDir) => {
      expect(readFileSync(join(buildDir, 'binding.gyp'), 'utf8')).not.toContain(
        'node_addon_api.gyp'
      )
      writeWindowsProcessTreeBinary(buildDir)
    })
    expect(readFileSync(join(options.packageDir, 'binding.gyp'), 'utf8')).toBe(binding)
  })
  it.each(['compiler', 'missing', 'architecture'])(
    'preserves old output after %s failure',
    async (failure) => {
      const options = fixture()
      const binary = writeWindowsProcessTreeBinary(options.packageDir)
      const previous = readFileSync(binary)
      let staged
      await expect(
        withWindowsProcessTreeBuild(options, async (buildDir) => {
          staged = buildDir
          if (failure === 'compiler') {
            throw new Error('compiler failed')
          }
          if (failure === 'architecture') {
            writeWindowsProcessTreeBinary(buildDir, 'arm64')
          }
        })
      ).rejects.toThrow()
      expect(readFileSync(binary)).toEqual(previous)
      expect(existsSync(staged)).toBe(false)
    }
  )
  it('rejects missing identity hunks before running a compiler', async () => {
    const options = fixture()
    writeFileSync(join(options.packageDir, 'src/process.h'), '')
    let invoked = false
    await expect(
      withWindowsProcessTreeBuild(options, async () => {
        invoked = true
      })
    ).rejects.toThrow('required patch hunks')
    expect(invoked).toBe(false)
  })
  it('fails before compiling when even the system temporary root is too deep', async () => {
    const options = fixture()
    const tempRoot = join(options.root, 'long'.repeat(30))
    mkdirSync(tempRoot)
    await expect(
      withWindowsProcessTreeBuild({ ...options, tempRoot }, async () => {
        throw new Error('must not compile')
      })
    ).rejects.toThrow('build budget')
    expect(readdirSync(tempRoot)).toEqual([])
  })
  it('keeps simultaneous builds isolated', async () => {
    const options = [fixture(), fixture()]
    const stages = []
    await Promise.all(
      options.map((value) =>
        withWindowsProcessTreeBuild(value, async (buildDir) => {
          stages.push(buildDir)
          await new Promise((resolve) => setTimeout(resolve, 10))
          writeWindowsProcessTreeBinary(buildDir)
        })
      )
    )
    expect(new Set(stages).size).toBe(2)
  })
  it('reports publication failures and removes its temporary files', async () => {
    const options = fixture()
    const destination = join(options.root, 'occupied')
    mkdirSync(destination)
    writeFileSync(join(destination, 'preserve'), 'existing')
    await expect(
      withWindowsProcessTreeBuild({ ...options, outFile: destination }, async (buildDir) => {
        writeWindowsProcessTreeBinary(buildDir)
      })
    ).rejects.toThrow()
    expect(readFileSync(join(destination, 'preserve'), 'utf8')).toBe('existing')
    expect(readdirSync(options.root).filter((entry) => entry.startsWith('.wpt-'))).toEqual([])
  })
})
