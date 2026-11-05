import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(new URL('../../macos-terminal-host-bundle.test.mjs', import.meta.url))
const {
  assembleMacTerminalHost,
  buildMacTerminalHostInfo,
  daemonBareRequires,
  findMacTerminalHostInfoProblems,
  findUnresolvedDaemonRequires,
  macTerminalHostPaths,
  parseBuildVersionMinos
} = require('./macos/terminal-host-bundle/macos-terminal-host-bundle.cjs')
const electronBuilderConfig = require('../electron-builder.config.cjs')

const usageDescriptions = electronBuilderConfig.mac.extendInfo
const appInfo = { CFBundleIdentifier: 'com.stablyai.orca', CFBundleShortVersionString: '1.4.300' }
const expectations = { appId: 'com.stablyai.orca', usageDescriptions, minimumOs: '13.5' }

describe('terminal host binary checks', () => {
  it('reads minos from the LC_BUILD_VERSION load command only', () => {
    const otool = [
      'Load command 8',
      '      cmd LC_SEGMENT_64',
      '    minos 99.0',
      'Load command 9',
      '      cmd LC_BUILD_VERSION',
      '  cmdsize 32',
      ' platform 1',
      '    minos 13.5',
      '      sdk 14.0',
      'Load command 10',
      '      cmd LC_SOURCE_VERSION'
    ].join('\n')
    expect(parseBuildVersionMinos(otool)).toBe('13.5')
    expect(parseBuildVersionMinos('Load command 1\n      cmd LC_SEGMENT_64\n')).toBeNull()
  })
})

