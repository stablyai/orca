import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { peImage } from './windows-pe-image-fixture.mjs'

const require = createRequire(import.meta.url)
const {
  packagedConptyCandidates,
  verifyPackagedConptyBreakawayMarker,
  verifyPackagedNodePtyJobOwnership,
  verifyPackagedWindowsNodePty
} = require('./verify-packaged-node-pty-job-ownership.cjs')
const { CYGWIN_BREAKAWAY_MARKER } = require('./node-pty-job-ownership.cjs')

const fixtureDir = mkdtempSync(join(tmpdir(), 'packaged-node-pty-job-'))
const ELECTRON_BUILDER_CONFIG = readFileSync(
  new URL('../electron-builder.config.cjs', import.meta.url),
  'utf8'
)

/** A real enough addon: a machine field the arch check reads, and the marker. */
function conptyImage({ arch = 'x64', cygwinBreakawayDenied = true } = {}) {
  return Buffer.concat([
    peImage({ arch }),
    cygwinBreakawayDenied ? CYGWIN_BREAKAWAY_MARKER : Buffer.alloc(0)
  ])
}

function writeAddon(name, options) {
  const path = join(fixtureDir, name)
  writeFileSync(path, conptyImage(options))
  return path
}

/** A packaged resources tree carrying exactly the conpty.node files named. */
function packagedResources(addons) {
  const resourcesDir = mkdtempSync(join(fixtureDir, 'resources-'))
  const nodePtyDir = join(resourcesDir, 'node_modules', 'node-pty')
  for (const [relativePath, options] of Object.entries(addons)) {
    const addonPath = join(nodePtyDir, ...relativePath.split('/'))
    mkdirSync(dirname(addonPath), { recursive: true })
    writeFileSync(addonPath, conptyImage(options))
  }
  return resourcesDir
}

const CURRENT_ADDON = writeAddon('current.node', { cygwinBreakawayDenied: true })
const PRE_MSYS_ADDON = writeAddon('pre-msys.node', { cygwinBreakawayDenied: false })

const PATCHED = {
  dir: '../build/Release/',
  module: {
    listJobProcessIds: () => [],
    terminateJob: () => true,
    assignCurrentProcessToJob: () => true
  }
}

const packaged = (native, addonPath = CURRENT_ADDON) => ({
  platform: 'win32',
  loadNative: () => ({ native, addonPath })
})

describe('verifyPackagedNodePtyJobOwnership', () => {
  it('accepts the packaged patched ConPTY binding', () => {
    expect(() => verifyPackagedNodePtyJobOwnership('resources', packaged(PATCHED))).not.toThrow()
  })

  it('rejects a packaged upstream prebuild', () => {
    expect(() =>
      verifyPackagedNodePtyJobOwnership(
        'resources',
        packaged({ dir: '../prebuilds/win32-x64/', module: {} })
      )
    ).toThrow(/missing listJobProcessIds, terminateJob, assignCurrentProcessToJob/)
  })

  // A release built against a stale native cache ships the MSYS orphan bug
  // while exporting every job function, so packaging has to read the binary.
  it('rejects a packaged build that predates the Cygwin/MSYS breakaway denial', () => {
    expect(() =>
      verifyPackagedNodePtyJobOwnership('resources', packaged(PATCHED, PRE_MSYS_ADDON))
    ).toThrow(/predates the Cygwin\/MSYS job-breakaway denial/)
  })

  it('requires the patched source-build directory', () => {
    expect(() =>
      verifyPackagedNodePtyJobOwnership(
        'resources',
        packaged({ ...PATCHED, dir: '../prebuilds/win32-x64/' })
      )
    ).toThrow(/expected patched build\/Release/)
  })

  it('does not load Windows natives for other targets', () => {
    const loadNative = vi.fn()
    verifyPackagedNodePtyJobOwnership('resources', { platform: 'linux', loadNative })
    expect(loadNative).not.toHaveBeenCalled()
  })
})

