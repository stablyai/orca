import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgePageMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import {
  createMobileWebBrokerFixture,
  mobileWebBridgeRequestMessage
} from './mobile-web-bridge-roundtrip-fixture'
const PAGE_WORKSPACE_ID = `workspace_0_${'01'.repeat(16)}`
const PAGE_REPO_ID = `repo_1_${'01'.repeat(16)}`

describe('mobile web workspace operations', () => {
  it('uses opaque handles for repositories, settings, and workspace mutations', async () => {
    const harness = createHarness()
    await primeWorkspace(harness)

    await harness.broker.handle(request('B', 'workspace', 'repositories', {}))
    await harness.broker.handle(request('C', 'settings', 'snapshot', {}))
    await harness.broker.handle(
      request('D', 'settings', 'update', {
        sortBy: 'recent',
        filterRepoIds: [PAGE_REPO_ID]
      })
    )
    await harness.broker.handle(
      request('E', 'workspace', 'update', {
        mutation: 'pin',
        workspaceId: PAGE_WORKSPACE_ID,
        pinned: true
      })
    )
    await harness.broker.handle(
      request('F', 'workspace', 'update', {
        mutation: 'sleep',
        workspaceId: PAGE_WORKSPACE_ID
      })
    )
    await harness.broker.handle(
      request('G', 'workspace', 'remove', { workspaceId: PAGE_WORKSPACE_ID })
    )

    expect(successPayload(harness.messages, 'B')).toEqual({
      repositories: [
        {
          id: PAGE_REPO_ID,
          displayName: 'secret-repo',
          badgeColor: '#737373',
          repoIcon: { type: 'lucide', name: 'FolderGit2' }
        }
      ],
      truncated: false
    })
    expect(successPayload(harness.messages, 'C')).toEqual({
      settings: { sortBy: 'recent', filterRepoIds: [PAGE_REPO_ID] }
    })
    expect(harness.sendRequest).toHaveBeenCalledWith('ui.set', {
      sortBy: 'recent',
      filterRepoIds: ['host-repo-1']
    })
    expect(harness.sendRequest).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:host-workspace-1',
      isPinned: true
    })
    expect(harness.sendRequest).toHaveBeenCalledWith('worktree.sleep', {
      worktree: 'id:host-workspace-1'
    })
    expect(harness.sendRequest).toHaveBeenCalledWith('worktree.rm', {
      worktree: 'id:host-workspace-1',
      force: true
    })
    expect(JSON.stringify(harness.messages)).not.toContain('/host/private')
    expect(JSON.stringify(harness.messages)).not.toContain('host-workspace-1')
    expect(JSON.stringify(harness.messages)).not.toContain('host-repo-1')
  })

  it('sanitizes workspace invalidations and retires them on client replacement', async () => {
    const harness = createHarness()
    await harness.broker.handle(subscriptionRequest())

    harness.subscriptionListener?.({
      type: 'ready',
      subscriptionId: 'host-subscription-secret'
    })
    harness.subscriptionListener?.({ type: 'worktreesChanged', repoId: 'host-repo-secret' })
    await vi.waitFor(() => {
      expect(harness.messages.filter((message) => message.type === 'event')).toHaveLength(2)
    })

    expect(harness.messages.filter((message) => message.type === 'event')).toEqual([
      expect.objectContaining({ type: 'event', sequence: 0, payload: { type: 'ready' } }),
      expect.objectContaining({
        type: 'event',
        sequence: 1,
        payload: { type: 'worktreesChanged' }
      })
    ])
    expect(JSON.stringify(harness.messages)).not.toContain('host-subscription-secret')
    expect(JSON.stringify(harness.messages)).not.toContain('host-repo-secret')

    harness.broker.replaceClient(null)
    expect(harness.hostUnsubscribe).toHaveBeenCalledOnce()
  })
})

function createHarness() {
  let subscriptionListener: ((event: unknown) => void) | null = null
  const hostUnsubscribe = vi.fn()
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'worktree.ps') {
      return {
        ok: true,
        result: {
          worktrees: [
            {
              worktreeId: 'host-workspace-1',
              repoId: 'host-repo-1',
              displayName: 'Primary',
              repo: 'Orca',
              branch: 'main'
            }
          ]
        }
      }
    }
    if (method === 'repo.list') {
      return {
        ok: true,
        result: {
          repos: [
            {
              id: 'host-repo-1',
              displayName: '/host/private/secret-repo',
              badgeColor: '#737373',
              repoIcon: { type: 'lucide', name: 'FolderGit2' }
            }
          ]
        }
      }
    }
    if (method === 'ui.get') {
      return {
        ok: true,
        result: { ui: { sortBy: 'recent', filterRepoIds: ['host-repo-1'] } }
      }
    }
    return { ok: true, result: {} }
  })
  const client = {
    sendRequest,
    subscribe: vi.fn((_method, _params, listener) => {
      subscriptionListener = listener
      return hostUnsubscribe
    })
  } as unknown as RpcClient
  const { broker, messages } = createMobileWebBrokerFixture({ getClient: () => client })
  return {
    broker,
    messages,
    sendRequest,
    hostUnsubscribe,
    get subscriptionListener() {
      return subscriptionListener
    }
  }
}

async function primeWorkspace(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.broker.handle(request('A', 'workspace', 'snapshot', { limit: 10 }))
}

function request(
  id: string,
  capability: 'workspace' | 'settings',
  operation: string,
  payload: unknown
): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return mobileWebBridgeRequestMessage({
    requestId: id.repeat(22),
    capability,
    operation,
    payload
  })
}

function subscriptionRequest(): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return {
    ...request('H', 'workspace', 'subscribe', {}),
    mode: 'subscription',
    subscriptionId: 'I'.repeat(22)
  }
}

function successPayload(messages: readonly MobileWebBridgeShellMessage[], id: string): unknown {
  const message = messages.find(
    (candidate) =>
      candidate.type === 'response' &&
      candidate.requestId === id.repeat(22) &&
      candidate.status === 'success'
  )
  if (!message || message.type !== 'response' || message.status !== 'success') {
    throw new Error(`Missing response ${id}`)
  }
  return message.payload
}
