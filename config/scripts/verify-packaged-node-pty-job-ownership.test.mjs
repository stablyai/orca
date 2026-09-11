import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  verifyPackagedNodePtyJobOwnership,
  verifyPackagedConptyBreakawayMarker
} = require('./verify-packaged-node-pty-job-ownership.cjs')

const fixtureDir = mkdtempSync(join(tmpdir(), 'packaged-node-pty-job-'))

function writeAddon(name, { cygwinBreakawayDenied }) {
  const path = join(fixtureDir, name)
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from('MZ fake addon '),
      cygwinBreakawayDenied ? Buffer.from('msys-2.0.dll', 'utf16le') : Buffer.alloc(0)
    ])
  )
  return path
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

describe('verifyPackagedConptyBreakawayMarker', () => {
  // This is the branch a Windows release built on another host takes, so it has
  // to work without loading the addon.
  it('fails a cross-host package whose addon predates the breakaway denial', () => {
    expect(() =>
      verifyPackagedConptyBreakawayMarker('resources', {
        packagedConptyPath: () => PRE_MSYS_ADDON
      })
    ).toThrow(/predates the Cygwin\/MSYS job-breakaway denial/)
  })

  it('passes a cross-host package built from current patched source', () => {
    expect(() =>
      verifyPackagedConptyBreakawayMarker('resources', {
        packagedConptyPath: () => CURRENT_ADDON
      })
    ).not.toThrow()
  })

  it('warns instead of failing a layout it does not recognise', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      verifyPackagedConptyBreakawayMarker('resources', {
        packagedConptyPath: () => join(fixtureDir, 'absent.node')
      })
    ).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not check the MSYS'))
    warn.mockRestore()
  })

  // node-pty falls through build/Release -> build/Debug -> prebuilds/<platform>-<arch>, so a
  // package with no build/Release addon loads the prebuild. Warning there passes exactly the
  // package that ships the bug.
  it('fails when the only loadable addon is the unpatched prebuild', () => {
    expect(() =>
      verifyPackagedConptyBreakawayMarker('resources', {
        arch: 'arm64',
        packagedConptyPath: () => join(fixtureDir, 'absent.node'),
        prebuiltConptyPath: () => PRE_MSYS_ADDON
      })
    ).toThrow(/predates the Cygwin\/MSYS job-breakaway denial/)
  })

  it('accepts a package whose only addon is a patched prebuild', () => {
    expect(() =>
      verifyPackagedConptyBreakawayMarker('resources', {
        arch: 'arm64',
        packagedConptyPath: () => join(fixtureDir, 'absent.node'),
        prebuiltConptyPath: () => CURRENT_ADDON
      })
    ).not.toThrow()
  })

  it('still warns when neither the build output nor a prebuild is there', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      verifyPackagedConptyBreakawayMarker('resources', {
        arch: 'arm64',
        packagedConptyPath: () => join(fixtureDir, 'absent.node'),
        prebuiltConptyPath: () => join(fixtureDir, 'also-absent.node')
      })
    ).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not check the MSYS'))
    warn.mockRestore()
  })

  it('looks where the loader would find the prebuild fallback', () => {
    const exists = vi.fn().mockReturnValue(false)
    verifyPackagedConptyBreakawayMarker(join('out', 'win-arm64-unpacked', 'resources'), {
      arch: 'arm64',
      exists
    })
    expect(exists).toHaveBeenCalledWith(
      join(
        'out',
        'win-arm64-unpacked',
        'resources',
        'node_modules',
        'node-pty',
        'prebuilds',
        'win32-arm64',
        'conpty.node'
      )
    )
  })

  it('looks where electron-builder actually lands the addon', () => {
    const exists = vi.fn().mockReturnValue(false)
    verifyPackagedConptyBreakawayMarker(join('out', 'win-unpacked', 'resources'), { exists })
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
