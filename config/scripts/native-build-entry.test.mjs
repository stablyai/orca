import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  isNativeBuildEntryName,
  isSharedPackageDir,
  isSourceBuildDir,
  loadedNativeBuildDir,
  nativeBuildEntryName,
  nodePtyNativeModuleName
} = require('./native-build-entry.cjs')
const { adoptPackagedNativeBuildEntries } = require('../packaged-native-build-entries.cjs')

const PATCHES = path.join(import.meta.dirname, '..', 'patches')
const roots = []

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true })
  }
})

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-native-entry-'))
  roots.push(root)
  return root
}

function addedPatchLine(patchFile, pattern) {
  const line = readFileSync(path.join(PATCHES, patchFile), 'utf8')
    .split('\n')
    .find((candidate) => candidate.startsWith('+') && pattern.test(candidate))
  expect(line, `${patchFile} has no added line matching ${pattern}`).toBeDefined()
  return line
}

describe('nativeBuildEntryName', () => {
  it('keys an N-API addon by platform and arch only, so Node and Electron share it', () => {
    const node = nativeBuildEntryName('node-pty', {
      platform: 'darwin',
      arch: 'arm64',
      modules: '137'
    })
    const electron = nativeBuildEntryName('node-pty', {
      platform: 'darwin',
      arch: 'arm64',
      modules: '148'
    })
    expect(node).toBe('orca-napi-darwin-arm64')
    expect(electron).toBe(node)
    expect(
      nativeBuildEntryName('@vscode/windows-process-tree', { platform: 'win32', arch: 'x64' })
    ).toBe('orca-napi-win32-x64')
  })

  it('separates arches and refuses a package with no descriptor', () => {
    expect(nativeBuildEntryName('node-pty', { platform: 'darwin', arch: 'x64' })).not.toBe(
      nativeBuildEntryName('node-pty', { platform: 'darwin', arch: 'arm64' })
    )
    expect(() => nativeBuildEntryName('cpu-features')).toThrow(/no shared native build/)
  })

  // Patched loaders cannot require this module; hold duplicated name calculation to same contract.
  it('matches the dir the patched node-pty loader tries first', () => {
    const line = addedPatchLine('node-pty@1.1.0.patch', /var dirs = \[/)
    const firstDir = /\[([^,]+),/.exec(line)[1]
    const evaluate = new Function('process', `return ${firstDir}`)
    for (const [platform, arch] of [
      ['darwin', 'arm64'],
      ['linux', 'x64'],
      ['win32', 'arm64']
    ]) {
      expect(evaluate({ platform, arch })).toBe(
        `build/${nativeBuildEntryName('node-pty', { platform, arch })}`
      )
    }
  })

  it('matches the dir the patched windows-process-tree loader prefers', () => {
    const line = addedPatchLine('@vscode__windows-process-tree@0.8.0.patch', /orcaNativeBuild = /)
    const template = /= `(.*)`;/.exec(line)[1]
    for (const arch of ['x64', 'arm64']) {
      const resolved = template.replace('${__dirname}', '/pkg/lib').replace('${process.arch}', arch)
      expect(path.posix.dirname(path.posix.normalize(resolved))).toBe(
        `/pkg/build/${nativeBuildEntryName('@vscode/windows-process-tree', { platform: 'win32', arch })}`
      )
    }
  })
})

describe('isSharedPackageDir', () => {
  it('treats a package linked in from outside the project as shared', () => {
    const root = makeRoot()
    const store = path.join(root, 'store', 'node-pty')
    const project = path.join(root, 'project')
    mkdirSync(store, { recursive: true })
    mkdirSync(path.join(project, 'node_modules'), { recursive: true })
    symlinkSync(store, path.join(project, 'node_modules', 'node-pty'), 'junction')
    expect(isSharedPackageDir(path.join(project, 'node_modules', 'node-pty'), project)).toBe(true)
  })

  it('treats the per-project virtual store as private', () => {
    const root = makeRoot()
    const real = path.join(
      root,
      'node_modules',
      '.pnpm',
      'node-pty@1.1.0',
      'node_modules',
      'node-pty'
    )
    mkdirSync(real, { recursive: true })
    symlinkSync(real, path.join(root, 'node_modules', 'node-pty'), 'junction')
    expect(isSharedPackageDir(path.join(root, 'node_modules', 'node-pty'), root)).toBe(false)
  })

  it('treats a missing package as private', () => {
    const root = makeRoot()
    expect(isSharedPackageDir(path.join(root, 'nope'), root)).toBe(false)
  })
})

describe('loadedNativeBuildDir', () => {
  it('prefers a published entry and otherwise reads build/Release', () => {
    const root = makeRoot()
    const target = { platform: 'linux', arch: 'x64' }
    expect(loadedNativeBuildDir(root, 'node-pty', target)).toBe(path.join(root, 'build', 'Release'))
    mkdirSync(path.join(root, 'build', 'orca-napi-linux-x64'), { recursive: true })
    expect(loadedNativeBuildDir(root, 'node-pty', target)).toBe(
      path.join(root, 'build', 'orca-napi-linux-x64')
    )
  })
})

describe('isSourceBuildDir', () => {
  it('accepts build/Release and a published entry, never a prebuild', () => {
    expect(isSourceBuildDir('../build/Release/')).toBe(true)
    expect(isSourceBuildDir('..\\build\\orca-napi-win32-x64\\')).toBe(true)
    expect(isSourceBuildDir('../prebuilds/darwin-arm64/')).toBe(false)
    expect(isSourceBuildDir(undefined)).toBe(false)
  })
})

describe('nodePtyNativeModuleName', () => {
  it('follows node-pty: ConPTY from Windows build 18309', () => {
    expect(nodePtyNativeModuleName('darwin', '25.3.0')).toBe('pty')
    expect(nodePtyNativeModuleName('win32', '10.0.26100')).toBe('conpty')
    expect(nodePtyNativeModuleName('win32', '10.0.17763')).toBe('pty')
  })
})

describe('adoptPackagedNativeBuildEntries', () => {
  function packagedNodePty(root, dirs) {
    const buildDir = path.join(root, 'node_modules', 'node-pty', 'build')
    for (const [dir, payload] of Object.entries(dirs)) {
      mkdirSync(path.join(buildDir, dir), { recursive: true })
      writeFileSync(path.join(buildDir, dir, 'pty.node'), payload)
    }
    return buildDir
  }

  it('ships the target entry as build/Release and drops every other entry', () => {
    const root = makeRoot()
    const buildDir = packagedNodePty(root, {
      Release: 'pnpm-install-build',
      'orca-napi-darwin-arm64': 'entry-arm64',
      'orca-napi-darwin-x64': 'entry-x64',
      'orca-napi-darwin-arm64.staging-1-x': 'partial'
    })
    adoptPackagedNativeBuildEntries(root, 'darwin', 'x64')
    expect(readFileSync(path.join(buildDir, 'Release', 'pty.node'), 'utf8')).toBe('entry-x64')
    expect(
      ['Release', 'orca-napi-darwin-arm64'].map((name) => isNativeBuildEntryName(name))
    ).toEqual([false, true])
    expect(require('node:fs').readdirSync(buildDir)).toEqual(['Release'])
  })

  it('leaves a CI layout with no entries untouched', () => {
    const root = makeRoot()
    const buildDir = packagedNodePty(root, { Release: 'ci-build' })
    adoptPackagedNativeBuildEntries(root, 'linux', 'x64')
    expect(readFileSync(path.join(buildDir, 'Release', 'pty.node'), 'utf8')).toBe('ci-build')
  })
})
