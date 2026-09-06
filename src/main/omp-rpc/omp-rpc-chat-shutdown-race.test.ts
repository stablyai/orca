// App-quit disposal racing an acquire that is still between its spawn and its
// registration. Split from omp-rpc-chat-session-registry.ts's own test file so
// neither exceeds its max-lines budget.

import { afterEach, describe, expect, it } from 'vitest'
import type { OmpSessionOwningRpcClient } from '../../shared/omp-rpc-protocol'
import { createFakeOmpRpcChild } from './fake-omp-rpc-child'
import { spawnOmpRpcClient } from './omp-rpc-client'
import { OmpRpcChatSessionRegistry } from './omp-rpc-chat-session-registry'
import { OmpRpcLocalSessionWriteFence } from './omp-rpc-local-session-write-fence'

const clients = new Set<OmpSessionOwningRpcClient>()

function spawnFakeClient(): OmpSessionOwningRpcClient {
  const client = spawnOmpRpcClient(
    createFakeOmpRpcChild(
      {
        sessionState: {
          sessionFile: null,
          sessionId: 'session-a',
          isStreaming: false,
          isCompacting: false,
          queuedMessageCount: 0
        }
      },
      'session-owning'
    ).spawnOptions
  ) as unknown as OmpSessionOwningRpcClient
  clients.add(client)
  return client
}

const ACQUIRE_ARGS = {
  paneKey: 'tab:leaf',
  ptyId: 'pty-1',
  cwd: '/work',
  executablePath: 'omp',
  sessionFile: '/sessions/a.jsonl',
  sessionFilePath: '/sessions/a.jsonl',
  isPtyAlive: () => false
}

afterEach(() => {
  for (const client of clients) {
    client.dispose()
  }
  clients.clear()
})

