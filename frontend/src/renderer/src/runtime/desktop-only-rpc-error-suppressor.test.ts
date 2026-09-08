import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Suppressor from './desktop-only-rpc-error-suppressor'
import { RuntimeRpcCallError } from './runtime-rpc-client'

type SuppressorModule = typeof Suppressor
type Listener = (event: { reason: unknown; preventDefault: () => void }) => void

function makeRpcError(code: string, method: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'req-1',
    ok: false,
    error: { code, message: `Unknown method: ${method}.` }
  })
}

// Mirrors crash-diagnostics.test.ts's stub-window-with-a-listener-map
// convention (this suppressor also installs a single global
// `unhandledrejection` listener, same shape).
describe('desktop-only-rpc-error-suppressor', () => {
  let suppressor: SuppressorModule
  let listeners: Map<string, Listener[]>
  let removeEventListenerMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    listeners = new Map()
    removeEventListenerMock = vi.fn((type: string, listener: Listener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((candidate) => candidate !== listener)
      )
    })
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: Listener) => {
        const current = listeners.get(type) ?? []
        current.push(listener)
        listeners.set(type, current)
      }),
      removeEventListener: removeEventListenerMock
    })
    suppressor = (await import('./desktop-only-rpc-error-suppressor')) as SuppressorModule
  })

  afterEach(() => {
    suppressor._uninstallDesktopOnlyRpcErrorSuppressorForTests()
    vi.unstubAllGlobals()
  })

  function dispatch(reason: unknown): { defaultPrevented: boolean } {
    const state = { defaultPrevented: false }
    listeners.get('unhandledrejection')?.[0]?.({
      reason,
      preventDefault: () => {
        state.defaultPrevented = true
      }
    })
    return state
  }

  it('suppresses speech.models.list method_not_found (TASK-007)', () => {
    suppressor.installDesktopOnlyRpcErrorSuppressor()

    const result = dispatch(makeRpcError('method_not_found', 'speech.models.list'))

    expect(result.defaultPrevented).toBe(true)
  })

  it('does not suppress an unlisted namespace method_not_found', () => {
    suppressor.installDesktopOnlyRpcErrorSuppressor()

    const result = dispatch(makeRpcError('method_not_found', 'git.status'))

    expect(result.defaultPrevented).toBe(false)
  })

  // FE-TASK-EVM-001 (CR-EVM-002): 9/12 ephemeralVm.* methods now have a real
  // backend-go implementation — 'ephemeralVm' must stay OUT of
  // DESKTOP_ONLY_NAMESPACES so a real regression (e.g. ephemeralVm.listRecipes
  // going missing) surfaces as a visible console error again instead of being
  // silently swallowed.
  it('does not suppress ephemeralVm.* method_not_found (CR-EVM-002)', () => {
    suppressor.installDesktopOnlyRpcErrorSuppressor()

    const result = dispatch(makeRpcError('method_not_found', 'ephemeralVm.listRecipes'))

    expect(result.defaultPrevented).toBe(false)
  })

  it('does not touch a non-RuntimeRpcCallError rejection', () => {
    suppressor.installDesktopOnlyRpcErrorSuppressor()

    const result = dispatch(new Error('some other failure'))

    expect(result.defaultPrevented).toBe(false)
  })

  it('does not touch a RuntimeRpcCallError with a different code', () => {
    suppressor.installDesktopOnlyRpcErrorSuppressor()

    const result = dispatch(makeRpcError('forbidden', 'speech.models.list'))

    expect(result.defaultPrevented).toBe(false)
  })
})
