import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getDefaultRepoHookSettings } from '../../shared/constants'
import type { Repo } from '../../shared/types'
import { parsePairingCode } from '../../shared/pairing'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import { RemoteRuntimeSharedControlConnection } from '../../shared/remote-runtime-shared-control-connection'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from '../../shared/remote-runtime-client'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../shared/terminal-stream-protocol'
import type {
  RuntimeClientEvent,
  RuntimeClientEventStreamMessage
} from '../../shared/runtime-client-events'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../shared/protocol-version'

const REMOTE_RUNTIME_TEST_TIMEOUT_MS = 15_000
const REMOTE_RUNTIME_REQUEST_TIMEOUT_MS = 5_000

// worktree.create routes through the runtime's clientMutationId idempotency
// wrapper; these stubs run the create straight through (no dedupe).
const passthroughDedupe = <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
  run()

describe('remote runtime request connection integration', () => {
  it(
    'fetches repos through the real E2EE WebSocket runtime',
    { timeout: REMOTE_RUNTIME_TEST_TIMEOUT_MS },
    async () => {
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
        getRuntimeId: () => 'fetch-runtime-test',
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
          await expect(
            connection.request('repo.list', undefined, REMOTE_RUNTIME_REQUEST_TIMEOUT_MS)
          ).resolves.toMatchObject({
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
    }
  )

  it(
    'streams server worktree changes to another remote client',
    { timeout: REMOTE_RUNTIME_TEST_TIMEOUT_MS },
    async () => {
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
        getRuntimeId: () => 'events-runtime-test',
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
        showRepo: (selector: string) => {
          if (selector !== repo.id && selector !== `id:${repo.id}`) {
            throw new Error('repo_not_found')
          }
          return repo
        },
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
        dedupeWorktreeCreate: passthroughDedupe,
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
          REMOTE_RUNTIME_REQUEST_TIMEOUT_MS,
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
              REMOTE_RUNTIME_REQUEST_TIMEOUT_MS
            )
          ).resolves.toMatchObject({
            ok: true,
            result: { worktrees: [{ id: 'repo-1::main' }] }
          })

          await expect(
            mobile.request(
              'worktree.create',
              { repo: repo.id, name: 'mobile-created' },
              REMOTE_RUNTIME_REQUEST_TIMEOUT_MS
            )
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
              REMOTE_RUNTIME_REQUEST_TIMEOUT_MS
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
    }
  )

  it(
    'transfers terminal viewport ownership across real paired desktop connections',
    { timeout: REMOTE_RUNTIME_TEST_TIMEOUT_MS },
    async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-pty-owner-'))
      const worktreeId = 'repo-1::/tmp/worktree-a'
      const ptySizes = new Map([['pty-1', { cols: 150, rows: 40 }]])
      const runtime = new OrcaRuntimeService()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        getSize: (ptyId) => ptySizes.get(ptyId) ?? null,
        resize: (ptyId, cols, rows) => {
          ptySizes.set(ptyId, { cols, rows })
          return true
        }
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId,
            title: 'Agent',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-1',
            worktreeId,
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-1',
            paneTitle: null
          }
        ]
      })
      const terminal = (await runtime.listTerminals(`id:${worktreeId}`)).terminals[0]?.handle
      if (!terminal) {
        throw new Error('terminal unavailable')
      }
      const server = new OrcaRuntimeRpcServer({
        runtime,
        userDataPath,
        enableWebSocket: true,
        wsPort: 0
      })

      await server.start()
      const subscriptions: RemoteRuntimeSubscription[] = []
      try {
        const openDesktop = async (name: string) => {
          const offer = server.createPairingOffer({ name, scope: 'runtime' })
          if (!offer.available) {
            throw new Error('pairing unavailable')
          }
          const pairing = parsePairingCode(offer.pairingUrl)
          if (!pairing) {
            throw new Error('invalid pairing')
          }
          const events: { type?: string; streamId?: number }[] = []
          const subscription = await subscribeRemoteRuntimeRequest(
            pairing,
            'terminal.multiplex',
            {},
            REMOTE_RUNTIME_REQUEST_TIMEOUT_MS,
            {
              onResponse: (response) => {
                if (response.ok) {
                  events.push(response.result as { type?: string; streamId?: number })
                }
              },
              onError: (error) => {
                throw error
              }
            }
          )
          subscriptions.push(subscription)
          await waitFor(() => events.some((event) => event.type === 'ready'))
          return { events, subscription }
        }
        const subscribeDesktop = async (
          desktop: Awaited<ReturnType<typeof openDesktop>>,
          clientId: string,
          cols: number,
          rows: number
        ) => {
          sendTerminalMultiplexJsonFrame(desktop.subscription, {
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: {
              streamId: 1,
              terminal,
              client: { id: clientId, type: 'desktop' },
              viewport: { cols, rows },
              claimViewport: true,
              capabilities: { ackOutput: 1, desktopViewportClaims: 1 }
            }
          })
          await waitFor(() =>
            desktop.events.some((event) => event.type === 'subscribed' && event.streamId === 1)
          )
        }

        const desktopA = await openDesktop('desktop-a')
        await subscribeDesktop(desktopA, 'desktop-a', 100, 30)
        await waitFor(() => ptySizes.get('pty-1')?.cols === 100)

        // Pair B only after A authenticates; rotating an unused offer would invalidate A's token.
        const desktopB = await openDesktop('desktop-b')
        await subscribeDesktop(desktopB, 'desktop-b', 80, 24)
        await waitFor(() => ptySizes.get('pty-1')?.cols === 80)

        sendTerminalMultiplexJsonFrame(desktopA.subscription, {
          opcode: TerminalStreamOpcode.ClaimViewport,
          streamId: 1,
          seq: 2,
          payload: { cols: 120, rows: 36 }
        })
        await waitFor(() => ptySizes.get('pty-1')?.cols === 120)

        desktopA.subscription.close()
        await waitFor(() => ptySizes.get('pty-1')?.cols === 80)

        desktopB.subscription.close()
        await waitFor(() => ptySizes.get('pty-1')?.cols === 150)
      } finally {
        for (const subscription of subscriptions) {
          subscription.close()
        }
        await server.stop()
        rmSync(userDataPath, { recursive: true, force: true })
      }
    }
  )

  it(
    'multiplexes shared-control calls and passive subscriptions through the real runtime',
    { timeout: REMOTE_RUNTIME_TEST_TIMEOUT_MS },
    async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-shared-control-'))
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
      const accountsListeners = new Set<(snapshot: unknown) => void>()
      const notificationListeners = new Set<(event: unknown) => void>()
      const sessionTabListeners = new Set<(snapshot: unknown) => void>()
      const subscriptionCleanups = new Map<string, () => void>()
      const sessionTabSnapshot = {
        worktree: 'wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
      const runtime = {
        getRuntimeId: () => 'shared-runtime-test',
        getStartedAt: () => 1,
        getStatus: () => ({
          runtimeId: 'shared-runtime-test',
          startedAt: 1,
          version: '1.0.0',
          protocolVersion: 1,
          minCompatibleDesktopVersion: '1.0.0',
          minCompatibleMobileVersion: '1.0.0',
          capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
        }),
        cleanupSubscriptionsForConnection: (connectionId: string) => {
          for (const [id, cleanup] of Array.from(subscriptionCleanups)) {
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
        cleanupSubscriptionsByPrefix: (prefix: string) => {
          for (const [id, cleanup] of Array.from(subscriptionCleanups)) {
            if (id.startsWith(prefix)) {
              cleanup()
              subscriptionCleanups.delete(id)
            }
          }
        },
        cancelMobileDictationForConnection: () => {},
        onClientDisconnected: () => {},
        onClientEvent: (listener: (event: RuntimeClientEvent) => void) => {
          clientEventListeners.add(listener)
          return () => clientEventListeners.delete(listener)
        },
        getAccountsSnapshot: () => ({ claude: null, codex: null }),
        refreshAccountsForMobile: async () => {
          for (const listener of accountsListeners) {
            listener({ claude: null, codex: null })
          }
        },
        refreshAccountsForMobileSubscriber: async () => {
          for (const listener of accountsListeners) {
            listener({ claude: null, codex: null })
          }
        },
        onAccountsChanged: (listener: (snapshot: unknown) => void) => {
          accountsListeners.add(listener)
          return () => accountsListeners.delete(listener)
        },
        onNotificationDispatched: (listener: (event: unknown) => void) => {
          notificationListeners.add(listener)
          return () => notificationListeners.delete(listener)
        },
        listMobileSessionTabs: () => sessionTabSnapshot,
        listAllMobileSessionTabs: () => [sessionTabSnapshot],
        onMobileSessionTabsChanged: (listener: (snapshot: unknown) => void) => {
          sessionTabListeners.add(listener)
          return () => sessionTabListeners.delete(listener)
        },
        watchFileExplorer: async () => () => {},
        listRepos: () => [repo],
        showRepo: (selector: string) => {
          if (selector !== repo.id && selector !== `id:${repo.id}`) {
            throw new Error('repo_not_found')
          }
          return repo
        },
        listDetectedManagedWorktrees: () => ({
          repoId: repo.id,
          authoritative: true,
          source: 'git',
          worktrees
        }),
        dedupeWorktreeCreate: passthroughDedupe,
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
        const shared = new RemoteRuntimeSharedControlConnection(pairing)
        const subscription = await shared.subscribe<RuntimeClientEventStreamMessage>(
          'runtime.clientEvents.subscribe',
          undefined,
          REMOTE_RUNTIME_REQUEST_TIMEOUT_MS,
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
        try {
          await waitFor(() => events.some((event) => event.type === 'ready'))

          await expect(
            shared.request('status.get', undefined, REMOTE_RUNTIME_REQUEST_TIMEOUT_MS)
          ).resolves.toMatchObject({
            ok: true,
            result: { capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY] }
          })
          await expect(
            shared.request('repo.list', undefined, REMOTE_RUNTIME_REQUEST_TIMEOUT_MS)
          ).resolves.toMatchObject({
            ok: true,
            result: { repos: [repo] }
          })
          await expect(
            shared.request(
              'worktree.create',
              { repo: repo.id, name: 'shared-created' },
              REMOTE_RUNTIME_REQUEST_TIMEOUT_MS
            )
          ).resolves.toMatchObject({
            ok: true,
            result: { worktree: { id: 'repo-1::shared-created' } }
          })
          await waitFor(() =>
            events.some((event) => event.type === 'worktreesChanged' && event.repoId === repo.id)
          )

          const mixedEvents: unknown[] = []
          const mixedMethods = [
            ['runtime.clientEvents.subscribe', undefined],
            ['session.tabs.subscribe', { worktree: 'id:wt-1' }],
            ['accounts.subscribe', undefined],
            ['notifications.subscribe', undefined],
            ['files.watch', { worktree: 'id:wt-1' }]
          ] as const
          const mixedSubscriptions = await Promise.all(
            Array.from({ length: 30 }, (_value, index) => {
              const [method, params] = mixedMethods[index % mixedMethods.length]!
              return shared.subscribe(method, params, REMOTE_RUNTIME_REQUEST_TIMEOUT_MS, {
                onResponse: (response) => {
                  if (response.ok) {
                    mixedEvents.push(response.result)
                  }
                },
                onError: (error) => {
                  throw error
                }
              })
            })
          )
          await waitFor(
            () => subscriptionCleanups.size >= mixedSubscriptions.length + 1,
            5000,
            () => `cleanup count ${subscriptionCleanups.size}, event count ${mixedEvents.length}`
          )
          await waitFor(
            () => mixedEvents.length > 0,
            REMOTE_RUNTIME_REQUEST_TIMEOUT_MS,
            () => `cleanup count ${subscriptionCleanups.size}, event count ${mixedEvents.length}`
          )
          expect(server.getMobileSocketWiring()?.connectionCount).toBe(1)
          for (const mixed of mixedSubscriptions) {
            mixed.close()
          }

          const extraSubscriptions = await Promise.all(
            Array.from({ length: 30 }, () =>
              shared.subscribe<RuntimeClientEventStreamMessage>(
                'runtime.clientEvents.subscribe',
                undefined,
                REMOTE_RUNTIME_REQUEST_TIMEOUT_MS,
                {
                  onResponse: () => {},
                  onError: (error) => {
                    throw error
                  }
                }
              )
            )
          )
          expect(server.getMobileSocketWiring()?.connectionCount).toBe(1)
          for (const extra of extraSubscriptions) {
            extra.close()
          }
        } finally {
          subscription.close()
          shared.close()
        }
      } finally {
        await server.stop()
        rmSync(userDataPath, { recursive: true, force: true })
      }
    }
  )
})

function sendTerminalMultiplexJsonFrame(
  subscription: RemoteRuntimeSubscription,
  frame: {
    opcode: TerminalStreamOpcode
    streamId: number
    seq: number
    payload: unknown
  }
): void {
  const sent = subscription.sendBinary(
    encodeTerminalStreamFrame({
      opcode: frame.opcode,
      streamId: frame.streamId,
      seq: frame.seq,
      payload: encodeTerminalStreamJson(frame.payload)
    })
  )
  if (!sent) {
    throw new Error('terminal multiplex frame was not sent')
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
  describeTimeout?: () => string
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(
    `Timed out waiting for condition${describeTimeout ? `: ${describeTimeout()}` : ''}`
  )
}
