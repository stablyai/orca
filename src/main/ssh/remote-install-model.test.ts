import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ORCAD_RIPGREP_ARTIFACTS } from '../../shared/orcad-artifacts'
import { probeRemoteInstallCompleteCommand } from './ssh-remote-commands'
import { getRemoteHostPlatform } from './ssh-remote-platform'

import {
  inventoryRemoteInstallDirs,
  ORCAD_INSTALL_MODEL,
  RELAY_INSTALL_MODEL,
  remoteInstallDirName,
  remoteInstallDirOwner,
  remoteInstallGcPermits,
  remoteInstallListingRegexSource,
  remoteInstallVersionDirRegex
} from './remote-install-model'

const RELAY_DIRS = ['relay-0.1.0+abcdef123456', 'relay-v0.1.0', 'relay-1.2.3']
const ORCAD_DIRS = ['orcad-0.1.0+abcdef123456', 'orcad-v0.1.0', 'orcad-1.2.3']

it.each([false, true])(
  'requires the executable and both profile workers on Windows=%s',
  (isWindows) => {
    const artifacts = ORCAD_INSTALL_MODEL.requiredArtifacts(isWindows)
    expect(artifacts).toContain(isWindows ? 'bun-runtime.exe' : 'bun-runtime')
    expect(artifacts).not.toContain(isWindows ? 'bun-runtime' : 'bun-runtime.exe')
    expect(artifacts).toContain('profile-state-writer-worker-entry.js')
    expect(artifacts).toContain('profile-state-backup-worker-entry.js')
  }
)

describe('remote install namespace', () => {
  it('names each model its own version dir', () => {
    expect(remoteInstallDirName(RELAY_INSTALL_MODEL, '0.1.0+aa')).toBe('relay-0.1.0+aa')
    expect(remoteInstallDirName(ORCAD_INSTALL_MODEL, '0.1.0+aa')).toBe('orcad-0.1.0+aa')
  })

  it('requires every shipped search binary in a completed standalone runtime install', () => {
    const required = ORCAD_INSTALL_MODEL.requiredArtifacts(false)
    expect(required).toEqual(expect.arrayContaining([...ORCAD_RIPGREP_ARTIFACTS]))
    expect(ORCAD_INSTALL_MODEL.requiredArtifacts(true)).toEqual(required)
  })

  it.skipIf(process.platform === 'win32')('rejects an install missing its search binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-remote-probe-'))
    try {
      const required = [...ORCAD_INSTALL_MODEL.requiredArtifacts(false), '.install-complete']
      for (const filename of required) {
        const path = join(dir, filename)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, '')
      }
      const command = probeRemoteInstallCompleteCommand(
        getRemoteHostPlatform('linux-x64'),
        dir,
        required
      )
      expect(execFileSync('sh', ['-c', command], { encoding: 'utf8' }).trim()).toBe('OK')
      rmSync(join(dir, ORCAD_RIPGREP_ARTIFACTS[0]))
      expect(execFileSync('sh', ['-c', command], { encoding: 'utf8' }).trim()).toBe('MISSING')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the relay listing pattern byte-identical to the one it shipped with', () => {
    // The literal that was hardcoded in `listRelayBaseDirsCommand` before it was
    // parameterized. A drift here changes what an existing host's GC can see.
    expect(remoteInstallListingRegexSource(RELAY_INSTALL_MODEL)).toBe(
      String.raw`^relay-(v?[0-9]+\.[0-9]+\.[0-9]+(\+[0-9a-f]+)?)(\.gc-tombstone\.[0-9]+\.[0-9]+)?$`
    )
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

  it('groups a mixed listing without losing anything to the wrong owner', () => {
    const inventory = inventoryRemoteInstallDirs([...RELAY_DIRS, ...ORCAD_DIRS, 'something-else'])
    expect(inventory.relay).toEqual(RELAY_DIRS)
    expect(inventory.orcad).toEqual(ORCAD_DIRS)
    expect(inventory.unknown).toEqual(['something-else'])
  })
})
