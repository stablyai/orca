import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execCommandMock, uploadRelayDirectoryMock, resolveBundledRipgrepPathMock } = vi.hoisted(
  () => ({
    execCommandMock: vi.fn(),
    uploadRelayDirectoryMock: vi.fn(),
    resolveBundledRipgrepPathMock: vi.fn()
  })
)

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: execCommandMock }))
vi.mock('./ssh-relay-install-transfers', () => ({ uploadRelayDirectory: uploadRelayDirectoryMock }))
vi.mock('../ripgrep/bundled-ripgrep-path', () => ({
  resolveBundledRipgrepPath: resolveBundledRipgrepPathMock,
  bundledRipgrepContentKey: () => 'c0ffee0123456789'
}))

import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'
import { ensureRemoteBundledRipgrep, remoteRipgrepLayout } from './ssh-relay-ripgrep-install'

const LINUX = getRemoteHostPlatform('linux-x64')
const WINDOWS = getRemoteHostPlatform('win32-x64')

function connection(usesSystemSsh = false): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the install only asks the connection which transport it uses; exec/upload are mocked.
  return { usesSystemSshTransport: () => usesSystemSsh } as unknown as SshConnection
}

function execScripts(): string[] {
  return execCommandMock.mock.calls.map(([, command]) => {
    const text = String(command)
    return text.includes('-EncodedCommand') ? decodeRemotePowerShellScript(text) : text
  })
}