describe('packagedConptyCandidates', () => {
  // Pinned because the gate resolves the addon by walking this list in order:
  // a wrong order blesses a binary the app would never reach.
  it('walks the paths node-pty tries, in node-pty order', () => {
    expect(packagedConptyCandidates('RES', 'arm64').map((candidate) => candidate.path)).toEqual([
      join('RES', 'node_modules', 'node-pty', 'build', 'Release', 'conpty.node'),
      join('RES', 'node_modules', 'node-pty', 'lib', 'build', 'Release', 'conpty.node'),
      join('RES', 'node_modules', 'node-pty', 'build', 'Debug', 'conpty.node'),
      join('RES', 'node_modules', 'node-pty', 'lib', 'build', 'Debug', 'conpty.node'),
      join('RES', 'node_modules', 'node-pty', 'prebuilds', 'win32-arm64', 'conpty.node'),
      join('RES', 'node_modules', 'node-pty', 'lib', 'prebuilds', 'win32-arm64', 'conpty.node')
    ])
  })

  // Only the published prebuild gets the "no rebuild here can fix this" advice.
  it('knows which of them node-pty publishes prebuilt', () => {
    expect(packagedConptyCandidates('RES', 'x64').map((candidate) => candidate.prebuilt)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true
    ])
  })
})

