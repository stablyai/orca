import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ORCAD_IROH_LINUX_X64_GLIBC_ARTIFACTS,
  orcadRipgrepArtifact
} from '../../../shared/orcad-artifacts'
import {
  listRemoteInstallBaseDirsCommand,
  probeRemoteInstallCompleteCommand
} from '../../ssh/ssh-remote-commands'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

import {
  inventoryRemoteInstallDirs,
  ORCAD_INSTALL_MODEL,
  RELAY_INSTALL_MODEL,
  remoteInstallDirOwner,
  remoteInstallGcPermits,
  remoteInstallVersionDirRegex
} from './remote-install-model'

const RELAY_DIRS = ['relay-0.1.0+abcdef123456', 'relay-v0.1.0', 'relay-1.2.3']
const ORCAD_DIRS = ['orcad-0.1.0+abcdef123456', 'orcad-v0.1.0', 'orcad-1.2.3']

describe('remote install namespace', () => {
  it.skipIf(process.platform === 'win32')('rejects an install missing its search binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-remote-probe-'))
    try {
      const host = getRemoteHostPlatform('linux-x64')
      const required = [
        ...ORCAD_INSTALL_MODEL.requiredArtifacts(host, 'linux-x64-glibc'),
        '.install-complete'
      ]
      for (const filename of required) {
        const path = join(dir, filename)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, '')
      }
      const command = probeRemoteInstallCompleteCommand(host, dir, required)
      expect(execFileSync('sh', ['-c', command], { encoding: 'utf8' }).trim()).toBe('OK')
      rmSync(join(dir, orcadRipgrepArtifact('linux-x64')))
      expect(execFileSync('sh', ['-c', command], { encoding: 'utf8' }).trim()).toBe('MISSING')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32').each([
    ['linux-x64-glibc', 'linux-x64'],
    ['linux-x64-musl', 'linux-x64'],
    ['linux-x64-glibc217', 'linux-x64'],
    ['linux-arm64-glibc', 'linux-arm64'],
    ['linux-arm64-musl', 'linux-arm64']
  ] as const)('requires the Iroh closure only for linux-x64-glibc (%s)', (target, platform) => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-iroh-probe-'))
    try {
      const host = getRemoteHostPlatform(platform)
      const required = [
        ...ORCAD_INSTALL_MODEL.requiredArtifacts(host, target),
        ORCAD_INSTALL_MODEL.installCompleteFilename
      ]
      for (const filename of required) {
        const path = join(dir, filename)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, '')
      }
      const command = probeRemoteInstallCompleteCommand(host, dir, required)
      expect(execFileSync('sh', ['-c', command], { encoding: 'utf8' }).trim()).toBe('OK')
      for (const filename of ORCAD_IROH_LINUX_X64_GLIBC_ARTIFACTS) {
        const requiresIroh = target === 'linux-x64-glibc'
        expect(required.includes(filename)).toBe(requiresIroh)
        rmSync(join(dir, filename), { force: true })
        expect(execFileSync('sh', ['-c', command], { encoding: 'utf8' }).trim()).toBe(
          requiresIroh ? 'MISSING' : 'OK'
        )
        if (requiresIroh) {
          writeFileSync(join(dir, filename), '')
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a dir prefix that could escape a remote glob or quote', () => {
    const injected = { ...RELAY_INSTALL_MODEL, dirPrefix: "relay'; rm -rf ~" }
    expect(() => remoteInstallVersionDirRegex(injected)).toThrow('Unsafe remote install dir prefix')
  })
})

describe('GC ownership — each model collects only its own namespace', () => {
  it.each(ORCAD_DIRS)('the relay never permits GC of %s', (dirName) => {
    expect(remoteInstallDirOwner(dirName)).toBe('orcad')
    expect(remoteInstallGcPermits(RELAY_INSTALL_MODEL, dirName)).toBe(false)
  })

  it.each(RELAY_DIRS)('orcad never permits GC of %s', (dirName) => {
    expect(remoteInstallDirOwner(dirName)).toBe('relay')
    expect(remoteInstallGcPermits(ORCAD_INSTALL_MODEL, dirName)).toBe(false)
  })

  it('permits each model its own dirs and its own tombstones', () => {
    expect(remoteInstallGcPermits(RELAY_INSTALL_MODEL, 'relay-0.1.0+aa')).toBe(true)
    expect(remoteInstallGcPermits(ORCAD_INSTALL_MODEL, 'orcad-0.1.0+aa')).toBe(true)
    expect(remoteInstallGcPermits(ORCAD_INSTALL_MODEL, 'orcad-0.1.0+aa.gc-tombstone.12.34')).toBe(
      true
    )
  })

  it('claims nothing it did not create', () => {
    for (const name of ['.orca-remote', 'orcad', 'relayish-0.1.0', 'orcad-notaversion', 'node']) {
      expect(remoteInstallDirOwner(name)).toBeNull()
      expect(remoteInstallGcPermits(RELAY_INSTALL_MODEL, name)).toBe(false)
      expect(remoteInstallGcPermits(ORCAD_INSTALL_MODEL, name)).toBe(false)
    }
  })

  it('gives the shared runtime store its own owner that no version-dir GC may take', () => {
    expect(remoteInstallDirOwner('runtimes')).toBe('runtimes')
    expect(remoteInstallGcPermits(RELAY_INSTALL_MODEL, 'runtimes')).toBe(false)
    expect(remoteInstallGcPermits(ORCAD_INSTALL_MODEL, 'runtimes')).toBe(false)
    expect(inventoryRemoteInstallDirs(['runtimes', ...RELAY_DIRS]).runtimes).toEqual(['runtimes'])
  })

  it.skipIf(process.platform === 'win32')(
    'keeps runtimes/ out of every model listing, including older clients’ prefix scans',
    () => {
      const base = mkdtempSync(join(tmpdir(), 'install-listing-'))
      try {
        for (const name of ['runtimes', 'relay-0.1.0+aa', 'orcad-0.1.0+aa']) {
          mkdirSync(join(base, name))
        }
        mkdirSync(join(base, 'runtimes', `node-${'a'.repeat(64)}`))
        const host = getRemoteHostPlatform('linux-x64')
        for (const model of [RELAY_INSTALL_MODEL, ORCAD_INSTALL_MODEL]) {
          const listed = execFileSync(
            '/bin/sh',
            ['-c', listRemoteInstallBaseDirsCommand(host, base, model)],
            { encoding: 'utf8' }
          )
          expect(listed.trim().split('\n')).toEqual([`${model.dirPrefix}-0.1.0+aa`])
        }
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    }
  )
})
