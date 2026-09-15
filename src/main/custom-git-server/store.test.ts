import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import type * as ServerConfigStore from './server-config-store'
import { join } from 'node:path'

const { homeHolder, secretStoreMock, verifyMock, writeConfigMock } = vi.hoisted(() => ({
  homeHolder: { path: '' },
  secretStoreMock: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, 'utf-8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf-8').replace(/^enc:/, '')),
    describeProtectionGap: vi.fn(() => null)
  },
  verifyMock: vi.fn(),
  // Wraps the real config writer so a single test can force a disk-write
  // failure and assert the token store stays consistent (rollback / no-orphan).
  writeConfigMock: vi.fn()
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => homeHolder.path }
})

vi.mock('./api-flavor', () => ({
  getCustomGitServerFlavorClient: () => ({ verify: verifyMock })
}))

vi.mock('./server-config-store', async (importOriginal) => {
  const actual = await importOriginal<typeof ServerConfigStore>()
  return {
    ...actual,
    writeCustomGitServerConfig: (
      servers: Parameters<typeof actual.writeCustomGitServerConfig>[0]
    ) => writeConfigMock(servers, actual.writeCustomGitServerConfig)
  }
})

import { setSecretStore } from '../../shared/secret-store'
import {
  getCustomGitServerById,
  getCustomGitServerForHost,
  getCustomGitServerStatuses,
  getCustomGitServerToken,
  listCustomGitServers,
  removeCustomGitServer,
  saveCustomGitServer,
  testCustomGitServerConnection,
  _resetCustomGitServerStore
} from './store'

const draft = {
  name: 'My Git Server',
  host: 'git.example.com',
  apiBaseUrl: 'https://git.example.com',
  apiFlavor: 'gitlab' as const,
  token: 'secret-token'
}