describe.skipIf(process.platform !== 'darwin')('terminal host assembly', () => {
  let root
  let appPath

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-terminal-host-'))
    appPath = join(root, 'Orca.app')
    const resources = join(appPath, 'Contents', 'Resources')
    const out = join(resources, 'app.asar.unpacked', 'out')
    mkdirSync(join(out, 'main', 'chunks'), { recursive: true })
    writeFileSync(join(out, 'main', 'daemon-entry.js'), 'entry')
    writeFileSync(join(out, 'main', 'chunks', 'protocol.js'), 'chunk')
    writeFileSync(join(out, 'package.json'), '{"type":"commonjs"}')
    const nodePty = join(resources, 'node_modules', 'node-pty')
    mkdirSync(join(nodePty, 'lib'), { recursive: true })
    mkdirSync(join(nodePty, 'build', 'Release'), { recursive: true })
    mkdirSync(join(nodePty, 'src'), { recursive: true })
    writeFileSync(join(nodePty, 'package.json'), '{}')
    writeFileSync(join(nodePty, 'lib', 'index.js'), 'lib')
    writeFileSync(join(nodePty, 'build', 'Release', 'pty.node'), 'addon')
    // Some packaged node-pty copies ship spawn-helper without its execute bit.
    writeFileSync(join(nodePty, 'build', 'Release', 'spawn-helper'), 'helper', { mode: 0o644 })
    writeFileSync(join(nodePty, 'src', 'unix.cc'), 'source')
    writeFileSync(join(root, 'node'), 'pinned-node', { mode: 0o644 })
    writeFileSync(join(root, 'icon.icns'), 'icon')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('lays out the pinned Node, daemon JS and runtime node-pty files only', () => {
    const info = buildMacTerminalHostInfo({ appInfo, usageDescriptions, minimumOs: '13.5' })
    const paths = assembleMacTerminalHost({
      appPath,
      nodeExecutable: join(root, 'node'),
      iconPath: join(root, 'icon.icns'),
      info
    })
    expect(paths).toEqual(macTerminalHostPaths(appPath))
    expect(paths.bundle).toBe(join(appPath, 'Contents', 'Helpers', 'Orca Terminal Host.app'))
    expect(readFileSync(paths.executable, 'utf8')).toBe('pinned-node')
    expect(statSync(paths.executable).mode & 0o777).toBe(0o755)
    expect(statSync(paths.spawnHelper).mode & 0o777).toBe(0o755)
    expect(readFileSync(paths.entry, 'utf8')).toBe('entry')
    expect(existsSync(join(paths.daemon, 'out', 'main', 'chunks', 'protocol.js'))).toBe(true)
    expect(readFileSync(paths.outPackageJson, 'utf8')).toBe('{"type":"commonjs"}')
    expect(existsSync(join(paths.nodePty, 'lib', 'index.js'))).toBe(true)
    expect(existsSync(join(paths.nodePty, 'src'))).toBe(false)
    expect(readFileSync(paths.icon, 'utf8')).toBe('icon')
    const plist = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', paths.infoPlist], {
      encoding: 'utf8'
    })
    expect(findMacTerminalHostInfoProblems(JSON.parse(plist.stdout), expectations)).toEqual([])
  })

  it('copies every package the daemon requires, with its dependencies', () => {
    const resources = join(appPath, 'Contents', 'Resources')
    const main = join(resources, 'app.asar.unpacked', 'out', 'main')
    writeFileSync(join(main, 'daemon-entry.js'), "require('./chunks/kill.js')")
    writeFileSync(
      join(main, 'chunks', 'kill.js'),
      "require(`node:fs`);require('os');require(`@orca/process-host/gate`)"
    )
    // Main-process code shipped alongside is not part of the daemon.
    writeFileSync(join(main, 'index.js'), "require('unused');require(`electron`)")
    const modules = join(resources, 'node_modules')
    mkdirSync(join(modules, '@orca', 'process-host', 'dist'), { recursive: true })
    writeFileSync(
      join(modules, '@orca', 'process-host', 'package.json'),
      '{"dependencies":{"retry":"1"}}'
    )
    mkdirSync(join(modules, 'retry'), { recursive: true })
    writeFileSync(join(modules, 'retry', 'package.json'), '{}')
    mkdirSync(join(modules, 'unused'), { recursive: true })
    writeFileSync(join(modules, 'unused', 'package.json'), '{}')
    const paths = assembleMacTerminalHost({
      appPath,
      nodeExecutable: join(root, 'node'),
      iconPath: join(root, 'icon.icns'),
      info: {}
    })
    const helperModules = join(paths.daemon, 'node_modules')
    expect(daemonBareRequires(join(paths.daemon, 'out', 'main'))).toEqual([
      '@orca/process-host/gate'
    ])
    expect(existsSync(join(helperModules, '@orca', 'process-host', 'package.json'))).toBe(true)
    expect(existsSync(join(helperModules, 'retry', 'package.json'))).toBe(true)
    expect(existsSync(join(helperModules, 'unused'))).toBe(false)
    expect(existsSync(join(helperModules, 'electron'))).toBe(false)
  })

  it('fails when the app lacks a package the daemon requires', () => {
    const main = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'out', 'main')
    writeFileSync(join(main, 'daemon-entry.js'), "require('./gone')")
    writeFileSync(join(main, 'gone.js'), "require('yaml')")
    expect(() =>
      assembleMacTerminalHost({
        appPath,
        nodeExecutable: join(root, 'node'),
        iconPath: join(root, 'icon.icns'),
        info: {}
      })
    ).toThrow(/requires yaml, missing/)
  })

  it('flags a require that only resolves outside the helper', () => {
    const paths = assembleMacTerminalHost({
      appPath,
      nodeExecutable: join(root, 'node'),
      iconPath: join(root, 'icon.icns'),
      info: {}
    })
    writeFileSync(paths.entry, "require('jsonc-parser')")
    // The build tree's node_modules above dist/ is what hid this from the boot check.
    mkdirSync(join(root, 'node_modules', 'jsonc-parser'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'jsonc-parser', 'package.json'), '{"main":"i.js"}')
    writeFileSync(join(root, 'node_modules', 'jsonc-parser', 'i.js'), '')
    expect(findUnresolvedDaemonRequires(paths)).toEqual([
      expect.stringMatching(
        /^jsonc-parser resolves to .*node_modules\/jsonc-parser\/i\.js, not inside/
      )
    ])
    // Node caches resolutions, so the in-bundle case uses a package not resolved above.
    writeFileSync(paths.entry, "require('yaml')")
    mkdirSync(join(paths.daemon, 'node_modules', 'yaml'), { recursive: true })
    writeFileSync(join(paths.daemon, 'node_modules', 'yaml', 'package.json'), '{"main":"i.js"}')
    writeFileSync(join(paths.daemon, 'node_modules', 'yaml', 'i.js'), '')
    expect(findUnresolvedDaemonRequires(paths)).toEqual([])
  })

  it('follows directory and JSON loads and keeps nested dependencies with their parent', () => {
    const resources = join(appPath, 'Contents', 'Resources')
    const main = join(resources, 'app.asar.unpacked', 'out', 'main')
    mkdirSync(join(main, 'lib'), { recursive: true })
    writeFileSync(join(main, 'daemon-entry.js'), "require('./lib');require('./data.json')")
    writeFileSync(join(main, 'lib', 'index.js'), "require('outer')")
    writeFileSync(join(main, 'data.json'), '{}')
    const outer = join(resources, 'node_modules', 'outer')
    mkdirSync(join(outer, 'node_modules', 'inner'), { recursive: true })
    writeFileSync(join(outer, 'package.json'), '{"dependencies":{"inner":"1"}}')
    writeFileSync(join(outer, 'node_modules', 'inner', 'package.json'), '{}')
    const paths = assembleMacTerminalHost({
      appPath,
      nodeExecutable: join(root, 'node'),
      iconPath: join(root, 'icon.icns'),
      info: {}
    })
    expect(daemonBareRequires(join(paths.daemon, 'out', 'main'))).toEqual(['outer'])
    expect(existsSync(join(paths.daemon, 'node_modules', 'outer', 'node_modules', 'inner'))).toBe(
      true
    )
  })

  it("copies a nested package's dependency from wherever Node resolves it", () => {
    const resources = join(appPath, 'Contents', 'Resources')
    writeFileSync(
      join(resources, 'app.asar.unpacked', 'out', 'main', 'daemon-entry.js'),
      "require('b')"
    )
    const modules = join(resources, 'node_modules')
    const packages = {
      b: { dependencies: { c: '2' } },
      // The top-level c is another version; b gets its own nested copy.
      c: {},
      [join('b', 'node_modules', 'c')]: { dependencies: { e: '1' } },
      e: {}
    }
    for (const [dir, manifest] of Object.entries(packages)) {
      mkdirSync(join(modules, dir), { recursive: true })
      writeFileSync(join(modules, dir, 'package.json'), JSON.stringify(manifest))
    }
    const paths = assembleMacTerminalHost({
      appPath,
      nodeExecutable: join(root, 'node'),
      iconPath: join(root, 'icon.icns'),
      info: {}
    })
    const helperModules = join(paths.daemon, 'node_modules')
    expect(existsSync(join(helperModules, 'b', 'node_modules', 'c', 'package.json'))).toBe(true)
    expect(existsSync(join(helperModules, 'e', 'package.json'))).toBe(true)
    expect(existsSync(join(helperModules, 'c'))).toBe(false)
  })

  it.each([
    ['a variable', 'const name = pick();require(name)'],
    ['a concatenated literal', "require('yaml' + suffix)"],
    ['a template with a substitution', 'require(`./chunk-${id}.js`)']
  ])('fails when the daemon loads a module through %s', (_label, source) => {
    const main = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'out', 'main')
    writeFileSync(join(main, 'daemon-entry.js'), source)
    expect(() =>
      assembleMacTerminalHost({
        appPath,
        nodeExecutable: join(root, 'node'),
        iconPath: join(root, 'icon.icns'),
        info: {}
      })
    ).toThrow(/loads a module by a computed name/)
  })

  it('fails before writing anything when the daemon entry is missing', () => {
    rmSync(join(appPath, 'Contents', 'Resources', 'app.asar.unpacked'), { recursive: true })
    expect(() =>
      assembleMacTerminalHost({
        appPath,
        nodeExecutable: join(root, 'node'),
        iconPath: join(root, 'icon.icns'),
        info: {}
      })
    ).toThrow(/missing .*daemon-entry\.js/)
    expect(existsSync(join(appPath, 'Contents', 'Helpers'))).toBe(false)
  })
})