describe('verifyPackagedConptyBreakawayMarker', () => {
  // The release as built today: prunePackagedNodePty already dropped the
  // same-arch prebuild because a patched source build replaced it.
  it('passes a package whose only ConPTY load path carries the denial', () => {
    const resourcesDir = packagedResources({ 'build/Release/conpty.node': {} })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'x64')).not.toThrow()
  })

  // The cross-host package. No host but Windows can build conpty.node, so there
  // is no build/Release for prune to have replaced the prebuild with -- and the
  // published prebuild is exactly the binary that leaks every MSYS pane child.
  it('fails a cross-host package left holding the published prebuild', () => {
    const resourcesDir = packagedResources({
      'prebuilds/win32-x64/conpty.node': { cygwinBreakawayDenied: false }
    })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'x64')).toThrow(
      /predates the Cygwin\/MSYS job-breakaway denial/
    )
  })

  it('tells that package how to fix it, which is not a rebuild it can run', () => {
    const resourcesDir = packagedResources({
      'prebuilds/win32-x64/conpty.node': { cygwinBreakawayDenied: false }
    })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'x64')).toThrow(
      /this package holds no node-pty source build at all[\s\S]*Otherwise package this Windows slice on a host that can/
    )
  })

  // The same state reaches this from a capable host too, when the rebuild left
  // nothing: telling that packager to change hosts would send them nowhere.
  it('does not assume the packaging host is the wrong one', () => {
    const resourcesDir = packagedResources({
      'prebuilds/win32-x64/conpty.node': { cygwinBreakawayDenied: false }
    })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'x64')).toThrow(
      /If this IS a Windows x64 host, the rebuild did not leave one/
    )
  })

  // The cross-arch package that worked: beforeBuild rebuilds node-pty for the
  // TARGET arch, so build/Release is patched and loadable and the prebuild
  // prune left behind is never reached. Failing this would be a false positive
  // whose advice -- change hosts -- is both wrong and impossible.
  it('passes a cross-arch package whose build/Release really is the target arch', () => {
    const resourcesDir = packagedResources({
      'build/Release/conpty.node': { arch: 'arm64' },
      'prebuilds/win32-arm64/conpty.node': { arch: 'arm64', cygwinBreakawayDenied: false }
    })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'arm64')).not.toThrow()
  })

  // The cross-arch package that silently did not: build/Release is the
  // packaging host's own arch, the target cannot load it, and the loader falls
  // through to the unpatched prebuild underneath.
  it('fails a cross-arch package whose build/Release is the packaging host arch', () => {
    const resourcesDir = packagedResources({
      'build/Release/conpty.node': { arch: 'x64' },
      'prebuilds/win32-arm64/conpty.node': { arch: 'arm64', cygwinBreakawayDenied: false }
    })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'arm64')).toThrow(
      /prebuilds[\\/]win32-arm64/
    )
  })

  it('refuses a package whose every conpty.node is the wrong architecture', () => {
    const resourcesDir = packagedResources({ 'build/Release/conpty.node': { arch: 'x64' } })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'arm64')).toThrow(
      /the app can load none of them/
    )
  })

  // Naming the machine it found is what separates a cross-arch build from a
  // truncated download, which are the same "cannot load this" to the loader.
  it('names what it found rather than guessing why', () => {
    const resourcesDir = packagedResources({ 'build/Release/conpty.node': { arch: 'x64' } })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'arm64')).toThrow(
      /machine 0x8664[\s\S]*0xaa64/
    )
  })

  it('calls a candidate that is not a PE image what it is', () => {
    const resourcesDir = packagedResources({})
    const addonPath = join(
      resourcesDir,
      'node_modules',
      'node-pty',
      'build',
      'Release',
      'conpty.node'
    )
    mkdirSync(dirname(addonPath), { recursive: true })
    writeFileSync(addonPath, Buffer.alloc(0x200))
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'x64')).toThrow(/not a PE image/)
  })

  // A truncated or quarantined artifact reaches the gate looking exactly like a
  // cross-arch build, and "re-run with --arch" is not the command that fixes it.
  it('does not blame --arch for a source build that is not a PE image', () => {
    const resourcesDir = packagedResources({
      'prebuilds/win32-x64/conpty.node': { cygwinBreakawayDenied: false }
    })
    const addonPath = join(
      resourcesDir,
      'node_modules',
      'node-pty',
      'build',
      'Release',
      'conpty.node'
    )
    mkdirSync(dirname(addonPath), { recursive: true })
    writeFileSync(addonPath, Buffer.alloc(0x200))
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'x64')).toThrow(
      /is not a PE image at all[\s\S]*truncated, empty or quarantined/
    )
  })

  // The remedy for this one is a rebuild, not a different host, and the
  // difference is a build somebody has to run twice to find out.
  it('blames the wrong-arch source build rather than the host, when there is one', () => {
    const resourcesDir = packagedResources({
      'build/Release/conpty.node': { arch: 'x64' },
      'prebuilds/win32-arm64/conpty.node': { arch: 'arm64', cygwinBreakawayDenied: false }
    })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'arm64')).toThrow(
      /the source build beside it is the wrong architecture[\s\S]*machine 0x8664/
    )
  })

  it('tells that build the command that would fix it', () => {
    const resourcesDir = packagedResources({
      'build/Release/conpty.node': { arch: 'x64' },
      'prebuilds/win32-arm64/conpty.node': { arch: 'arm64', cygwinBreakawayDenied: false }
    })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'arm64')).toThrow(
      /rebuild-native-deps\.mjs --platform=win32 --arch=arm64/
    )
  })

  it('does not tell it to change hosts, which would not help', () => {
    const resourcesDir = packagedResources({
      'build/Release/conpty.node': { arch: 'x64' },
      'prebuilds/win32-arm64/conpty.node': { arch: 'arm64', cygwinBreakawayDenied: false }
    })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'arm64')).toThrow(
      /^(?![\s\S]*Package this Windows slice on such a host)[\s\S]*$/
    )
  })

  it('ignores a prebuild for an arch this slice will never load', () => {
    const resourcesDir = packagedResources({
      'build/Release/conpty.node': {},
      'prebuilds/win32-arm64/conpty.node': { arch: 'arm64', cygwinBreakawayDenied: false }
    })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'x64')).not.toThrow()
  })

  // build/Debug sits between Release and the prebuilds in the load order, and
  // nothing prunes it, so it wins whenever Release cannot be loaded.
  it('resolves past a Release build the target cannot load', () => {
    const resourcesDir = packagedResources({
      'build/Release/conpty.node': { arch: 'x64' },
      'build/Debug/conpty.node': { arch: 'arm64', cygwinBreakawayDenied: false }
    })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'arm64')).toThrow(
      /build[\\/]Debug/
    )
  })

  // A stale source build is the packaging host's own to rebuild, so it gets the
  // advice that actually works rather than the cross-host one.
  it('tells a stale source build to rebuild, not to change hosts', () => {
    const resourcesDir = packagedResources({
      'build/Release/conpty.node': { cygwinBreakawayDenied: false }
    })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'x64')).toThrow(
      /Rebuild node-pty from source/
    )
  })

  // Nothing to load is not "a layout we do not recognise", it is a package with
  // no ConPTY backend, and a gate that cannot see its subject is not a gate.
  it('refuses rather than skip a package with no conpty.node at all', () => {
    const resourcesDir = packagedResources({})
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'x64')).toThrow(
      /no conpty\.node on any path its loader tries/
    )
  })

  it('names every path it looked at when it finds none', () => {
    const resourcesDir = packagedResources({})
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'x64')).toThrow(
      /build[\\/]Release[\s\S]*build[\\/]Debug[\s\S]*prebuilds[\\/]win32-x64/
    )
  })

  // Present but unreadable is the state that used to pass, so it must not warn.
  // The read error itself is the message; the point is that it does not return.
  it('fails rather than pass a candidate it cannot read', () => {
    const resourcesDir = packagedResources({})
    mkdirSync(join(resourcesDir, 'node_modules', 'node-pty', 'build', 'Release', 'conpty.node'), {
      recursive: true
    })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'x64')).toThrow()
  })

  it('accepts the electron-builder Arch enum the afterPack hook passes', () => {
    const resourcesDir = packagedResources({
      'prebuilds/win32-arm64/conpty.node': { arch: 'arm64' }
    })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 3)).not.toThrow()
  })

  it('refuses a target arch no Windows slice ships', () => {
    const resourcesDir = packagedResources({ 'build/Release/conpty.node': {} })
    expect(() => verifyPackagedConptyBreakawayMarker(resourcesDir, 'ia32')).toThrow(
      /Unsupported packaged node-pty Windows architecture/
    )
  })

  it('looks where electron-builder actually lands the addon', () => {
    const exists = vi.fn().mockReturnValue(false)
    expect(() =>
      verifyPackagedConptyBreakawayMarker(join('out', 'win-unpacked', 'resources'), 'x64', {
        exists
      })
    ).toThrow()
    expect(exists).toHaveBeenCalledWith(
      join(
        'out',
        'win-unpacked',
        'resources',
        'node_modules',
        'node-pty',
        'build',
        'Release',
        'conpty.node'
      )
    )
  })
})

