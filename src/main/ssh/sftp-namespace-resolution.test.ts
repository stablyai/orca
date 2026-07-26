// Why: picking the wrong SFTP path silently installs the relay somewhere the shell
// will never launch it, so every discovery outcome needs a pinned decision.

import type { SFTPWrapper } from 'ssh2'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveSftpTransferPath,
  resolveSftpTransferPathIfMapped,
  type SftpNamespacePathMapping
} from './sftp-namespace-resolution'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const SHELL_HOME = '/var/services/homes/alice'
const RELAY_DIR = '.orca-remote/relay-0.1.0+hash'
const MARKER = '.install-lock/.sftp-namespace-deadbeef'

const mapping: SftpNamespacePathMapping = {
  homeRelativePath: RELAY_DIR,
  shellProbePath: `${SHELL_HOME}/${RELAY_DIR}/${MARKER}`,
  homeRelativeProbePath: `${RELAY_DIR}/${MARKER}`
}

type LstatOutcome = 'present' | { code: number } | { message: string }

function statusError(code: number): Error {
  return Object.assign(new Error(`SFTP status ${code}`), { code })
}

// A marker probe must care only about "the call succeeded", never about the reported type or size.
const MARKER_STATS = {
  isDirectory: () => false,
  isSymbolicLink: () => true,
  mode: 0o120_777,
  size: 0
}

function makeSftp(options: {
  startPath?: string | Error | unknown
  lstat?: (path: string) => LstatOutcome
}): {
  sftp: SFTPWrapper
  realpathCalls: string[]
  lstatCalls: string[]
} {
  const realpathCalls: string[] = []
  const lstatCalls: string[] = []
  const sftp = {
    realpath: vi.fn((path: string, cb: (err: Error | null, resolved?: unknown) => void) => {
      realpathCalls.push(path)
      if (options.startPath instanceof Error) {
        cb(options.startPath)
        return
      }
      cb(null, options.startPath)
    }),
    lstat: vi.fn((path: string, cb: (err: Error | null, stats?: unknown) => void) => {
      lstatCalls.push(path)
      const outcome = options.lstat?.(path) ?? { code: 2 }
      if (outcome === 'present') {
        cb(null, MARKER_STATS)
        return
      }
      cb('code' in outcome ? statusError(outcome.code) : new Error(outcome.message))
    })
  }
  return { sftp: sftp as unknown as SFTPWrapper, realpathCalls, lstatCalls }
}

// The marker lives under the SFTP start directory but not under the shell path.
function divergentLstat(startPath: string) {
  return (path: string): LstatOutcome =>
    path === `${startPath}/${RELAY_DIR}/${MARKER}` ? 'present' : { code: 2 }
}

