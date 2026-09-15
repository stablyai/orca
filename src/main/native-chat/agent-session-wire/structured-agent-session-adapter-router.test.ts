import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'

function claudeIdentity(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'claude',
    providerHandle: { kind: 'claude', sessionId: 'provider-session-1', leafUuid: null }
  }
}

function acquisition(fence: number, spawnToken: string): AgentSessionAcquisition {
  return {
    process: { hostId: 'local', pid: 1, processStartTimeMs: 1, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'claude', sessionId: 'provider-session-1', leafUuid: null },
      origin: 'created',
      mintedAtFence: fence,
      observedAt: 1
    }
  }
}

function adapterOf(
  releaseAcquisition: StructuredAgentSessionAdapter['releaseAcquisition']
): StructuredAgentSessionAdapter {
  return {
    acquire: vi.fn(async ({ fence, spawnToken }) => acquisition(fence, spawnToken)),
    releaseAcquisition,
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
}

describe('StructuredAgentSessionAdapterRouter.releaseAcquisition', () => {
  it('drops the owner even when its release reports a typed failure', async () => {
    const failure = new Error('root exited')
    const claude = adapterOf(vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(false))
    const codex = adapterOf(vi.fn(async () => false))
    const router = new StructuredAgentSessionAdapterRouter({ claude, codex }, async () => {})
    const identity = claudeIdentity('session-1')
    await router.acquire({ identity, fence: 1, spawnToken: 'spawn-1' })

    await expect(router.releaseAcquisition({ sessionId: 'session-1' })).rejects.toBe(failure)
    // With no owner left, a later release asks every adapter instead of the stale one.
    await expect(router.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(false)
    expect(claude.releaseAcquisition).toHaveBeenCalledTimes(2)
    expect(codex.releaseAcquisition).toHaveBeenCalledTimes(1)
  })
})

describe('StructuredAgentSessionAdapterRouter.closeSession', () => {
  it('retains the owner after an unproven close so a later retry reaches the same adapter', async () => {
    const claude = adapterOf(vi.fn(async () => true))
    const closeSession = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const dispatch = vi.fn().mockResolvedValue({ state: 'unknown', reason: 'test' })
    claude.closeSession = closeSession
    claude.dispatch = dispatch
    const codex = adapterOf(vi.fn(async () => false))
    const router = new StructuredAgentSessionAdapterRouter({ claude, codex }, async () => {})
    const identity = claudeIdentity('session-1')
    await router.acquire({ identity, fence: 1, spawnToken: 'spawn-1' })

    await expect(router.closeSession('session-1')).resolves.toBe(false)
    await expect(
      router.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: { kind: 'message', role: 'user', blocks: [] },
        fence: 1
      })
    ).resolves.toMatchObject({ state: 'unknown' })
    await expect(router.closeSession('session-1')).resolves.toBe(true)
    expect(closeSession).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('retains a stop proof across journal-close failure until the host acknowledges release', async () => {
    const closeSession = vi.fn(async () => true)
    const closeJournal = vi.fn(async () => {
      throw new Error('journal close failed')
    })
    const claude = adapterOf(vi.fn(async () => true))
    claude.closeSession = closeSession
    const router = new StructuredAgentSessionAdapterRouter(
      { claude, codex: adapterOf(vi.fn(async () => false)) },
      async () => {}
    )
    const identity = claudeIdentity('session-1')
    await router.acquire({ identity, fence: 1, spawnToken: 'spawn-1' })

    await expect(router.closeSession('session-1')).resolves.toBe(true)
    await expect(closeJournal()).rejects.toThrow('journal close failed')
    await expect(router.closeSession('session-1')).resolves.toBe(true)
    expect(closeSession).toHaveBeenCalledOnce()
    router.acknowledgeSessionRelease('session-1')
    await expect(router.closeSession('session-1')).resolves.toBe(false)

    await router.acquire({ identity, fence: 2, spawnToken: 'spawn-2' })
    await expect(router.closeSession('session-1')).resolves.toBe(true)
    expect(closeSession).toHaveBeenCalledTimes(2)
  })
})

describe('StructuredAgentSessionAdapterRouter optional lifecycle methods', () => {
  it.each([
    ['forceCloseSession', 'forceCloseSession'],
    ['disposeSession', 'disposeSession']
  ] as const)(
    '%s forwards to the owner and retains it until proven stopped',
    async (_label, method) => {
      const claude = adapterOf(vi.fn(async () => true))
      const stop = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      claude[method] = stop
      const dispatch = vi.fn().mockResolvedValue({ state: 'unknown', reason: 'test' })
      claude.dispatch = dispatch
      const codex = adapterOf(vi.fn(async () => false))
      const router = new StructuredAgentSessionAdapterRouter({ claude, codex }, async () => {})
      const identity = claudeIdentity('session-1')
      await router.acquire({ identity, fence: 1, spawnToken: 'spawn-1' })
      const stopSession = router[method]

      await expect(stopSession('session-1')).resolves.toBe(false)
      await expect(
        router.dispatch({
          sessionId: 'session-1',
          clientMessageId: 'client-1',
          body: { kind: 'message', role: 'user', blocks: [] },
          fence: 1
        })
      ).resolves.toMatchObject({ state: 'unknown' })
      await expect(stopSession('session-1')).resolves.toBe(true)
      expect(stop).toHaveBeenCalledTimes(2)
      expect(dispatch).toHaveBeenCalledOnce()
    }
  )

  it.each(['forceCloseSession', 'disposeSession'] as const)(
    'falls back to closeSession when an owner lacks %s',
    async (method) => {
      const closeSession = vi.fn().mockResolvedValue(true)
      const claude = adapterOf(vi.fn(async () => true))
      claude.closeSession = closeSession
      const codex = adapterOf(vi.fn(async () => false))
      const router = new StructuredAgentSessionAdapterRouter({ claude, codex }, async () => {})
      await router.acquire({
        identity: claudeIdentity('session-1'),
        fence: 1,
        spawnToken: 'spawn-1'
      })
      const stopSession = router[method]

      await expect(stopSession('session-1')).resolves.toBe(true)
      expect(closeSession).toHaveBeenCalledWith('session-1')
    }
  )
})

describe('StructuredAgentSessionAdapterRouter.closeAll', () => {
  it('refuses to acquire once the global close proof is published', async () => {
    const acquire = vi.fn(async ({ fence, spawnToken }) => acquisition(fence, spawnToken))
    const claude = adapterOf(vi.fn(async () => true))
    claude.acquire = acquire
    const router = new StructuredAgentSessionAdapterRouter(
      { claude, codex: adapterOf(vi.fn(async () => false)) },
      async () => undefined
    )
    await router.closeAll()

    await expect(
      router.acquire({
        identity: claudeIdentity('session-1'),
        fence: 1,
        spawnToken: 'spawn-1'
      })
    ).rejects.toThrow('router is closed')
    expect(acquire).not.toHaveBeenCalled()
  })

  it('keeps a per-session stop proof and reports no stop for a session it never routed', async () => {
    const claude = adapterOf(vi.fn(async () => true))
    const closeAdapters = vi.fn(async () => undefined)
    const router = new StructuredAgentSessionAdapterRouter(
      { claude, codex: adapterOf(vi.fn(async () => false)) },
      closeAdapters
    )
    await router.acquire({
      identity: claudeIdentity('session-1'),
      fence: 1,
      spawnToken: 'spawn-1'
    })

    await router.closeAll()

    // The routed session carries the shutdown's own exit proof; the other two are sessions this
    // router has no record of, and an absent record is not a stop it can report.
    await expect(router.closeSession('session-1')).resolves.toBe(true)
    await expect(router.closeSession('never-routed')).resolves.toBe(false)
    router.acknowledgeSessionRelease('session-1')
    await expect(router.closeSession('session-1')).resolves.toBe(false)
    await router.closeAll()
    expect(closeAdapters).toHaveBeenCalledOnce()
  })

  it('asks the adapters to release an unrouted session rather than answering from the close proof', async () => {
    const claudeRelease = vi.fn(async () => true)
    const codexRelease = vi.fn(async () => false)
    const router = new StructuredAgentSessionAdapterRouter(
      { claude: adapterOf(claudeRelease), codex: adapterOf(codexRelease) },
      async () => undefined
    )
    await router.closeAll()

    await expect(router.releaseAcquisition({ sessionId: 'never-routed' })).resolves.toBe(true)
    expect(claudeRelease).toHaveBeenCalledWith({ sessionId: 'never-routed' })
    expect(codexRelease).toHaveBeenCalledWith({ sessionId: 'never-routed' })
  })

  it('retains live routes and publishes no global proof when closeAll fails', async () => {
    const failure = new Error('adapter shutdown failed')
    const claude = adapterOf(vi.fn(async () => true))
    const dispatch = vi.fn().mockResolvedValue({ state: 'unknown', reason: 'test' })
    const closeSession = vi.fn(async () => true)
    claude.dispatch = dispatch
    claude.closeSession = closeSession
    const router = new StructuredAgentSessionAdapterRouter(
      { claude, codex: adapterOf(vi.fn(async () => false)) },
      vi.fn(async () => {
        throw failure
      })
    )
    await router.acquire({
      identity: claudeIdentity('session-1'),
      fence: 1,
      spawnToken: 'spawn-1'
    })

    await expect(router.closeAll()).rejects.toBe(failure)

    await expect(router.closeSession('never-routed')).resolves.toBe(false)
    await expect(
      router.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: { kind: 'message', role: 'user', blocks: [] },
        fence: 1
      })
    ).resolves.toMatchObject({ state: 'unknown' })
    await expect(router.closeSession('session-1')).resolves.toBe(true)
    expect(closeSession).toHaveBeenCalledOnce()
  })

  it('keeps the global proof when an acquisition lands mid-close', async () => {
    let resolveAcquire!: (value: AgentSessionAcquisition) => void
    const closeSession = vi.fn(async () => true)
    const claude = adapterOf(vi.fn(async () => true))
    claude.closeSession = closeSession
    claude.acquire = vi.fn(
      () =>
        new Promise<AgentSessionAcquisition>((resolve) => {
          resolveAcquire = resolve
        })
    )
    const router = new StructuredAgentSessionAdapterRouter(
      { claude, codex: adapterOf(vi.fn(async () => false)) },
      async () => undefined
    )
    const acquiring = router.acquire({
      identity: claudeIdentity('session-1'),
      fence: 2,
      spawnToken: 'spawn-2'
    })

    await router.closeAll()
    resolveAcquire(acquisition(2, 'spawn-2'))

    // The route is NOT published behind a closed adapter, so nothing routes back out to it — and
    // with no route the router has nothing to stop and no stop to report.
    await expect(acquiring).rejects.toThrow('router is closed')
    await expect(router.closeSession('session-1')).resolves.toBe(false)
    expect(closeSession).not.toHaveBeenCalled()
  })
})
