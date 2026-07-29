import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'

// Why: the terminal geometry family (resize/setDisplayMode/restoreFit/
// updateViewport) mutates PTY state. A remote client can hold a handle minted
// for a PTY that was later replaced under the pane (restart/re-spawn bumps
// ptyId/generation). The UNGUARDED resolveLeafForHandle returns the pane's
// CURRENT pty, so a stale client would mutate the wrong (new) PTY — visible as
// geometry corruption on the fresh session (#7718). These methods must use the
// guarded resolveLiveLeafForHandle, which throws terminal_handle_stale instead.

// Models a stale handle exactly as the runtime does: the unguarded resolver
// silently adopts the replacement PTY ('pty-b'); the guarded resolver throws.
const NEW_PTY_UNDER_PANE = 'pty-b'

function stubStaleHandleRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    // Unguarded path: returns the pane's current (replaced) PTY — the misroute.
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: NEW_PTY_UNDER_PANE }),
    // Guarded path: surfaces the staleness.
    resolveLiveLeafForHandle: vi.fn(() => {
      throw new Error('terminal_handle_stale')
    }),
    ...overrides
  } as unknown as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

async function expectStale(method: string, params: unknown, mutators: string[]): Promise<void> {
  const spies: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const name of mutators) {
    spies[name] = vi.fn()
  }
  const runtime = stubStaleHandleRuntime(spies as Partial<OrcaRuntimeService>)
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

  const response = await dispatcher.dispatch(makeRequest(method, params))

  expect(response.ok).toBe(false)
  if (response.ok) {
    throw new Error(`expected ${method} to reject a stale handle`)
  }
  expect(response.error.message).toContain('terminal_handle_stale')
  // The wrong (replacement) PTY must never be mutated.
  for (const name of mutators) {
    expect(spies[name]).not.toHaveBeenCalled()
  }
}

describe('terminal geometry family rejects stale handles instead of mutating the wrong PTY', () => {
  it('terminal.resizeForClient fails with terminal_handle_stale', async () => {
    await expectStale(
      'terminal.resizeForClient',
      { terminal: 'stale-terminal', mode: 'restore', clientId: 'client-1' },
      ['resizeForClient']
    )
  })

  it('terminal.setDisplayMode fails with terminal_handle_stale', async () => {
    await expectStale(
      'terminal.setDisplayMode',
      {
        terminal: 'stale-terminal',
        mode: 'auto',
        client: { id: 'client-1', type: 'mobile' },
        viewport: { cols: 80, rows: 24 }
      },
      [
        'setMobileDisplayMode',
        'applyMobileDisplayMode',
        'updateMobileSubscriberViewport',
        'markMobileActor'
      ]
    )
  })

  it('terminal.restoreFit fails with terminal_handle_stale', async () => {
    await expectStale('terminal.restoreFit', { terminal: 'stale-terminal' }, [
      'reclaimTerminalForDesktop'
    ])
  })

  it('terminal.updateViewport fails with terminal_handle_stale', async () => {
    await expectStale(
      'terminal.updateViewport',
      {
        terminal: 'stale-terminal',
        client: { id: 'client-1', type: 'mobile' },
        viewport: { cols: 80, rows: 24 }
      },
      ['updateMobileViewport', 'updateDesktopViewport']
    )
  })
})

describe('terminal geometry family still mutates the live PTY for a fresh handle', () => {
  it('terminal.restoreFit reclaims the resolved PTY when the handle is live', async () => {
    const reclaimTerminalForDesktop = vi.fn().mockResolvedValue(true)
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-a' }),
      reclaimTerminalForDesktop
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.restoreFit', { terminal: 'live-terminal' })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({ restored: true })
    expect(reclaimTerminalForDesktop).toHaveBeenCalledWith('pty-a')
  })

  it('terminal.resizeForClient resizes the resolved PTY when the handle is live', async () => {
    const resizeForClient = vi.fn().mockResolvedValue({ cols: 80, rows: 24 })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-a' }),
      resizeForClient
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.resizeForClient', {
        terminal: 'live-terminal',
        mode: 'restore',
        clientId: 'client-1'
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(resizeForClient).toHaveBeenCalledWith(
      'pty-a',
      'restore',
      'client-1',
      undefined,
      undefined
    )
  })

  it('terminal.setDisplayMode mutates the resolved PTY when the handle is live', async () => {
    const setMobileDisplayMode = vi.fn()
    const applyMobileDisplayMode = vi.fn().mockResolvedValue(undefined)
    const updateMobileSubscriberViewport = vi.fn()
    const markMobileActor = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-a' }),
      setMobileDisplayMode,
      applyMobileDisplayMode,
      updateMobileSubscriberViewport,
      markMobileActor,
      getLayout: vi.fn().mockReturnValue({ seq: 42 })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.setDisplayMode', {
        terminal: 'live-terminal',
        mode: 'auto',
        client: { id: 'client-1', type: 'mobile' },
        viewport: { cols: 80, rows: 24 }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(updateMobileSubscriberViewport).toHaveBeenCalledWith('pty-a', 'client-1', {
      cols: 80,
      rows: 24
    })
    expect(markMobileActor).toHaveBeenCalledWith('pty-a', 'client-1')
    expect(setMobileDisplayMode).toHaveBeenCalledWith('pty-a', 'auto')
    expect(applyMobileDisplayMode).toHaveBeenCalledWith('pty-a')
    expect(response.result).toEqual({ mode: 'auto', seq: 42 })
  })

  it('terminal.updateViewport updates the resolved PTY when the handle is live', async () => {
    const updateMobileViewport = vi.fn().mockResolvedValue({ updated: true, applied: true })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-a' }),
      updateMobileViewport,
      getLayout: vi.fn().mockReturnValue({ seq: 7 })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.updateViewport', {
        terminal: 'live-terminal',
        client: { id: 'client-1', type: 'mobile' },
        viewport: { cols: 80, rows: 24 }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(updateMobileViewport).toHaveBeenCalledWith('pty-a', 'client-1', {
      cols: 80,
      rows: 24
    })
    expect(response.result).toEqual({ updated: true, applied: true, seq: 7 })
  })
})