describe('resolveSftpTransferPath', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('keeps the shell path and skips probing when both namespaces agree', async () => {
    const { sftp, lstatCalls } = makeSftp({ startPath: SHELL_HOME })

    const resolved = await resolveSftpTransferPath(sftp, `${SHELL_HOME}/${RELAY_DIR}`, mapping)

    expect(resolved).toBe(`${SHELL_HOME}/${RELAY_DIR}`)
    expect(lstatCalls).toEqual([])
  })

  it('redirects to the SFTP namespace when only that side carries our marker', async () => {
    const { sftp, lstatCalls } = makeSftp({
      startPath: '/homes/alice',
      lstat: divergentLstat('/homes/alice')
    })

    const resolved = await resolveSftpTransferPath(sftp, `${SHELL_HOME}/${RELAY_DIR}`, mapping)

    expect(resolved).toBe(`/homes/alice/${RELAY_DIR}`)
    expect(lstatCalls).toEqual([
      `${SHELL_HOME}/${RELAY_DIR}/${MARKER}`,
      `/homes/alice/${RELAY_DIR}/${MARKER}`
    ])
  })

  it('handles a start directory that is not a home directory at all', async () => {
    const { sftp } = makeSftp({
      startPath: '/volume1/shared',
      lstat: divergentLstat('/volume1/shared')
    })

    const resolved = await resolveSftpTransferPath(sftp, `${SHELL_HOME}/${RELAY_DIR}`, mapping)

    expect(resolved).toBe(`/volume1/shared/${RELAY_DIR}`)
  })

  it('normalizes a trailing slash on the reported start directory', async () => {
    const { sftp } = makeSftp({
      startPath: '/homes/alice/',
      lstat: divergentLstat('/homes/alice')
    })

    const resolved = await resolveSftpTransferPath(sftp, `${SHELL_HOME}/${RELAY_DIR}`, mapping)

    expect(resolved).toBe(`/homes/alice/${RELAY_DIR}`)
  })

  it('resolves a nested file path, not just the relay directory', async () => {
    const fileMapping: SftpNamespacePathMapping = {
      ...mapping,
      homeRelativePath: `${RELAY_DIR}/package.json`
    }
    const { sftp } = makeSftp({
      startPath: '/homes/alice',
      lstat: divergentLstat('/homes/alice')
    })

    const resolved = await resolveSftpTransferPath(
      sftp,
      `${SHELL_HOME}/${RELAY_DIR}/package.json`,
      fileMapping
    )

    expect(resolved).toBe(`/homes/alice/${RELAY_DIR}/package.json`)
  })

  it('refuses an unrelated same-version directory that lacks our marker', async () => {
    const { sftp, lstatCalls } = makeSftp({ startPath: '/homes/alice' })

    const resolved = await resolveSftpTransferPath(sftp, `${SHELL_HOME}/${RELAY_DIR}`, mapping)

    expect(resolved).toBe(`${SHELL_HOME}/${RELAY_DIR}`)
    expect(lstatCalls).toHaveLength(2)
  })

  it('keeps the shell path when the marker is already visible there', async () => {
    const { sftp, lstatCalls } = makeSftp({
      startPath: '/homes/alice',
      lstat: (path) => (path === mapping.shellProbePath ? 'present' : { code: 2 })
    })

    const resolved = await resolveSftpTransferPath(sftp, `${SHELL_HOME}/${RELAY_DIR}`, mapping)

    expect(resolved).toBe(`${SHELL_HOME}/${RELAY_DIR}`)
    expect(lstatCalls).toEqual([mapping.shellProbePath])
  })

  // Why: only SSH_FX_NO_SUCH_FILE proves absence; anything else must not license a redirect.
  it.each([
    ['generic failure', { code: 4 } as LstatOutcome],
    ['permission denied', { code: 3 } as LstatOutcome],
    ['a code-less transport error', { message: 'socket hang up' } as LstatOutcome]
  ])('never probes the candidate after %s on the shell marker', async (_label, outcome) => {
    const { sftp, lstatCalls } = makeSftp({
      startPath: '/homes/alice',
      lstat: (path) => (path === mapping.shellProbePath ? outcome : 'present')
    })

    const resolved = await resolveSftpTransferPath(sftp, `${SHELL_HOME}/${RELAY_DIR}`, mapping)

    expect(resolved).toBe(`${SHELL_HOME}/${RELAY_DIR}`)
    expect(lstatCalls).toEqual([mapping.shellProbePath])
  })

  it('keeps the shell path when the candidate probe is inconclusive', async () => {
    const { sftp } = makeSftp({
      startPath: '/homes/alice',
      lstat: (path) => (path === mapping.shellProbePath ? { code: 2 } : { code: 4 })
    })

    const resolved = await resolveSftpTransferPath(sftp, `${SHELL_HOME}/${RELAY_DIR}`, mapping)

    expect(resolved).toBe(`${SHELL_HOME}/${RELAY_DIR}`)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('retaining shell path'))
  })

  it.each([
    ['REALPATH fails', new Error('permission denied')],
    ['REALPATH returns a relative path', 'homes/alice'],
    ['REALPATH returns a non-string', 42],
    ['REALPATH smuggles a line break', '/homes/alice\nrm -rf /'],
    ['REALPATH contains an empty component', '/homes//alice'],
    ['REALPATH contains a dot component', '/homes/./alice'],
    ['REALPATH contains a traversal component', '/homes/archive/../alice']
  ])('keeps the shell path and skips LSTAT when %s', async (_label, startPath) => {
    const { sftp, lstatCalls } = makeSftp({ startPath })

    const resolved = await resolveSftpTransferPath(sftp, `${SHELL_HOME}/${RELAY_DIR}`, mapping)

    expect(resolved).toBe(`${SHELL_HOME}/${RELAY_DIR}`)
    expect(lstatCalls).toEqual([])
  })

  it.each([
    ['a relative shell path', { shell: `${SHELL_HOME}/${RELAY_DIR}`.slice(1) }, 'SFTP namespace'],
    ['an absolute home-relative path', { homeRelativePath: `/${RELAY_DIR}` }, 'SFTP namespace'],
    ['a traversal segment', { homeRelativePath: `${RELAY_DIR}/../escape` }, 'Unsafe remote path'],
    [
      'a traversal segment in the absolute shell path',
      { shell: `${SHELL_HOME}/archive/../${RELAY_DIR}` },
      'Unsafe remote path'
    ],
    [
      'an empty component in the absolute shell path',
      { shell: `${SHELL_HOME}//${RELAY_DIR}` },
      'Unsafe remote path'
    ],
    [
      'a dot component in the absolute marker path',
      {
        shellProbePath: `${SHELL_HOME}/./${RELAY_DIR}/${MARKER}`,
        homeRelativeProbePath: `${RELAY_DIR}/${MARKER}`
      },
      'Unsafe remote path'
    ],
    ['a line break in the marker path', { shellProbePath: `${SHELL_HOME}/a\nb` }, 'SFTP namespace'],
    [
      'a mismatched transfer suffix',
      { shell: `${SHELL_HOME}/${RELAY_DIR}/other` },
      'share one home-relative suffix'
    ],
    [
      'a mismatched shell namespace prefix',
      { shellProbePath: `/other/home/${RELAY_DIR}/${MARKER}` },
      'share one shell namespace prefix'
    ],
    [
      'a mismatched marker basename',
      { homeRelativeProbePath: `${RELAY_DIR}/.install-lock/.sftp-namespace-other` },
      'marker paths must share one marker basename'
    ],
    [
      'a marker outside the install lock',
      {
        shellProbePath: `${SHELL_HOME}/${RELAY_DIR}/other-lock/.sftp-namespace-deadbeef`,
        homeRelativeProbePath: `${RELAY_DIR}/other-lock/.sftp-namespace-deadbeef`
      },
      'inside the transfer relay install lock'
    ],
    [
      'a marker under another relay tree',
      {
        shellProbePath: `${SHELL_HOME}/other/.install-lock/.sftp-namespace-deadbeef`,
        homeRelativeProbePath: 'other/.install-lock/.sftp-namespace-deadbeef'
      },
      'inside the transfer relay install lock'
    ]
  ])('rejects %s before issuing any SFTP request', async (_label, overrides, expected) => {
    const { shell, ...mappingOverrides } = overrides as Record<string, string>
    const { sftp, realpathCalls, lstatCalls } = makeSftp({ startPath: SHELL_HOME })

    await expect(
      resolveSftpTransferPath(sftp, shell ?? `${SHELL_HOME}/${RELAY_DIR}`, {
        ...mapping,
        ...mappingOverrides
      })
    ).rejects.toThrow(expected)
    expect(realpathCalls).toEqual([])
    expect(lstatCalls).toEqual([])
  })

  it('redacts marker tokens from discovery diagnostics', async () => {
    const token = 'a'.repeat(32)
    const secretMarker = `.install-lock/.sftp-namespace-${token}`
    const secretMapping: SftpNamespacePathMapping = {
      homeRelativePath: RELAY_DIR,
      shellProbePath: `${SHELL_HOME}/${RELAY_DIR}/${secretMarker}`,
      homeRelativeProbePath: `${RELAY_DIR}/${secretMarker}`
    }
    const { sftp } = makeSftp({
      startPath: '/homes/alice',
      lstat: () => ({ message: `failure at ${secretMapping.shellProbePath}` })
    })

    await resolveSftpTransferPath(sftp, `${SHELL_HOME}/${RELAY_DIR}`, secretMapping)

    const warnings = vi.mocked(console.warn).mock.calls.flat().join('\n')
    expect(warnings).toContain('.sftp-namespace-[redacted]')
    expect(warnings).not.toContain(token)
  })
})

