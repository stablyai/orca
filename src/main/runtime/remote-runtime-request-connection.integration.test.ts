import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { getDefaultRepoHookSettings } from '../../shared/constants'
import type { Repo } from '../../shared/types'
import { parsePairingCode } from '../../shared/pairing'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import { subscribeRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import type {
  RuntimeClientEvent,
  RuntimeClientEventStreamMessage
} from '../../shared/runtime-client-events'
import type { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

describe('remote runtime request connection integration', () => {
  it('fetches repos through the real E2EE WebSocket runtime', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-request-'))
    const repoPath = join(userDataPath, 'repo')
    const repos: Repo[] = [
      {
        id: 'repo-1',
        path: repoPath,
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        hookSettings: getDefaultRepoHookSettings(),
        worktreeBaseRef: 'main',
        kind: 'git'
      }
    ]
    const runtime = {
      getRuntimeId: () => 'runtime-test',
      getStartedAt: () => 1,
      cleanupSubscriptionsForConnection: () => {},
      cancelMobileDictationForConnection: () => {},
      onClientDisconnected: () => {},
      listRepos: () => repos
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      const offer = server.createPairingOffer({ name: 'integration', scope: 'runtime' })
      if (!offer.available) {
        throw new Error('pairing unavailable')
      }
      const pairing = parsePairingCode(offer.pairingUrl)
      if (!pairing) {
        throw new Error('invalid pairing')
      }
      const connection = new RemoteRuntimeRequestConnection(pairing)
      try {
        await expect(connection.request('repo.list', undefined, 1000)).resolves.toMatchObject({
          ok: true,
          result: { repos }
        })
      } finally {
        connection.close()
      }
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('streams server worktree changes to another remote client', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-request-events-'))
    const repoPath = join(userDataPath, 'repo')
    const repo: Repo = {
      id: 'repo-1',
      path: repoPath,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      hookSettings: getDefaultRepoHookSettings(),
      worktreeBaseRef: 'main',
      kind: 'git'
    }
    const worktrees: unknown[] = [
      {
        id: 'repo-1::main',
        repoId: repo.id,
        path: repoPath,
        branch: 'main',
        displayName: 'repo',
        isMainWorktree: true
      }
    ]
    const clientEventListeners = new Set<(event: RuntimeClientEvent) => void>()
    const subscriptionCleanups = new Map<string, () => void>()
    const runtime = {
      getRuntimeId: () => 'runtime-test',
      getStartedAt: () => 1,
      cleanupSubscriptionsForConnection: (connectionId: string) => {
        for (const [id, cleanup] of subscriptionCleanups) {
          if (id.includes(connectionId)) {
            cleanup()
            subscriptionCleanups.delete(id)
          }
        }
      },
      registerSubscriptionCleanup: (id: string, cleanup: () => void) => {
        subscriptionCleanups.set(id, cleanup)
      },
      cleanupSubscription: (id: string) => {
        subscriptionCleanups.get(id)?.()
        subscriptionCleanups.delete(id)
      },
      cancelMobileDictationForConnection: () => {},
      onClientDisconnected: () => {},
      onClientEvent: (listener: (event: RuntimeClientEvent) => void) => {
        clientEventListeners.add(listener)
        return () => clientEventListeners.delete(listener)
      },
      listDetectedManagedWorktrees: () => ({
        repoId: repo.id,
        authoritative: true,
        source: 'git',
        worktrees
      }),
      createManagedWorktree: ({ name }: { name?: string }) => {
        const worktree = {
          id: `repo-1::${name || 'created'}`,
          repoId: repo.id,
          path: join(userDataPath, name || 'created'),
          branch: name || 'created',
          displayName: name || 'created',
          isMainWorktree: false
        }
        worktrees.push(worktree)
        for (const listener of clientEventListeners) {
          listener({ type: 'worktreesChanged', repoId: repo.id })
        }
        return { worktree }
      }
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      const offer = server.createPairingOffer({ name: 'integration', scope: 'runtime' })
      if (!offer.available) {
        throw new Error('pairing unavailable')
      }
      const pairing = parsePairingCode(offer.pairingUrl)
      if (!pairing) {
        throw new Error('invalid pairing')
      }

      const events: RuntimeClientEventStreamMessage[] = []
      const subscription = await subscribeRemoteRuntimeRequest<RuntimeClientEventStreamMessage>(
        pairing,
        'runtime.clientEvents.subscribe',
        undefined,
        1000,
        {
          onResponse: (response) => {
            if (response.ok) {
              events.push(response.result)
            }
          },
          onError: (error) => {
            throw error
          }
        }
      )
      const desktop = new RemoteRuntimeRequestConnection(pairing)
      const mobile = new RemoteRuntimeRequestConnection(pairing)
      try {
        await waitFor(() => events.some((event) => event.type === 'ready'))

        await expect(
          desktop.request<{ worktrees: unknown[] }>(
            'worktree.detectedList',
            { repo: repo.id },
            1000
          )
        ).resolves.toMatchObject({
          ok: true,
          result: { worktrees: [{ id: 'repo-1::main' }] }
        })

        await expect(
          mobile.request('worktree.create', { repo: repo.id, name: 'mobile-created' }, 1000)
        ).resolves.toMatchObject({
          ok: true,
          result: { worktree: { id: 'repo-1::mobile-created' } }
        })

        await waitFor(() =>
          events.some((event) => event.type === 'worktreesChanged' && event.repoId === repo.id)
        )
        await expect(
          desktop.request<{ worktrees: unknown[] }>(
            'worktree.detectedList',
            { repo: repo.id },
            1000
          )
        ).resolves.toMatchObject({
          ok: true,
          result: {
            worktrees: [{ id: 'repo-1::main' }, { id: 'repo-1::mobile-created' }]
          }
        })
      } finally {
        subscription.close()
        desktop.close()
        mobile.close()
      }
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}
