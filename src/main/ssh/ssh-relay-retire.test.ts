import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn()
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import { retireOrphanedRelayCommand, tryRetireOrphanedRelay } from './ssh-relay-retire'
import type { SshConnection } from './ssh-connection'
import type { RemoteHostPlatform } from './ssh-remote-platform'

const asHost = (os: string): RemoteHostPlatform =>
  ({
    path: os === 'win32' ? 'windows' : 'posix',
    command: os === 'win32' ? 'powershell' : 'posix',
    os,
    arch: 'x64',
    home: '/home/u'
  }) as unknown as RemoteHostPlatform

const POSIX_HOST = asHost('linux')
const WINDOWS_HOST = asHost('win32')

function writeExecutable(filePath: string, body: string): void {
  writeFileSync(filePath, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(socketPath, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe('tryRetireOrphanedRelay', () => {
  let envBin: string
  let remoteDir: string
  let server: Server

  beforeEach(() => {
    envBin = mkdtempSync(join(tmpdir(), 'orca-retire-bin-'))
    remoteDir = mkdtempSync(join(tmpdir(), 'orca-retire-dir-'))
    server = createServer(() => {})
  })

  afterEach(async () => {
    await closeServer(server).catch(() => {})
    rmSync(envBin, { recursive: true, force: true })
    rmSync(remoteDir, { recursive: true, force: true })
    vi.resetAllMocks()
  })

  // Runs the generated POSIX script under /bin/sh locally with a fake lsof on
  // PATH and the temp dir substituted for the remote relay dir.
  function mockExecRunsScriptLocally(): void {
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      const script = command.replace(
        /dir=[^\n]+/,
        `dir=${JSON.stringify(remoteDir).replaceAll('~', '\\~')}`
      )
      return execFileSync('/bin/sh', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${envBin}${delimiter}${process.env.PATH}` },
        timeout: 15_000
      }).trim()
    })
  }

  it('returns false without touching the host for Windows remotes', async () => {
    mockExecRunsScriptLocally()
    await expect(
      tryRetireOrphanedRelay(
        {} as SshConnection,
        '/remote/orca-remote/relay-0.1.0+abc',
        WINDOWS_HOST
      )
    ).resolves.toBe(false)
    expect(vi.mocked(execCommand)).not.toHaveBeenCalled()
  })

  it('retires an orphaned listening daemon and reports RETIRED once its socket is gone', async () => {
    mockExecRunsScriptLocally()
    const sockPath = join(remoteDir, 'relay-0123456789abcdef.sock')
    await listenOnSocket(server, sockPath)
    // Fake lsof: one holder (the daemon), then unlink the socket like SIGTERM cleanup would.
    writeExecutable(
      join(envBin, 'lsof'),
      ['for last; do :; done', '(sleep 0.2; rm -f "$last") &', 'echo $!'].join('\n')
    )

    const result = await tryRetireOrphanedRelay(
      {} as SshConnection,
      '/remote/orca-remote/relay-0.1.0+abc',
      POSIX_HOST
    )

    expect(result).toBe(true)
  })

  it('keeps the directory when a client is still connected to the socket', async () => {
    mockExecRunsScriptLocally()
    const sockPath = join(remoteDir, 'relay-0123456789abcdef.sock')
    await listenOnSocket(server, sockPath)
    const client = createConnection(sockPath)
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve)
      client.once('error', reject)
    })
    writeExecutable(
      join(envBin, 'lsof'),
      ['for last; do :; done', 'echo $$ $PARENT_FAKE # two holders: listener plus client'].join(
        '\n'
      )
    )

    const result = await tryRetireOrphanedRelay(
      {} as SshConnection,
      '/remote/orca-remote/relay-0.1.0+abc',
      POSIX_HOST
    )

    expect(result).toBe(false)
    expect(existsSync(sockPath)).toBe(true)
    client.destroy()
  })

  it('keeps the directory when lsof is unavailable on the remote host', async () => {
    mockExecRunsScriptLocally()
    writeExecutable(join(envBin, 'lsof'), `exit 127 # not installed`)
    await listenOnSocket(server, join(remoteDir, 'relay-0123456789abcdef.sock'))
    await expect(
      tryRetireOrphanedRelay({} as SshConnection, '/remote/orca-remote/relay-0.1.0+abc', POSIX_HOST)
    ).resolves.toBe(false)
  })

  it('reports RETIRED for a directory with no sockets at all', async () => {
    mockExecRunsScriptLocally()
    await expect(
      tryRetireOrphanedRelay({} as SshConnection, '/remote/orca-remote/relay-0.1.0+abc', POSIX_HOST)
    ).resolves.toBe(true)
  })

  it('returns false when the exec fails', async () => {
    vi.mocked(execCommand).mockRejectedValue(new Error('ssh channel died'))
    await expect(
      tryRetireOrphanedRelay({} as SshConnection, '/remote/orca-remote/relay-0.1.0+abc', POSIX_HOST)
    ).resolves.toBe(false)
  })
})

describe('retireOrphanedRelayCommand', () => {
  it('escapes the directory path', () => {
    const command = retireOrphanedRelayCommand('/remote/dir with space')
    expect(command).toContain("dir='/remote/dir with space'")
  })

  it('never emits SIGKILL — retirement stays graceful', () => {
    const command = retireOrphanedRelayCommand('/remote/dir')
    expect(command).toContain('kill -TERM')
    expect(command).not.toContain('kill -KILL')
  })
})