describe('ensureRemoteBundledRipgrep', () => {
  let localDir: string
  let localBinary: string

  beforeEach(() => {
    execCommandMock.mockReset()
    uploadRelayDirectoryMock.mockReset().mockResolvedValue(undefined)
    localDir = mkdtempSync(join(tmpdir(), 'orca-local-rg-'))
    localBinary = join(localDir, 'linux-x64', 'rg')
    mkdirSync(dirname(localBinary))
    writeFileSync(localBinary, 'x'.repeat(1234))
    resolveBundledRipgrepPathMock.mockReset().mockReturnValue(localBinary)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('keys the cache on the binary content hash and platform, not the relay version', () => {
    expect(remoteRipgrepLayout(LINUX, '/home/me')?.binaryPath).toBe(
      '/home/me/.orca-remote/ripgrep/c0ffee0123456789-linux-x64/rg'
    )
    expect(remoteRipgrepLayout(WINDOWS, 'C:/Users/me user')?.binaryPath).toBe(
      'C:/Users/me user/.orca-remote/ripgrep/c0ffee0123456789-win32-x64/rg.exe'
    )
  })

  it('limits Windows cache cleanup to abandoned upload stages', async () => {
    execCommandMock.mockResolvedValueOnce('ORCA-RG-PRESENT\n')

    await ensureRemoteBundledRipgrep(connection(), WINDOWS, 'C:/Users/me user')

    const script = execScripts()[0]
    expect(script.match(/Get-ChildItem/g)).toHaveLength(1)
    expect(script).toContain("-Filter '.upload-*'")
  })

  it('skips the upload in one round trip when the binary is already installed', async () => {
    execCommandMock.mockResolvedValueOnce('ORCA-RG-PRESENT\n')

    await expect(ensureRemoteBundledRipgrep(connection(), LINUX, '/home/me')).resolves.toBe(
      'present'
    )

    expect(execCommandMock).toHaveBeenCalledTimes(1)
    expect(execScripts()[0]).toContain(
      "-x '/home/me/.orca-remote/ripgrep/c0ffee0123456789-linux-x64/rg'"
    )
    expect(uploadRelayDirectoryMock).not.toHaveBeenCalled()
  })

  // Why the marker matters: it is the only thing that tells the cache GC this build is in use.
  // Without it the GC cannot distinguish "nobody uses this" from "nobody recorded it", and the
  // safe answer to the second is to collect nothing at all.
  it('records the reference before checking or installing its binary', async () => {
    execCommandMock.mockResolvedValueOnce('').mockResolvedValueOnce('ORCA-RG-PRESENT\n')

    await ensureRemoteBundledRipgrep(connection(), LINUX, '/home/me', {
      relayDir: '/home/me/.orca-remote/relay-1.2.3'
    })

    const ref = execScripts()[0]
    expect(ref).toContain('c0ffee0123456789-linux-x64')
    expect(ref).toContain('/home/me/.orca-remote/relay-1.2.3/.ripgrep-ref')
  })

  it('does not inspect or upload the binary after its reference write fails', async () => {
    execCommandMock.mockRejectedValueOnce(new Error('read-only relay directory'))
    await expect(
      ensureRemoteBundledRipgrep(connection(), LINUX, '/home/me', {
        relayDir: '/home/me/.orca-remote/relay-1.2.3'
      })
    ).resolves.toBe('failed')
    expect(execCommandMock).toHaveBeenCalledTimes(1)
    expect(uploadRelayDirectoryMock).not.toHaveBeenCalled()
  })

  it('records nothing when the host has no bundled build to reference', async () => {
    resolveBundledRipgrepPathMock.mockReturnValue(null)

    await ensureRemoteBundledRipgrep(connection(), LINUX, '/home/me', {
      relayDir: '/home/me/.orca-remote/relay-1.2.3'
    })

    expect(execScripts().some((script) => script.includes('.ripgrep-ref'))).toBe(false)
  })

  it('uploads into a private stage, then verifies, chmods and renames into place', async () => {
    execCommandMock
      .mockResolvedValueOnce('ORCA-RG-STAGED\n')
      .mockResolvedValueOnce('ORCA-RG-INSTALLED\n')

    await expect(ensureRemoteBundledRipgrep(connection(), LINUX, '/home/me')).resolves.toBe(
      'installed'
    )

    const [, source, payloadDir, host, options] = uploadRelayDirectoryMock.mock.calls[0]
    expect(source).toBe(dirname(localBinary))
    expect(payloadDir).toMatch(
      /^\/home\/me\/\.orca-remote\/ripgrep\/\.upload-[0-9a-f]{16}\/payload$/
    )
    expect(host).toBe(LINUX)
    // Why: a chrooted SFTP subsystem must resolve the stage through its marker, like relay uploads.
    expect(options.sftpNamespace?.homeRelativePath).toBe(payloadDir.slice('/home/me/'.length))
    const promote = execScripts()[1]
    expect(promote).toContain('wc -c')
    expect(promote).toContain('"1234"')
    expect(promote).toContain('chmod 755')
    expect(promote).toContain(
      `mv -f '${payloadDir}/rg' '/home/me/.orca-remote/ripgrep/c0ffee0123456789-linux-x64/rg'`
    )
  })

  it('reports an upload failure instead of throwing, and removes its stage', async () => {
    execCommandMock.mockResolvedValueOnce('ORCA-RG-STAGED\n').mockResolvedValueOnce('')
    uploadRelayDirectoryMock.mockRejectedValueOnce(new Error('sftp: permission denied'))

    await expect(ensureRemoteBundledRipgrep(connection(), LINUX, '/home/me')).resolves.toBe(
      'failed'
    )

    expect(execScripts()[1]).toMatch(/^rm -rf '\/home\/me\/\.orca-remote\/ripgrep\/\.upload-/)
  })

  it('reports a failed size verification', async () => {
    execCommandMock
      .mockResolvedValueOnce('ORCA-RG-STAGED\n')
      .mockResolvedValueOnce('ORCA-RG-FAILED\n')

    await expect(ensureRemoteBundledRipgrep(connection(), LINUX, '/home/me')).resolves.toBe(
      'failed'
    )
  })

  it('does nothing when this install has no binary for the host', async () => {
    resolveBundledRipgrepPathMock.mockReturnValue(null)

    await expect(ensureRemoteBundledRipgrep(connection(), LINUX, '/home/me')).resolves.toBe(
      'unavailable'
    )
    expect(execCommandMock).not.toHaveBeenCalled()
  })

  it('installs rg.exe on Windows hosts with PowerShell and no SFTP namespace mapping', async () => {
    resolveBundledRipgrepPathMock.mockReturnValue(localBinary)
    execCommandMock
      .mockResolvedValueOnce('ORCA-RG-STAGED\r\n')
      .mockResolvedValueOnce('ORCA-RG-INSTALLED\r\n')

    await expect(
      ensureRemoteBundledRipgrep(connection(), WINDOWS, 'C:/Users/me user')
    ).resolves.toBe('installed')

    expect(execCommandMock.mock.calls.every(([, , opts]) => opts.wrapCommand === false)).toBe(true)
    const [probe, promote] = execScripts()
    expect(probe).toContain(
      "Test-Path -LiteralPath 'C:/Users/me user/.orca-remote/ripgrep/c0ffee0123456789-win32-x64/rg.exe'"
    )
    expect(promote).toContain('Move-Item -LiteralPath $src -Destination $bin')
    expect(promote).toContain('.Length -eq 1234')
    expect(uploadRelayDirectoryMock.mock.calls[0][4].sftpNamespace).toBeUndefined()
  })

  it('skips the SFTP namespace mapping on the system-ssh transport', async () => {
    execCommandMock
      .mockResolvedValueOnce('ORCA-RG-STAGED\n')
      .mockResolvedValueOnce('ORCA-RG-INSTALLED\n')

    await ensureRemoteBundledRipgrep(connection(true), LINUX, '/home/me')

    expect(uploadRelayDirectoryMock.mock.calls[0][4].sftpNamespace).toBeUndefined()
  })
})

// Debian and Ubuntu point /bin/sh at dash; run both so a bashism cannot pass here and fail on a host.
const SHELLS = ['/bin/sh', '/bin/dash'].filter((shell) => existsSync(shell))

describe.runIf(process.platform !== 'win32').each(SHELLS)(
  'remote ripgrep install scripts (%s)',
  (shell) => {
    let home: string
    let localDir: string
    let localBinary: string

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'orca-remote-home-'))
      localDir = mkdtempSync(join(tmpdir(), 'orca-local-rg-'))
      localBinary = join(localDir, 'linux-x64', 'rg')
      mkdirSync(dirname(localBinary))
      writeFileSync(localBinary, '#!/bin/sh\necho ripgrep 15.0.0\n')
      resolveBundledRipgrepPathMock.mockReset().mockReturnValue(localBinary)
      execCommandMock
        .mockReset()
        .mockImplementation(async (_conn: unknown, command: string) =>
          execFileSync(shell, ['-c', command], { encoding: 'utf-8' })
        )
      uploadRelayDirectoryMock
        .mockReset()
        .mockImplementation(async (_conn: unknown, source: string, target: string) => {
          cpSync(source, target, { recursive: true })
        })
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      rmSync(home, { recursive: true, force: true })
      rmSync(localDir, { recursive: true, force: true })
      vi.restoreAllMocks()
    })

    const installed = (): string =>
      join(home, '.orca-remote', 'ripgrep', 'c0ffee0123456789-linux-x64', 'rg')
    const cacheEntries = (): string[] => readdirSync(join(home, '.orca-remote', 'ripgrep'))

    it('installs an executable binary once and leaves no stage behind', async () => {
      await expect(ensureRemoteBundledRipgrep(connection(), LINUX, home)).resolves.toBe('installed')
      expect(statSync(installed()).mode & 0o111).not.toBe(0)
      expect(execFileSync(installed(), { encoding: 'utf-8' })).toContain('ripgrep 15.0.0')
      expect(cacheEntries()).toEqual(['c0ffee0123456789-linux-x64'])

      await expect(ensureRemoteBundledRipgrep(connection(), LINUX, home)).resolves.toBe('present')
      expect(uploadRelayDirectoryMock).toHaveBeenCalledTimes(1)
    })

    it('never publishes a truncated upload', async () => {
      uploadRelayDirectoryMock.mockImplementation(
        async (_conn: unknown, source: string, target: string) => {
          cpSync(source, target, { recursive: true })
          truncateSync(join(target, 'rg'), 5)
        }
      )

      await expect(ensureRemoteBundledRipgrep(connection(), LINUX, home)).resolves.toBe('failed')
      expect(existsSync(installed())).toBe(false)
      expect(cacheEntries()).toEqual([])
    })

    it('replaces a truncated binary left at the installed path', async () => {
      mkdirSync(dirname(installed()), { recursive: true })
      writeFileSync(installed(), '#!/bin/sh\n', { mode: 0o755 })

      await expect(ensureRemoteBundledRipgrep(connection(), LINUX, home)).resolves.toBe('installed')
      expect(execFileSync(installed(), { encoding: 'utf-8' })).toContain('ripgrep 15.0.0')
    })

    it('keeps an old binary usable by a relay pinned to an earlier client build', async () => {
      const previous = join(home, '.orca-remote', 'ripgrep', 'previous-linux-x64', 'rg')
      mkdirSync(dirname(previous), { recursive: true })
      writeFileSync(previous, '#!/bin/sh\necho ripgrep previous\n', { mode: 0o755 })
      execFileSync('touch', ['-t', '200001010000', dirname(previous)])
      expect(execFileSync(previous, { encoding: 'utf-8' })).toContain('ripgrep previous')

      await expect(ensureRemoteBundledRipgrep(connection(), LINUX, home)).resolves.toBe('installed')
      await expect(ensureRemoteBundledRipgrep(connection(), LINUX, home)).resolves.toBe('present')

      expect(execFileSync(previous, { encoding: 'utf-8' })).toContain('ripgrep previous')
    })

    it('sweeps an abandoned stage older than an hour but keeps a live one', async () => {
      const cache = join(home, '.orca-remote', 'ripgrep')
      mkdirSync(join(cache, '.upload-stale', 'payload'), { recursive: true })
      mkdirSync(join(cache, '.upload-live', 'payload'), { recursive: true })
      execFileSync('touch', ['-t', '200001010000', join(cache, '.upload-stale')])

      await ensureRemoteBundledRipgrep(connection(), LINUX, home)

      expect(cacheEntries().sort()).toEqual(['.upload-live', 'c0ffee0123456789-linux-x64'])
    })
  }
)
