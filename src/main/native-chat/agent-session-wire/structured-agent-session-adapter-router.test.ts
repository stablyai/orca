import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'

function adapterOf(
  releaseAcquisition: StructuredAgentSessionAdapter['releaseAcquisition']
): StructuredAgentSessionAdapter {
  return {
    acquire: vi.fn(async () => ({ process: { pid: 1 } }) as never),
    releaseAcquisition,
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  } as unknown as StructuredAgentSessionAdapter
}

describe('StructuredAgentSessionAdapterRouter.releaseAcquisition', () => {
  it('drops the owner even when its release reports a typed failure', async () => {
    const failure = new Error('root exited')
    const claude = adapterOf(vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(false))
    const codex = adapterOf(vi.fn(async () => false))
    const router = new StructuredAgentSessionAdapterRouter({ claude, codex }, async () => {})
    const identity = { sessionId: 'session-1', agent: 'claude' } as never
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
    const identity = { sessionId: 'session-1', agent: 'claude' } as never
    await router.acquire({ identity, fence: 1, spawnToken: 'spawn-1' })

    await expect(router.closeSession('session-1')).resolves.toBe(false)
    await expect(
      router.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: {} as never,
        fence: 1
      })
    ).resolves.toMatchObject({ state: 'unknown' })
    await expect(router.closeSession('session-1')).resolves.toBe(true)
    expect(closeSession).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledTimes(1)
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
      const identity = { sessionId: 'session-1', agent: 'claude' } as never
      await router.acquire({ identity, fence: 1, spawnToken: 'spawn-1' })
      const stopSession = router[method]

      await expect(stopSession('session-1')).resolves.toBe(false)
      await expect(
        router.dispatch({
          sessionId: 'session-1',
          clientMessageId: 'client-1',
          body: {} as never,
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
        identity: { sessionId: 'session-1', agent: 'claude' } as never,
        fence: 1,
        spawnToken: 'spawn-1'
      })
      const stopSession = router[method]

      await expect(stopSession('session-1')).resolves.toBe(true)
      expect(closeSession).toHaveBeenCalledWith('session-1')
    }
  )
})