describe('custom git server store', () => {
  beforeEach(() => {
    homeHolder.path = mkdtempSync(join(tmpdir(), 'orca-cgs-'))
    setSecretStore(secretStoreMock)
    _resetCustomGitServerStore()
    verifyMock.mockReset()
    // Default: call through to the real writer so a failing test opts in explicitly.
    writeConfigMock.mockReset()
    writeConfigMock.mockImplementation((servers, actual) => actual(servers))
    secretStoreMock.isEncryptionAvailable.mockReturnValue(true)
  })

  afterEach(() => {
    rmSync(homeHolder.path, { recursive: true, force: true })
  })

  it('saves, lists, and resolves a server by host', () => {
    const server = saveCustomGitServer(draft)
    expect(server.host).toBe('git.example.com')
    expect(listCustomGitServers()).toHaveLength(1)
    expect(getCustomGitServerForHost('git@git.example.com:team/repo.git')?.id).toBe(server.id)
    expect(getCustomGitServerToken(server.id)).toBe('secret-token')
  })

  it('persists across a cache reset (reads back from disk)', () => {
    const server = saveCustomGitServer(draft)
    _resetCustomGitServerStore()
    expect(listCustomGitServers().map((s) => s.id)).toEqual([server.id])
    expect(getCustomGitServerToken(server.id)).toBe('secret-token')
  })

  it('keeps the existing token when updating without one', () => {
    const server = saveCustomGitServer(draft)
    saveCustomGitServer({ id: server.id, ...draft, name: 'Renamed', token: '' })
    expect(getCustomGitServerToken(server.id)).toBe('secret-token')
    expect(getCustomGitServerById(server.id)?.name).toBe('Renamed')
  })

  it('removes a server and its token', () => {
    const server = saveCustomGitServer(draft)
    removeCustomGitServer(server.id)
    expect(listCustomGitServers()).toHaveLength(0)
    expect(getCustomGitServerToken(server.id)).toBeNull()
  })

  it('rolls the new token back when the config write fails on first save', () => {
    writeConfigMock.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => saveCustomGitServer(draft)).toThrow('disk full')
    // Config never committed, so the token must not linger for a phantom server.
    const id = listCustomGitServers()[0]?.id
    expect(id).toBeUndefined()
    _resetCustomGitServerStore()
    expect(listCustomGitServers()).toHaveLength(0)
  })

  it('restores the prior token when the config write fails on update', () => {
    const server = saveCustomGitServer(draft)
    writeConfigMock.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => saveCustomGitServer({ id: server.id, ...draft, token: 'rotated-token' })).toThrow(
      'disk full'
    )
    // The failed rotation must leave the previously stored token intact.
    expect(getCustomGitServerToken(server.id)).toBe('secret-token')
  })

  it('keeps the token when the config write fails during removal', () => {
    const server = saveCustomGitServer(draft)
    writeConfigMock.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => removeCustomGitServer(server.id)).toThrow('disk full')
    // Config write is the source of truth: a failed removal leaves both stores.
    expect(listCustomGitServers().map((s) => s.id)).toEqual([server.id])
    expect(getCustomGitServerToken(server.id)).toBe('secret-token')
  })

  it('reports authenticated status when the flavor verify succeeds', async () => {
    verifyMock.mockResolvedValue({ account: 'fanyunqian' })
    saveCustomGitServer(draft)
    const [status] = await getCustomGitServerStatuses()
    expect(status).toMatchObject({
      host: 'git.example.com',
      configured: true,
      authenticated: true,
      account: 'fanyunqian'
    })
  })

  it('reports not-authenticated when verify returns null', async () => {
    verifyMock.mockResolvedValue(null)
    saveCustomGitServer(draft)
    const [status] = await getCustomGitServerStatuses()
    expect(status).toMatchObject({ configured: true, authenticated: false, account: null })
  })

  it('tests a draft connection without persisting', async () => {
    verifyMock.mockResolvedValue({ account: 'me' })
    const result = await testCustomGitServerConnection(draft)
    expect(result).toEqual({ ok: true, account: 'me' })
    expect(listCustomGitServers()).toHaveLength(0)
  })

  it('rejects a draft test with no token', async () => {
    const result = await testCustomGitServerConnection({ ...draft, token: '' })
    expect(result.ok).toBe(false)
  })

  it('caches a successful verify within the TTL and refreshes after it expires', async () => {
    vi.useFakeTimers()
    try {
      verifyMock.mockResolvedValue({ account: 'fanyunqian' })
      saveCustomGitServer(draft)

      await getCustomGitServerStatuses()
      await getCustomGitServerStatuses()
      expect(verifyMock).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(30_000 + 1)
      await getCustomGitServerStatuses()
      expect(verifyMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not cache a failed verify so a transient outage self-heals next tick', async () => {
    verifyMock.mockResolvedValueOnce(null).mockResolvedValue({ account: 'fanyunqian' })
    saveCustomGitServer(draft)

    const [first] = await getCustomGitServerStatuses()
    expect(first).toMatchObject({ authenticated: false })
    const [second] = await getCustomGitServerStatuses()
    expect(second).toMatchObject({ authenticated: true, account: 'fanyunqian' })
    expect(verifyMock).toHaveBeenCalledTimes(2)
  })

  it('invalidates the cached verify when the server is re-saved', async () => {
    vi.useFakeTimers()
    try {
      verifyMock.mockResolvedValue({ account: 'fanyunqian' })
      saveCustomGitServer(draft)
      await getCustomGitServerStatuses()
      expect(verifyMock).toHaveBeenCalledTimes(1)

      saveCustomGitServer(draft)
      await getCustomGitServerStatuses()
      expect(verifyMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares one in-flight verify across concurrent status polls', async () => {
    let resolveVerify: (value: { account: string }) => void = () => {}
    verifyMock.mockReturnValue(
      new Promise<{ account: string }>((resolve) => {
        resolveVerify = resolve
      })
    )
    saveCustomGitServer(draft)

    // Two concurrent polls before the first verify settles must share it, not
    // each fire their own request at the configured host.
    const first = getCustomGitServerStatuses()
    const second = getCustomGitServerStatuses()
    expect(verifyMock).toHaveBeenCalledTimes(1)

    resolveVerify({ account: 'fanyunqian' })
    const [[firstStatus], [secondStatus]] = await Promise.all([first, second])
    expect(firstStatus).toMatchObject({ authenticated: true, account: 'fanyunqian' })
    expect(secondStatus).toMatchObject({ authenticated: true, account: 'fanyunqian' })
    expect(verifyMock).toHaveBeenCalledTimes(1)
  })
})
