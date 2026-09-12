import { describe, expect, it } from 'vitest'

import {
  inventoryRemoteInstallDirs,
  ORCAD_INSTALL_MODEL,
  RELAY_INSTALL_MODEL,
  remoteInstallDirName,
  isRemoteInstallVersion,
  remoteInstallDirOwner,
  remoteInstallGcPermits,
  remoteInstallGcTombstoneRegex,
  remoteInstallListingRegexSource,
  remoteInstallVersionDirRegex
} from './remote-install-model'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_BUN_RUNTIME_FILENAME,
  ORCAD_PARCEL_WATCHER_ENTRY,
  ORCAD_PARCEL_WATCHER_NATIVE
} from '../../shared/orcad-artifacts'

const RELAY_DIRS = [
  'relay-0.1.0+abcdef123456',
  'relay-v0.1.0',
  'relay-1.2.3',
  'relay-1.4.178-rc.2+abcdef123456'
]
const ORCAD_DIRS = [
  'orcad-0.1.0+abcdef123456',
  'orcad-v0.1.0',
  'orcad-1.2.3',
  'orcad-1.4.178-rc.2+abcdef123456'
]

describe('remote install namespace', () => {
  it('requires the self-contained Bun runtime and watcher in every orcad slot', () => {
    expect(ORCAD_INSTALL_MODEL.requiredArtifacts(true)).toContain('bun-runtime.exe')
    expect(ORCAD_INSTALL_MODEL.requiredArtifacts(true)).not.toContain('bun-runtime')
    expect(ORCAD_INSTALL_MODEL.requiredArtifacts(false)).toEqual(
      expect.arrayContaining([
        ORCAD_BUILD_TARGET_FILENAME,
        ORCAD_BUN_RUNTIME_FILENAME,
        ORCAD_PARCEL_WATCHER_ENTRY,
        ORCAD_PARCEL_WATCHER_NATIVE
      ])
    )
  })

  it('names each model its own version dir', () => {
    expect(remoteInstallDirName(RELAY_INSTALL_MODEL, '0.1.0+aa')).toBe('relay-0.1.0+aa')
    expect(remoteInstallDirName(ORCAD_INSTALL_MODEL, '0.1.0+aa')).toBe('orcad-0.1.0+aa')
  })

  it('keeps the relay listing pattern byte-identical to the one it shipped with', () => {
    // The base form remains compatible while prerelease builds are no longer invisible.
    expect(remoteInstallListingRegexSource(RELAY_INSTALL_MODEL)).toBe(
      String.raw`^relay-(v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?)(\.gc-tombstone\.[0-9]+\.[0-9]+)?$`
    )
  })

  it('accepts shipped prerelease versions but rejects path and log injection', () => {
    expect(isRemoteInstallVersion('1.4.178-rc.2+abcdef123456')).toBe(true)
    for (const unsafe of ['1.2.3/child', '../1.2.3', '1.2.3\nforged', 'latest']) {
      expect(isRemoteInstallVersion(unsafe)).toBe(false)
      expect(() => remoteInstallDirName(ORCAD_INSTALL_MODEL, unsafe)).toThrow(
        'Unsafe remote install version'
      )
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

  it('distinguishes GC tombstones from SemVer-looking live directory names', () => {
    expect(
      remoteInstallGcTombstoneRegex(RELAY_INSTALL_MODEL).test('relay-0.1.0+aa.gc-tombstone.12.34')
    ).toBe(true)
    expect(
      remoteInstallGcTombstoneRegex(ORCAD_INSTALL_MODEL).test('orcad-0.1.0+aa.gc-tombstone.12.34')
    ).toBe(true)
    expect(remoteInstallGcTombstoneRegex(ORCAD_INSTALL_MODEL).test('orcad-0.1.0+aa')).toBe(false)
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