describe('resolveSftpTransferPathIfMapped', () => {
  it('issues no discovery requests when no mapping was supplied', async () => {
    const { sftp, realpathCalls, lstatCalls } = makeSftp({ startPath: '/homes/alice' })

    const resolved = await resolveSftpTransferPathIfMapped(sftp, `${SHELL_HOME}/${RELAY_DIR}`, {
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(resolved).toBe(`${SHELL_HOME}/${RELAY_DIR}`)
    expect(realpathCalls).toEqual([])
    expect(lstatCalls).toEqual([])
  })

  // Why: Windows SFTP reports drive paths like /C:/Users/alice, which break the POSIX prefix contract.
  it('ignores a mapping on a Windows host', async () => {
    const { sftp, realpathCalls } = makeSftp({
      startPath: '/homes/alice',
      lstat: divergentLstat('/homes/alice')
    })

    const resolved = await resolveSftpTransferPathIfMapped(sftp, `${SHELL_HOME}/${RELAY_DIR}`, {
      hostPlatform: getRemoteHostPlatform('win32-x64'),
      sftpNamespace: mapping
    })

    expect(resolved).toBe(`${SHELL_HOME}/${RELAY_DIR}`)
    expect(realpathCalls).toEqual([])
  })

  it('conservatively ignores a Windows path when platform metadata is absent', async () => {
    const { sftp, realpathCalls, lstatCalls } = makeSftp({
      startPath: '/homes/alice',
      lstat: divergentLstat('/homes/alice')
    })
    const windowsPath = 'C:\\Users\\alice\\relay\\.version'

    const resolved = await resolveSftpTransferPathIfMapped(sftp, windowsPath, {
      sftpNamespace: mapping
    })

    expect(resolved).toBe(windowsPath)
    expect(realpathCalls).toEqual([])
    expect(lstatCalls).toEqual([])
  })

  it('resolves on a POSIX host with a mapping', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { sftp } = makeSftp({
      startPath: '/homes/alice',
      lstat: divergentLstat('/homes/alice')
    })

    const resolved = await resolveSftpTransferPathIfMapped(sftp, `${SHELL_HOME}/${RELAY_DIR}`, {
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      sftpNamespace: mapping
    })

    expect(resolved).toBe(`/homes/alice/${RELAY_DIR}`)
  })
})