describe('OmpRpcChatSessionRegistry shutdown race', () => {
  it('waits for a superseded acquired child whose exit remains unproven', async () => {
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    let resolveExit!: () => void
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const client = {
      whenReady: () => ready,
      switchSession: async () => {},
      getState: async () => ({ sessionFile: '/sessions/a.jsonl', sessionId: 'session-a', isStreaming: false, isCompacting: false, queuedMessageCount: 0 }),
      getCommands: async () => [], setSubagentSubscription: async () => {}, whenExited: () => exited,
      dispose: () => {}, on: () => () => {}
    } as unknown as OmpSessionOwningRpcClient
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => client,
      proveRpcExit: async () => ({ status: 'unverifiable', reason: 'child still live' })
    })
    const acquiring = registry.acquire({ ...ACQUIRE_ARGS })
    const shutdown = registry.disposeAll()
    resolveReady()

    await expect(acquiring).resolves.toMatchObject({ status: 'rpc-child-unverifiable' })
    let shutdownFinished = false
    void shutdown.then(() => { shutdownFinished = true })
    await Promise.resolve()
    expect(shutdownFinished).toBe(false)

    resolveExit()
    await expect(shutdown).resolves.toBeUndefined()
  })

  it('waits for an unregistered failed acquire to prove its child exited', async () => {
    let resolveExit!: () => void
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const client = {
      whenReady: async () => {
        throw new Error('ready failed')
      },
      switchSession: async () => {},
      getState: async () => ({
        sessionFile: '/sessions/a.jsonl',
        sessionId: 'session-a',
        isStreaming: false,
        isCompacting: false,
        queuedMessageCount: 0
      }),
      getCommands: async () => [],
      setSubagentSubscription: async () => {},
      whenExited: () => exited,
      dispose: () => {},
      on: () => () => {}
    } as unknown as OmpSessionOwningRpcClient
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => client,
      proveRpcExit: async () => ({ status: 'unverifiable', reason: 'child still live' })
    })

    await expect(registry.acquire({ ...ACQUIRE_ARGS })).resolves.toMatchObject({
      status: 'rpc-child-unverifiable'
    })

    let disposed = false
    const teardown = registry.disposeAll().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)

    resolveExit()
    await teardown
    expect(disposed).toBe(true)
  })

  it('keeps a session write fence until a shutdown child exits', async () => {
    let resolveExit!: () => void
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const client = {
      whenReady: async () => ({ ready: {}, negotiatedProtocolVersion: 2 }),
      switchSession: async () => {},
      getState: async () => ({
        sessionFile: '/sessions/a.jsonl',
        sessionId: 'session-a',
        isStreaming: false,
        isCompacting: false,
        queuedMessageCount: 0
      }),
      getCommands: async () => [],
      setSubagentSubscription: async () => {},
      whenExited: () => exited,
      dispose: () => {},
      on: () => () => {}
    } as unknown as OmpSessionOwningRpcClient
    const writerFence = new OmpRpcLocalSessionWriteFence()
    const registry = new OmpRpcChatSessionRegistry({
      writerFence,
      spawnClient: () => client
    })

    expect((await registry.acquire({ ...ACQUIRE_ARGS })).status).toBe('acquired')
    const teardown = registry.disposeAll()

    await expect(
      registry.acquire({ ...ACQUIRE_ARGS, paneKey: 'tab:other', ptyId: 'pty-2' })
    ).resolves.toEqual({ status: 'conflict' })

    resolveExit()
    await teardown

    expect(
      (await registry.acquire({ ...ACQUIRE_ARGS, paneKey: 'tab:other', ptyId: 'pty-2' })).status
    ).toBe('acquired')
  })

  it('waits for an acquire queued behind release before shutdown completes', async () => {
    const registry = new OmpRpcChatSessionRegistry({ spawnClient: spawnFakeClient })
    let finishRelease!: (result: { released: boolean }) => void
    const pendingRelease = new Promise<{ released: boolean }>((resolve) => {
      finishRelease = resolve
    })
    const releasing = registry as unknown as {
      pendingReleaseByPaneKey: Map<string, Promise<{ released: boolean }>>
    }
    releasing.pendingReleaseByPaneKey.set('tab:leaf', pendingRelease)
    const pendingAcquire = registry.acquire({
      ...ACQUIRE_ARGS,
      sessionFile: '/sessions/b.jsonl',
      sessionFilePath: '/sessions/b.jsonl'
    })

    const teardown = registry.disposeAll()
    finishRelease({ released: false })
    releasing.pendingReleaseByPaneKey.delete('tab:leaf')
    await teardown

    expect((await pendingAcquire).status).toBe('conflict')
    expect(registry.get('tab:leaf')).toBeNull()
  })

  // XLR-R4-002 (cross-lab review): `disposeAll` can only dispose what is
  // REGISTERED, and an acquire spends its whole readiness/switch/get_state
  // window spawned but unregistered. A quit landing in that window used to
  // leave the pane's generation intact, so the acquire went on to publish its
  // child into an already-disposed registry — an `omp --mode rpc` writer with
  // no shutdown owner left to dispose it.
  it('never registers a child spawned before app-quit disposal (XLR-R4-002)', async () => {
    let registry!: OmpRpcChatSessionRegistry
    registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        // The quit lands after the PTY was released and the child spawned, and
        // before this acquire reaches its registration.
        registry.disposeAll()
        return spawnFakeClient()
      }
    })

    const result = await registry.acquire({ ...ACQUIRE_ARGS })

    // `conflict` is this registry's proven-disposal verdict: it is reported
    // only when the loser's claim was freed against a proven child exit (an
    // unprovable one travels as `rpc-child-unverifiable`), so it says the
    // racing child was disposed rather than left writing the session.
    expect(result.status).toBe('conflict')
    expect(registry.get('tab:leaf')).toBeNull()
  })

  // XLR-R5-002 (cross-lab review): `disposeAll` used to CLEAR the pane
  // generations, so the next fresh acquire started from 1 again — the same
  // number a pre-disposal acquire still waiting for readiness was holding.
  // Both then passed the registration fence and returned `acquired`, and the
  // loser's child was never disposed: an unowned `omp --mode rpc` writer.
  it('never reuses a generation a pre-disposal acquire still holds (XLR-R5-002)', async () => {
    let registry!: OmpRpcChatSessionRegistry
    let raced = false
    let second: Promise<Awaited<ReturnType<OmpRpcChatSessionRegistry['acquire']>>> | null = null
    registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        if (!raced) {
          raced = true
          // The quit lands while this acquire is spawned but unregistered, and
          // the pane immediately rebinds to a DIFFERENT session identity.
          registry.disposeAll()
          second = registry.acquire({
            ...ACQUIRE_ARGS,
            sessionFile: '/sessions/b.jsonl',
            sessionFilePath: '/sessions/b.jsonl'
          })
        }
        return spawnFakeClient()
      }
    })

    const first = await registry.acquire({ ...ACQUIRE_ARGS })
    const secondResult = await second!

    expect(secondResult.status).toBe('acquired')
    // The older acquire has to lose its fence and dispose the child it was
    // about to publish, rather than overwrite the newer registration.
    expect(first.status).toBe('conflict')
    expect(registry.get('tab:leaf')).not.toBeNull()
    expect(registry.get('tab:leaf')).toBe(
      secondResult.status === 'acquired' ? secondResult.session : null
    )
  })

  // XLR-R6-005 (cross-lab review): `disposeAll` used to treat SENDING SIGTERM
  // as completed disposal, so `will-quit` reached `app.quit()` while a child
  // that delayed or ignored the signal was still writing its session file — and
  // the transport's SIGKILL escalation rides an unref'd timer that is not a
  // member of the app's teardown barrier. It now resolves only once the child
  // has actually exited, which is what makes joining that barrier meaningful.
  it('resolves only once every RPC child has actually exited (XLR-R6-005)', async () => {
    const registry = new OmpRpcChatSessionRegistry({ spawnClient: spawnFakeClient })
    expect((await registry.acquire({ ...ACQUIRE_ARGS })).status).toBe('acquired')
    let exited = false
    void [...clients]
      .at(-1)
      ?.whenExited()
      .then(() => {
        exited = true
      })

    const teardown = registry.disposeAll()
    // The SIGTERM is sent synchronously, and proves nothing on its own.
    expect(exited).toBe(false)
    await teardown

    expect(exited).toBe(true)
  })

  // The same latch must not outlive the quit it was set for: `disposeAll` is
  // also the between-runs reset (clearOmpRpcChatHandlersForTests), and the
  // claim it releases has to be re-acquirable.
  it('still admits a fresh acquire after disposal', async () => {
    const registry = new OmpRpcChatSessionRegistry({ spawnClient: spawnFakeClient })
    expect((await registry.acquire({ ...ACQUIRE_ARGS })).status).toBe('acquired')

    await registry.disposeAll()

    expect((await registry.acquire({ ...ACQUIRE_ARGS })).status).toBe('acquired')
  })
})
