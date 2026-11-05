import { describe, expect, it, vi } from 'vitest'
import {
  resolveTerminalIdentityFromProbes,
  TERMINAL_HANDLE_STALE_ERROR
} from './terminal-identity-probe'

function probes(overrides: { structured?: boolean; livePty?: boolean; leafError?: Error | null }) {
  const assertLiveLeaf = vi.fn(() => {
    if (overrides.leafError) {
      throw overrides.leafError
    }
  })
  return {
    calls: { assertLiveLeaf },
    probes: {
      isLiveStructuredWorker: () => overrides.structured ?? false,
      hasLivePty: () => overrides.livePty ?? false,
      assertLiveLeaf
    }
  }
}

describe('the terminal identity probe', () => {
  it('answers live for a structured worker without touching the PTY graph', () => {
    // Structured workers have no leaf; PTY-only terminal.show falsely labels their live handle stale.
    const { calls, probes: p } = probes({ structured: true })
    expect(resolveTerminalIdentityFromProbes('structworker_1', p)).toEqual({
      handle: 'structworker_1',
      live: true
    })
    expect(calls.assertLiveLeaf).not.toHaveBeenCalled()
  })

  it('answers live for a PTY handle the runtime still holds', () => {
    const { probes: p } = probes({ livePty: true })
    expect(resolveTerminalIdentityFromProbes('term_1', p).live).toBe(true)
  })

  it('runs the full leaf check for a handle with no live PTY', () => {
    // Keep the rendererGraphEpoch leaf check: shells can retain stale handles across window reload.
    const { calls, probes: p } = probes({})
    expect(resolveTerminalIdentityFromProbes('term_1', p).live).toBe(true)
    expect(calls.assertLiveLeaf).toHaveBeenCalledTimes(1)
  })

  it('answers not-live for a stale handle', () => {
    const { probes: p } = probes({ leafError: new Error(TERMINAL_HANDLE_STALE_ERROR) })
    expect(resolveTerminalIdentityFromProbes('term_1', p)).toEqual({
      handle: 'term_1',
      live: false
    })
  })

  it('propagates "could not look" rather than reporting it as a dead handle', () => {
    // Graph startup is no proof of a dead handle; propagate inability to observe.
    const { probes: p } = probes({ leafError: new Error('graph_not_ready') })
    expect(() => resolveTerminalIdentityFromProbes('term_1', p)).toThrow('graph_not_ready')
  })
})
