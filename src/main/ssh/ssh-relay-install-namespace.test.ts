// Why: the shell path and the SFTP-relative path must be built from the same
// validated segments, and the install-owner marker is what proves a redirected
// directory belongs to this install rather than an unrelated same-version one.

import { describe, expect, it } from 'vitest'
import {
  createRelayInstallMarkerCommand,
  createRelayInstallNamespace,
  makeRelayInstallDirectoryCommand,
  relayHomeRelativeDir,
  relayInstallMarkerShellPath,
  relayRemoteDirSegments,
  relaySftpNamespaceMapping
} from './ssh-relay-install-namespace'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { computeRemoteRelayDir } from './ssh-relay-versioned-install'

const LINUX = getRemoteHostPlatform('linux-x64')
const WINDOWS = getRemoteHostPlatform('win32-x64')
const VERSION = '0.1.0+abc123'
const SHELL_RELAY_DIR = `/var/services/homes/alice/.orca-remote/relay-${VERSION}`

describe('relayRemoteDirSegments', () => {
  it('builds the two segments every relay path shares', () => {
    expect(relayRemoteDirSegments(VERSION, 'posix')).toEqual(['.orca-remote', `relay-${VERSION}`])
  })

  it('produces a home-relative dir that matches the shell dir suffix', () => {
    expect(SHELL_RELAY_DIR.endsWith(`/${relayHomeRelativeDir(VERSION)}`)).toBe(true)
  })

  it.each([
    ['a path separator', '1.0/../etc'],
    ['a NUL byte', '1.0\0'],
    ['a carriage return', '1.0\rmalicious'],
    ['a line feed', '1.0\nmalicious']
  ])('rejects %s in the version segment', (_label, version) => {
    expect(() => relayRemoteDirSegments(version, 'posix')).toThrow('Unsafe remote path segment')
  })

  it('applies Windows-specific segment rules on the windows flavor', () => {
    expect(() => relayRemoteDirSegments('1.0 ', 'windows')).toThrow('Unsafe remote path segment')
    expect(() => relayRemoteDirSegments('1.0 ', 'posix')).not.toThrow()
  })
})

describe('computeRemoteRelayDir agreement', () => {
  it('ends with the suffix the SFTP-relative builder produces', () => {
    // Why: a split namespace rebuilds the path from the home-relative suffix, so the two must agree.
    expect(computeRemoteRelayDir('/var/services/homes/alice', VERSION)).toBe(SHELL_RELAY_DIR)
    expect(SHELL_RELAY_DIR.endsWith(`/${relayHomeRelativeDir(VERSION)}`)).toBe(true)
  })

  it.each([
    ['a path separator', '0.1.0/../etc'],
    ['a NUL byte', '0.1.0\0'],
    ['a line feed', '0.1.0\nrm -rf /']
  ])('rejects %s in the version rather than building a path', (_label, version) => {
    expect(() => computeRemoteRelayDir('/home/u', version)).toThrow('Unsafe remote path segment')
  })

  it('applies Windows segment rules on the windows flavor', () => {
    expect(computeRemoteRelayDir('C:\\Users\\u', VERSION, 'windows')).toBe(
      `C:/Users/u/.orca-remote/relay-${VERSION}`
    )
    expect(() => computeRemoteRelayDir('C:\\Users\\u', '0.1.0 ', 'windows')).toThrow(
      'Unsafe remote path segment'
    )
  })
})

describe('createRelayInstallNamespace', () => {
  it('mints an unguessable 128-bit marker name per install', () => {
    const first = createRelayInstallNamespace(relayHomeRelativeDir(VERSION))
    const second = createRelayInstallNamespace(relayHomeRelativeDir(VERSION))

    expect(first.markerFileName).toMatch(/^\.sftp-namespace-[0-9a-f]{32}$/)
    expect(first.markerFileName).not.toBe(second.markerFileName)
    expect(first.homeRelativeRelayDir).toBe(`.orca-remote/relay-${VERSION}`)
  })
})

describe('relaySftpNamespaceMapping', () => {
  const namespace = createRelayInstallNamespace(relayHomeRelativeDir(VERSION))

  it('maps the bundle directory itself when no file name is given', () => {
    const mapping = relaySftpNamespaceMapping(namespace, LINUX, SHELL_RELAY_DIR)

    expect(mapping.homeRelativePath).toBe(`.orca-remote/relay-${VERSION}`)
    expect(mapping.homeRelativeProbePath).toBe(
      `.orca-remote/relay-${VERSION}/.install-lock/${namespace.markerFileName}`
    )
    expect(mapping.shellProbePath).toBe(
      `${SHELL_RELAY_DIR}/.install-lock/${namespace.markerFileName}`
    )
  })

  it('maps a file inside the bundle directory', () => {
    const mapping = relaySftpNamespaceMapping(namespace, LINUX, SHELL_RELAY_DIR, 'package.json')

    expect(mapping.homeRelativePath).toBe(`.orca-remote/relay-${VERSION}/package.json`)
  })

  it('shares one marker across every write of an install', () => {
    const bundle = relaySftpNamespaceMapping(namespace, LINUX, SHELL_RELAY_DIR)
    const version = relaySftpNamespaceMapping(namespace, LINUX, SHELL_RELAY_DIR, '.version')

    expect(version.shellProbePath).toBe(bundle.shellProbePath)
    expect(version.homeRelativeProbePath).toBe(bundle.homeRelativeProbePath)
  })

  it.each(['nested/file', '..', '', 'line\nbreak'])(
    'rejects an unsafe relative file name %j at mapping construction',
    (relativeFileName) => {
      expect(() =>
        relaySftpNamespaceMapping(namespace, LINUX, SHELL_RELAY_DIR, relativeFileName)
      ).toThrow('Unsafe remote path segment')
    }
  )
})

describe('install directory command', () => {
  const namespace = createRelayInstallNamespace(relayHomeRelativeDir(VERSION))

  it('folds marker creation into the first-install mkdir', () => {
    const command = makeRelayInstallDirectoryCommand(LINUX, SHELL_RELAY_DIR, namespace)

    expect(command).toContain(SHELL_RELAY_DIR)
    expect(command).toContain(`${SHELL_RELAY_DIR}/.install-lock`)
    expect(command).toContain('umask 077')
    expect(command).toContain(`touch `)
    expect(command).toContain(namespace.markerFileName)
  })

  it('is the plain directory command when no namespace applies', () => {
    expect(makeRelayInstallDirectoryCommand(WINDOWS, 'C:\\Users\\alice\\relay')).not.toContain(
      '.sftp-namespace-'
    )
    expect(makeRelayInstallDirectoryCommand(LINUX, SHELL_RELAY_DIR)).not.toContain('touch ')
  })

  it('creates the lock directory before touching the marker inside it', () => {
    const command = createRelayInstallMarkerCommand(namespace, LINUX, SHELL_RELAY_DIR)
    const markerPath = relayInstallMarkerShellPath(namespace, LINUX, SHELL_RELAY_DIR)

    expect(command.indexOf('.install-lock')).toBeLessThan(command.indexOf('touch '))
    expect(command.indexOf('umask 077')).toBeLessThan(command.indexOf('touch '))
    expect(markerPath).toBe(`${SHELL_RELAY_DIR}/.install-lock/${namespace.markerFileName}`)
    expect(command).toContain(markerPath)
  })
})
