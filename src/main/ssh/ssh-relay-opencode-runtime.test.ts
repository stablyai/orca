import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  upload: vi.fn(),
  write: vi.fn(),
  materialize: vi.fn(),
  target: vi.fn()
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: mocks.exec }))
vi.mock('./ssh-relay-install-transfers', () => ({
  uploadRelayDirectory: mocks.upload,
  writeRelayFile: mocks.write
}))
vi.mock('./orcad-bun-runtime-materializer', () => ({
  materializeCachedOrcadBunRuntime: mocks.materialize
}))
vi.mock('./orcad-deployment-target', () => ({ resolveOrcadDeploymentTarget: mocks.target }))

import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { ORCAD_BUN_RELEASE_ASSETS } from '../../shared/orcad-bun-runtime'
import { ensureRemoteOpenCodeRuntime } from './ssh-relay-opencode-runtime'
import { OPENCODE_RUNTIME_RESULT } from './ssh-relay-opencode-runtime-commands'

const host = getRemoteHostPlatform('linux-x64')
const remoteHome = '/home/ada'
const relayDir = `${remoteHome}/.orca-remote/relay-build`
const binary = `${remoteHome}/.orca-remote/vault-sqlite/${ORCAD_BUN_RELEASE_ASSETS['linux-x64-glibc'].executableSha256}/bun`
let cacheRoot: string
let runtime: string
const frame = (status: string, executable?: string) =>
  `${OPENCODE_RUNTIME_RESULT}${JSON.stringify({ status, executable })}\n`
const options = () => ({ nodePath: '/usr/bin/node', relayDir, cacheRoot })

function connection(system = false): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exec and transfers are mocked; setup only reads this transport flag.
  return { usesSystemSshTransport: () => system } as unknown as SshConnection
}

beforeEach(async () => {
  vi.resetAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  cacheRoot = await mkdtemp(join(tmpdir(), 'orca-vault-runtime-'))
  runtime = join(cacheRoot, 'repair-1-orcad-bun')
  await writeFile(runtime, 'verified runtime')
  mocks.materialize.mockResolvedValue(runtime)
  mocks.target.mockResolvedValue('linux-x64-glibc')
  mocks.exec.mockImplementation(async (_conn, command: string) => {
    if (command.includes('SELECT 1 AS ready')) {
      return frame('unsupported')
    }
    if (command.includes('status:')) {
      if (command.includes('checksum mismatch')) {
        return frame('ready', binary)
      }
      if (command.includes('published')) {
        return frame('published')
      }
      return frame('staged')
    }
    return ''
  })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(cacheRoot, { recursive: true, force: true })
})

describe('SSH OpenCode runtime setup', () => {
  it('publishes a capable existing Node without materializing or uploading Bun', async () => {
    mocks.exec.mockResolvedValueOnce(frame('ready', '/opt/node 24/bin/node'))
    expect(await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())).toBe(true)
    expect(mocks.target).not.toHaveBeenCalled()
    expect(mocks.materialize).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(JSON.parse(mocks.write.mock.calls[0][3])).toEqual({
      protocol: 1,
      executable: '/opt/node 24/bin/node'
    })
  })

  it('uses the verified materializer cache after Node 18 fails the actual read probe', async () => {
    mocks.upload.mockImplementation(async (_conn, localDir: string) => {
      expect(await readdir(localDir)).toEqual(['bun'])
      expect(await readFile(join(localDir, 'bun'), 'utf8')).toBe('verified runtime')
    })
    expect(await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())).toBe(true)
    expect(mocks.target).toHaveBeenCalledWith(
      expect.objectContaining({ host, signal: expect.any(AbortSignal) })
    )
    expect(mocks.materialize).toHaveBeenCalledWith('linux-x64-glibc', cacheRoot, {
      signal: expect.any(AbortSignal)
    })
    expect(await readdir(cacheRoot)).toEqual(['repair-1-orcad-bun'])
    expect(JSON.parse(mocks.write.mock.calls[0][3])).toEqual({ protocol: 1, executable: binary })
  })

  it('reuses a remotely verified binary without downloading it again', async () => {
    mocks.exec
      .mockResolvedValueOnce(frame('unsupported'))
      .mockResolvedValueOnce(frame('ready', binary))
    expect(await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())).toBe(true)
    expect(mocks.materialize).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('uses one staging namespace for binary uploads and atomic reference writes', async () => {
    await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())
    const uploadOptions = mocks.upload.mock.calls[0][4]
    const writeOptions = mocks.write.mock.calls[0][4]
    expect(uploadOptions.sftpNamespace.homeRelativeNamespaceRoot).toMatch(
      /^\.orca-remote\/vault-sqlite\/\.upload-/
    )
    expect(uploadOptions.sftpNamespace.shellProbePath).toBe(
      writeOptions.sftpNamespace.shellProbePath
    )
    expect(writeOptions.sftpNamespace.homeRelativePath).toBe(
      `${uploadOptions.sftpNamespace.homeRelativePath}/opencode-sqlite-runtime.json`
    )
  })

  it('skips namespace probing on system SSH', async () => {
    await ensureRemoteOpenCodeRuntime(connection(true), host, remoteHome, options())
    expect(mocks.upload.mock.calls[0][4].sftpNamespace).toBeUndefined()
    expect(mocks.write.mock.calls[0][4].sftpNamespace).toBeUndefined()
  })

  it('coalesces repeated setup for one execution connection and directory', async () => {
    const conn = connection()
    const result = await Promise.all([
      ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options()),
      ensureRemoteOpenCodeRuntime(conn, host, remoteHome, options())
    ])
    expect(result).toEqual([true, true])
    expect(mocks.upload).toHaveBeenCalledOnce()
  })

  it('coalesces the bounded target cache fill across hosts', async () => {
    let finish!: (path: string) => void
    mocks.materialize.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve
      })
    )
    const first = ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())
    const second = ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())
    await vi.waitFor(() => expect(mocks.materialize).toHaveBeenCalledOnce())
    finish(runtime)
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(mocks.upload).toHaveBeenCalledTimes(2)
  })

  it('never publishes a reference after a failed remote checksum', async () => {
    mocks.exec.mockImplementation(async (_conn, command: string) => {
      if (command.includes('SELECT 1 AS ready')) {
        return frame('unsupported')
      }
      if (command.includes('checksum mismatch')) {
        throw new Error('Uploaded SQLite runtime checksum mismatch')
      }
      return frame('staged')
    })
    expect(await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())).toBe(false)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('aborts an upload without publishing or running further host commands', async () => {
    const controller = new AbortController()
    mocks.upload.mockImplementation(async (_conn, _local, _remote, _host, transfer) => {
      controller.abort()
      transfer.signal.throwIfAborted()
    })
    expect(
      await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, {
        ...options(),
        signal: controller.signal
      })
    ).toBe(false)
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.exec).toHaveBeenCalledTimes(2)
  })

  it('bounds even an unresponsive setup operation at 180 seconds', async () => {
    vi.useFakeTimers()
    mocks.exec.mockReturnValue(new Promise(() => {}))
    const result = ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())
    await vi.advanceTimersByTimeAsync(180_000)
    expect(await result).toBe(false)
    expect(mocks.exec.mock.calls[0][2].signal.aborted).toBe(true)
    expect(mocks.materialize).not.toHaveBeenCalled()
  })

  it('does not mistake an unanswered Node probe for an old runtime', async () => {
    mocks.exec.mockResolvedValue('login banner only')
    expect(await ensureRemoteOpenCodeRuntime(connection(), host, remoteHome, options())).toBe(false)
    expect(mocks.materialize).not.toHaveBeenCalled()
  })
})
