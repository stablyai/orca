import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadHosts } from '../../host-catalog/host-store'
import type { HostProfile } from '../../host-catalog/host-profile'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { answerWatchPrompt } from './watch-prompt-host'
import type { PendingWatchPrompt } from './watch-prompt-action'

vi.mock('../../host-catalog/host-store', () => ({ loadHosts: vi.fn() }))

const pending: PendingWatchPrompt = {
  hostId: 'host-1',
  worktreeId: 'folder:/work',
  paneKey: 'tab:leaf',
  action: 'deny',
  reply: { allow: 'y', deny: 'n' }
}

const host: HostProfile = {
  id: 'host-1',
  name: 'Host',
  endpoint: 'ws://127.0.0.1',
  deviceToken: 'token',
  publicKeyB64: 'aa',
  lastConnected: 0
}

beforeEach(() => {
  vi.mocked(loadHosts).mockReset()
})

describe('answerWatchPrompt', () => {
  it('reports stale and does not open a connection when the host is gone', async () => {
    vi.mocked(loadHosts).mockResolvedValue([])
    const acquire = vi.fn()
    const outcome = await answerWatchPrompt(
      {
        acquire,
        release: vi.fn(),
        subscribeHostState: vi.fn(),
        getAllClients: () => []
      },
      pending
    )
    expect(outcome).toBe('stale')
    expect(acquire).not.toHaveBeenCalled()
  })

  it('waits for the host connection and then releases it', async () => {
    vi.mocked(loadHosts).mockResolvedValue([host])
    const listeners: ((state: ConnectionState) => void)[] = []
    let ready = false
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'terminal.resolvePane') {
        return { id: '1', ok: true, result: { terminal: { handle: 'pty-1' } } }
      }
      if (method === 'terminal.agentStatus') {
        return {
          id: '2',
          ok: true,
          result: {
            agentStatus: { handle: 'pty-1', isRunningAgent: true, status: 'permission' }
          }
        }
      }
      return { id: '3', ok: true, result: { send: { accepted: true } } }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this reply path calls only sendRequest.
    const client = { sendRequest } as unknown as RpcClient
    const release = vi.fn()
    const outcomePromise = answerWatchPrompt(
      {
        acquire: () => null,
        release,
        subscribeHostState: (_hostId, next) => {
          listeners.push(next)
          return () => {}
        },
        // Stay empty until the subscription fires, so the reply waits on that callback.
        getAllClients: () => (ready ? [{ hostId: 'host-1', client }] : [])
      },
      pending
    )
    await vi.waitFor(() => {
      if (listeners.length === 0) {
        throw new Error('listener missing')
      }
    })
    ready = true
    const notify = listeners[0]
    if (notify === undefined) {
      throw new Error('listener missing')
    }
    notify('connected')
    await expect(outcomePromise).resolves.toBe('accepted')
    expect(sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ terminal: 'pty-1', text: 'n', enter: false }),
      expect.anything()
    )
    expect(release).toHaveBeenCalledOnce()
  })
})