describe('verifyPackagedWindowsNodePty', () => {
  const spies = () => ({ verifyMarker: vi.fn(), verifyExports: vi.fn() })

  // The bug this replaced: the marker check sat in the else of the host gate, so
  // the cross-host package it exists for was the one package it never checked.
  it.each([
    ['a cross-platform host', { hostPlatform: 'darwin', canExecuteTargetArch: true }],
    ['a cross-arch slice', { hostPlatform: 'win32', canExecuteTargetArch: false }],
    ['both', { hostPlatform: 'linux', canExecuteTargetArch: false }],
    ['neither', { hostPlatform: 'win32', canExecuteTargetArch: true }]
  ])('checks the marker on %s', (_case, host) => {
    const { verifyMarker, verifyExports } = spies()
    verifyPackagedWindowsNodePty('resources', 'x64', { ...host, verifyMarker, verifyExports })
    expect(verifyMarker).toHaveBeenCalledWith('resources', 'x64')
  })

  it('loads the addon for the export check only where that can work', () => {
    const { verifyMarker, verifyExports } = spies()
    verifyPackagedWindowsNodePty('resources', 'x64', {
      hostPlatform: 'win32',
      canExecuteTargetArch: true,
      verifyMarker,
      verifyExports
    })
    expect(verifyExports).toHaveBeenCalledWith('resources')
  })

  it.each([
    ['a cross-platform host', { hostPlatform: 'darwin', canExecuteTargetArch: true }],
    ['a cross-arch slice', { hostPlatform: 'win32', canExecuteTargetArch: false }]
  ])('skips the export check on %s', (_case, host) => {
    const { verifyMarker, verifyExports } = spies()
    verifyPackagedWindowsNodePty('resources', 'x64', { ...host, verifyMarker, verifyExports })
    expect(verifyExports).not.toHaveBeenCalled()
  })

  // Swallowing the marker verdict would leave a gate that runs and decides
  // nothing, which is the failure mode this whole change is about.
  it('lets the marker verdict fail the package', () => {
    const verifyMarker = vi.fn(() => {
      throw new Error('predates the Cygwin/MSYS job-breakaway denial')
    })
    expect(() =>
      verifyPackagedWindowsNodePty('resources', 'x64', {
        hostPlatform: 'win32',
        canExecuteTargetArch: true,
        verifyMarker,
        verifyExports: vi.fn()
      })
    ).toThrow(/predates the Cygwin\/MSYS job-breakaway denial/)
  })

  it('is what the afterPack hook calls for a Windows slice', () => {
    expect(ELECTRON_BUILDER_CONFIG).toContain(
      'verifyPackagedWindowsNodePty(resourcesDir, context.arch, { canExecuteTargetArch })'
    )
  })
})
