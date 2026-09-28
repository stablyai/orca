import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { RELAY_DEPLOY_TIMEOUT_MS } from './ssh-relay-deploy-timing'
import { ensureRemoteRelayBunRuntime } from './ssh-relay-bun-runtime'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  upload: vi.fn(),
  materialize: vi.fn(),
  target: vi.fn(),
  generation: 1
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: mocks.exec,
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    'sshChannelCloseConfirmed' in error &&
    error.sshChannelCloseConfirmed === false
}))
vi.mock('./ssh-relay-install-transfers', () => ({ uploadRelayDirectory: mocks.upload }))
vi.mock('./orcad-bun-runtime-materializer', () => ({
  materializeCachedOrcadBunRuntime: mocks.materialize
}))
vi.mock('./orcad-deployment-target', () => ({ resolveOrcadDeploymentTarget: mocks.target }))
const host = getRemoteHostPlatform('linux-x64')
const executable = '/home/test/.orca-remote/runtimes/hash/bun'
let cacheRoot: string
function connection(): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Remote I/O is mocked; the installer only reads these two transport methods.
  return {
    getConnectGeneration: () => mocks.generation,
    usesSystemSshTransport: () => false
  } as unknown as SshConnection
}
beforeEach(async () => {
  vi.resetAllMocks()
  mocks.generation = 1
  cacheRoot = await mkdtemp(join(tmpdir(), 'orca-relay-runtime-'))
  const binary = join(cacheRoot, 'bun')
  await writeFile(binary, 'verified runtime')
  mocks.materialize.mockResolvedValue(binary)
  mocks.target.mockResolvedValue('linux-x64-glibc')
  mocks.exec.mockImplementation(async (_conn, command: string) => {
    if (command.includes('staging quota is full')) {
      return `__ORCA_UPLOAD_STAGE_SLOT__${command.match(/\.sftp-namespace-[0-9a-f]{32}/)?.[0]}:slot-0`
    }
    if (command.includes('Uploaded Bun runtime checksum mismatch')) {
      return `__ORCA_BUN_READY__\n${executable}\n`
    }
    if (command.includes('__ORCA_BUN_MISSING__')) {
      return '__ORCA_BUN_MISSING__\n'
    }
    return ''
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await rm(cacheRoot, { recursive: true, force: true })
})
const cleanupCalls = () =>
  mocks.exec.mock.calls.filter(
    ([, command]) => command.includes('claim_identity') && !command.includes('old=')
  )

describe('required relay Bun installation', () => {
  it('reuses a verified executable without uploading or requiring host Node', async () => {
    mocks.exec.mockResolvedValueOnce(`__ORCA_BUN_READY__\n${executable}\n`)
    expect(await ensureRemoteRelayBunRuntime(connection(), host, '/home/test', { cacheRoot })).toBe(
      executable
    )
    expect(mocks.materialize).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('uploads through an owned stage and returns the confirmed executable', async () => {
    mocks.upload.mockImplementation(async (_conn, localDir: string) => {
      expect(await readFile(join(localDir, 'bun'), 'utf8')).toBe('verified runtime')
    })
    expect(await ensureRemoteRelayBunRuntime(connection(), host, '/home/test', { cacheRoot })).toBe(
      executable
    )
    expect(mocks.upload).toHaveBeenCalledOnce()
    expect(cleanupCalls()).toHaveLength(1)
  })
  it('allows a progressing upload beyond three minutes within the deployment budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error('installation deadline')), delay)
      return controller.signal
    })
    mocks.upload.mockImplementationOnce(async (_conn, _local, _remote, _host, options) => {
      await vi.advanceTimersByTimeAsync(181_000)
      options.signal.throwIfAborted()
    })
    expect(await ensureRemoteRelayBunRuntime(connection(), host, '/home/test', { cacheRoot })).toBe(
      executable
    )
    expect(cleanupCalls()).toHaveLength(1)
  })
  it('bounds standalone installation and never promotes after its deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error('installation deadline')), delay)
      return controller.signal
    })
    mocks.upload.mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(RELAY_DEPLOY_TIMEOUT_MS)
    })
    await expect(
      ensureRemoteRelayBunRuntime(connection(), host, '/home/test', { cacheRoot })
    ).rejects.toThrow('installation deadline')
    expect(
      mocks.exec.mock.calls.some(([, command]) =>
        command.includes('Uploaded Bun runtime checksum mismatch')
      )
    ).toBe(false)
    expect(cleanupCalls()).toHaveLength(0)
  })
  it('honors deployment cancellation before publishing an uploaded runtime', async () => {
    const controller = new AbortController()
    mocks.upload.mockImplementationOnce(async () => {
      controller.abort(new Error('deployment cancelled'))
    })
    await expect(
      ensureRemoteRelayBunRuntime(connection(), host, '/home/test', {
        cacheRoot,
        signal: controller.signal
      })
    ).rejects.toThrow('deployment cancelled')
    expect(
      mocks.exec.mock.calls.some(([, command]) =>
        command.includes('Uploaded Bun runtime checksum mismatch')
      )
    ).toBe(false)
    expect(cleanupCalls()).toHaveLength(0)
  })
  it('releases the remote reservation if local upload staging fails', async () => {
    mocks.materialize.mockResolvedValueOnce(join(cacheRoot, 'missing-directory', 'bun'))
    await expect(
      ensureRemoteRelayBunRuntime(connection(), host, '/home/test', { cacheRoot })
    ).rejects.toThrow()
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(cleanupCalls()).toHaveLength(1)
  })
  it('retains a stage when upload termination is unconfirmed', async () => {
    const error = Object.assign(new Error('upload uncertain'), { sshChannelCloseConfirmed: false })
    mocks.upload.mockRejectedValueOnce(error)
    await expect(
      ensureRemoteRelayBunRuntime(connection(), host, '/home/test', { cacheRoot })
    ).rejects.toBe(error)
    expect(cleanupCalls()).toHaveLength(0)
  })
  it('does not promote or clean up through a reconnected transport', async () => {
    mocks.upload.mockImplementationOnce(async () => {
      mocks.generation++
    })
    await expect(
      ensureRemoteRelayBunRuntime(connection(), host, '/home/test', { cacheRoot })
    ).rejects.toThrow('SSH connection changed')
    expect(
      mocks.exec.mock.calls.some(([, command]) =>
        command.includes('Uploaded Bun runtime checksum mismatch')
      )
    ).toBe(false)
    expect(cleanupCalls()).toHaveLength(0)
  })
})
