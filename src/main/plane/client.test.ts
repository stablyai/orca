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
  credentialFileHasContent: (buffer: Buffer | undefined) => Boolean(buffer?.length),
  readStoredCredentialToken: (_service: string, buffer: Buffer) => buffer.toString('utf8'),
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
})
