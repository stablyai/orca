import { describe, expect, it, vi } from 'vitest'
import { HerdrDaemonSshStore } from './herdr-daemon-ssh-store'
import type { SshConnection } from '../../../ssh/ssh-connection'
import type { SshConnectionState } from '../../../../shared/ssh-types'

// Why: the SSH store manages connection lifecycle for the daemon. Real SSH
// needs a server, so this test injects a mock createConnection that returns
// a stub SshConnection and verifies connect/disconnect/get/disconnectAll.
function makeMockConnection(): SshConnection & { connectCalls: number; disconnectCalls: number } {
  const stub = {
    connectCalls: 0,
    disconnectCalls: 0,
    async connect(): Promise<void> {
      stub.connectCalls++
    },
    async disconnect(): Promise<void> {
      stub.disconnectCalls++
    },
    getState(): SshConnectionState {
      return {
        targetId: 't',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        supportsFolderDownload: false
      }
    }
  }
  return stub as unknown as SshConnection & { connectCalls: number; disconnectCalls: number }
}

describe('herdr daemon ssh store', () => {
  it('connects, stores, and disconnects a connection', async () => {
    const mock = makeMockConnection()
    const store = new HerdrDaemonSshStore(() => mock)

    const result = await store.connect({ host: 'example.com', username: 'user' })
    expect(result.connectionId).toBe('ssh-1')
    expect(mock.connectCalls).toBe(1)
    expect(store.get(result.connectionId)).toBeDefined()

    await store.disconnect(result.connectionId)
    expect(mock.disconnectCalls).toBe(1)
    expect(store.get(result.connectionId)).toBeUndefined()
  })

  it('rejects disconnect for an unknown connection', async () => {
    const store = new HerdrDaemonSshStore(() => makeMockConnection())
    await expect(store.disconnect('nope')).rejects.toMatchObject({
      code: 'ssh_not_found'
    })
  })

  it('disconnects all connections', async () => {
    const mocks = [makeMockConnection(), makeMockConnection()]
    let i = 0
    const store = new HerdrDaemonSshStore(() => mocks[i++])

    const a = await store.connect({ host: 'a' })
    const b = await store.connect({ host: 'b' })
    await store.disconnectAll()

    expect(mocks[0].disconnectCalls).toBe(1)
    expect(mocks[1].disconnectCalls).toBe(1)
    expect(store.get(a.connectionId)).toBeUndefined()
    expect(store.get(b.connectionId)).toBeUndefined()
  })

  it('passes connect params through to the connection factory', async () => {
    const factory = vi.fn(() => makeMockConnection())
    const store = new HerdrDaemonSshStore(factory)

    await store.connect({
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      identityFile: '/key',
      configHost: 'prod'
    })
    expect(factory).toHaveBeenCalledWith(
      'ssh-1',
      expect.objectContaining({
        host: 'example.com',
        port: 2222,
        username: 'deploy',
        identityFile: '/key',
        configHost: 'prod'
      }),
      expect.any(Function)
    )
  })
})
