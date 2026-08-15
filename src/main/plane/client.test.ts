import { beforeEach, describe, expect, it, vi } from 'vitest'

const instanceFile = vi.hoisted(() => ({ value: '' }))
const tokenFiles = vi.hoisted(() => new Map<string, Buffer>())

vi.mock('./storage-paths', () => ({
  getOrcaDir: () => '/tmp/orca-plane-test',
  getInstanceFilePath: () => '/tmp/orca-plane-test/plane-instances.json',
  getInstanceTokenDir: () => '/tmp/orca-plane-test/plane-tokens',
  getInstanceTokenPath: (instanceId: string) =>
    `/tmp/orca-plane-test/plane-tokens/${instanceId}.enc`
}))

vi.mock('node:fs', () => ({
  existsSync: (path: string) =>
    path === '/tmp/orca-plane-test/plane-instances.json' || tokenFiles.has(path),
  mkdirSync: vi.fn(),
  readFileSync: (path: string) =>
    path === '/tmp/orca-plane-test/plane-instances.json'
      ? instanceFile.value
      : tokenFiles.get(path),
  unlinkSync: (path: string) => {
    tokenFiles.delete(path)
  },
  openSync: (path: string) => {
    tokenFiles.set(path, Buffer.alloc(0))
    return path
  },
  writeSync: (path: string, data: Buffer, offset: number, length: number) => {
    const current = tokenFiles.get(path) ?? Buffer.alloc(0)
    tokenFiles.set(path, Buffer.concat([current, data.subarray(offset, offset + length)]))
    return length
  },
  fsyncSync: vi.fn(),
  closeSync: vi.fn(),
  renameSync: (from: string, to: string) => {
    const data = tokenFiles.get(from) ?? Buffer.alloc(0)
    tokenFiles.delete(from)
    if (to === '/tmp/orca-plane-test/plane-instances.json') {
      instanceFile.value = data.toString('utf8')
      return
    }
    tokenFiles.set(to, data)
  },
  chmodSync: vi.fn(),
  statSync: (path: string) => ({ size: tokenFiles.get(path)?.length ?? 0 }),
  writeFileSync: (path: string, data: string | Buffer) => {
    if (path === '/tmp/orca-plane-test/plane-instances.json') {
      instanceFile.value = String(data)
      return
    }
    tokenFiles.set(path, Buffer.isBuffer(data) ? data : Buffer.from(data))
  }
}))

vi.mock('../integration-credential-file', () => ({
  CredentialDecryptionError: class CredentialDecryptionError extends Error {},
  credentialFileHasContent: (path: string) => Boolean(tokenFiles.get(path)?.length),
  readStoredCredentialToken: (_service: string, buffer: Buffer) => buffer.toString('utf8'),
  writeCredentialFileAtomic: (path: string, data: Buffer) => {
    if (path === '/tmp/orca-plane-test/plane-instances.json') {
      instanceFile.value = data.toString('utf8')
      return
    }
    tokenFiles.set(path, data)
  },
  writeEncryptedCredential: (_service: string, path: string, token: string) =>
    tokenFiles.set(path, Buffer.from(token))
}))

describe('Plane client storage', () => {
  beforeEach(() => {
    vi.resetModules()
    tokenFiles.clear()
    instanceFile.value = JSON.stringify({
      version: 1,
      activeInstanceId: 'plane-1',
      selectedInstanceId: 'plane-2',
      instances: [
        { id: 'plane-1', baseUrl: 'https://plane.one', workspaceSlug: 'one', displayName: 'One' },
        { id: 'plane-2', baseUrl: 'https://plane.two', workspaceSlug: 'two', displayName: 'Two' }
      ]
    })
    tokenFiles.set('/tmp/orca-plane-test/plane-tokens/plane-1.enc', Buffer.from('token-1'))
    tokenFiles.set('/tmp/orca-plane-test/plane-tokens/plane-2.enc', Buffer.from('token-2'))
  })

  it('persists selected instance fallback after disconnecting the selected instance', async () => {
    const { disconnect, getClient, getStatus } = await import('./client')

    disconnect('plane-2')

    expect(getStatus()).toMatchObject({
      activeInstanceId: 'plane-1',
      selectedInstanceId: 'plane-1'
    })
    expect(getClient().instance.id).toBe('plane-1')
    expect(JSON.parse(instanceFile.value)).toMatchObject({
      activeInstanceId: 'plane-1',
      selectedInstanceId: 'plane-1',
      instances: [{ id: 'plane-1' }]
    })
  })

  it('returns bearer clients for stored OAuth instances', async () => {
    instanceFile.value = JSON.stringify({
      version: 1,
      activeInstanceId: 'plane-oauth',
      selectedInstanceId: 'plane-oauth',
      instances: [
        {
          id: 'plane-oauth',
          baseUrl: 'https://plane.example',
          workspaceSlug: 'acme',
          displayName: 'Acme',
          authMode: 'oauth'
        }
      ]
    })
    tokenFiles.clear()
    tokenFiles.set(
      '/tmp/orca-plane-test/plane-tokens/plane-oauth.enc',
      Buffer.from(JSON.stringify({ accessToken: 'oauth-token' }))
    )
    const { getClient } = await import('./client')

    expect(() => getClient()).toThrow('Plane OAuth client credentials are missing')
  })

  it('returns bearer clients with stored OAuth refresh metadata', async () => {
    instanceFile.value = JSON.stringify({
      version: 1,
      activeInstanceId: 'plane-oauth',
      selectedInstanceId: 'plane-oauth',
      instances: [
        {
          id: 'plane-oauth',
          baseUrl: 'https://plane.example',
          workspaceSlug: 'acme',
          displayName: 'Acme',
          authMode: 'oauth'
        }
      ]
    })
    tokenFiles.clear()
    tokenFiles.set(
      '/tmp/orca-plane-test/plane-tokens/plane-oauth.enc',
      Buffer.from(
        JSON.stringify({
          accessToken: 'oauth-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 60_000,
          clientId: 'client-id',
          clientSecret: 'client-secret'
        })
      )
    )
    const { getClient } = await import('./client')

    expect(getClient().auth).toMatchObject({
      kind: 'oauth',
      accessToken: 'oauth-token',
      refreshToken: 'refresh-token',
      clientId: 'client-id',
      clientSecret: 'client-secret'
    })
  })
})
