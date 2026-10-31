import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const runner = readFileSync(new URL('./run-electron-vite-dev.mjs', import.meta.url), 'utf8')
const speechHelperModule = readFileSync(
  new URL('./dev-macos-speech-helper.mjs', import.meta.url),
  'utf8'
)
const speechFactory = speechHelperModule
  .slice(speechHelperModule.indexOf('export function'))
  .replace('export function', 'function')
const prepare = runner.slice(
  runner.indexOf('function prepareMacDevElectronApp()'),
  runner.indexOf('\nfunction isSymlink(')
)

function fixture() {
  const files = new Map<string, string>()
  const builds: string[] = []
  const warnings: string[] = []
  const removed: string[] = []
  const copies: string[] = []
  const commands: string[] = []
  const inputs = { swift: 'speech source', build: 'speech build', failBuild: false, inUse: false }
  const env: Record<string, string> = {}
  const context = {
    process: { platform: 'darwin', execPath: '/node', env },
    repoRoot: '/repo',
    path,
    createHash,
    DEV_BUNDLE_ID: 'dev.orca',
    DEV_BUNDLE_MARKER_FILENAME: 'marker.json',
    getDevBundlePlistPatches: () => [],
    getDevHelperPlistPatches: () => [],
    sanitizeMacAppBundleName: (name: string) => name,
    existsSync: (name: string) =>
      (!name.endsWith('marker.json') && !name.endsWith('/orca-speech')) || files.has(name),
    readFileSync: (name: string) => {
      if (name.endsWith('package.json')) {
        return '{"version":"43"}'
      }
      if (name.endsWith('main.swift')) {
        return inputs.swift
      }
      if (name.endsWith('build-speech-macos.mjs')) {
        return inputs.build
      }
      return files.get(name)
    },
    writeFileSync: (name: string, data: string) => files.set(name, data),
    rmSync: (name: string) => {
      removed.push(name)
      files.delete(name)
    },
    mkdirSync() {},
    copyPrivateTree: (_source: string, destination: string) => copies.push(destination),
    restoreElectronFrameworkSymlinks() {},
    setPlistValue() {},
    buildDevSwiftCliHelpers() {},
    pruneStaleDevBundles() {},
    getDevBundleProcessTable: () => [],
    isDevBundleInUse: () => inputs.inUse,
    console: { warn: (message: string) => warnings.push(message) },
    execFileSync: (program: string, args: string[]) => {
      commands.push(program)
      if (args[0]?.endsWith('build-speech-macos.mjs')) {
        builds.push(args[args.indexOf('--output') + 1])
        if (inputs.failBuild) {
          throw new Error('Xcode 26 SDK unavailable')
        }
        const output = builds.at(-1)
        if (output) {
          files.set(output, 'compiled helper')
        }
      }
      return ''
    }
  }
  return {
    inputs,
    builds,
    warnings,
    removed,
    copies,
    commands,
    env,
    launch: () =>
      vm.runInNewContext(`${speechFactory}\n${prepare}\nprepareMacDevElectronApp()`, context)
  }
}

describe('development speech helper', () => {
  it('reuses unchanged bundles but rebuilds when the Swift source or build script changes', () => {
    const dev = fixture()
    dev.launch()
    const originalPath = dev.env.ELECTRON_EXEC_PATH
    dev.launch()
    expect(dev.builds).toHaveLength(1)
    dev.inputs.swift = 'updated speech source'
    dev.launch()
    expect(dev.builds).toHaveLength(2)
    expect(dev.env.ELECTRON_EXEC_PATH).not.toBe(originalPath)
    dev.inputs.build = 'updated build script'
    dev.launch()
    expect(new Set(dev.builds).size).toBe(3)
  })

  it('launches without native voice if its toolchain is missing and removes partial output', () => {
    const dev = fixture()
    dev.inputs.failBuild = true
    expect(() => dev.launch()).not.toThrow()
    expect(dev.env.ELECTRON_EXEC_PATH).toMatch(/\/Contents\/MacOS\/Electron$/)
    expect(dev.removed).toContain(dev.builds[0])
    expect(dev.warnings.some((message) => message.includes('Xcode 26 SDK unavailable'))).toBe(true)
  })

  it('recovers after installing the toolchain without recopying the cached bundle', () => {
    const dev = fixture()
    dev.inputs.failBuild = true
    dev.launch()
    dev.launch()
    expect(dev.builds).toHaveLength(2)
    dev.inputs.failBuild = false
    dev.launch()
    dev.launch()
    expect(dev.builds).toHaveLength(3)
    expect(dev.copies).toHaveLength(1)
    expect(dev.commands.filter((command) => command === '/usr/bin/codesign')).toHaveLength(2)
  })

  it('defers the retry while another instance uses the bundle', () => {
    const dev = fixture()
    dev.inputs.failBuild = true
    dev.launch()
    dev.inputs.failBuild = false
    dev.inputs.inUse = true
    dev.launch()
    expect(dev.builds).toHaveLength(1)
    expect(dev.copies).toHaveLength(1)
    dev.inputs.inUse = false
    dev.launch()
    expect(dev.builds).toHaveLength(2)
  })
})
