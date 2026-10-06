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
    // The defect this pins: the sender validator asked `terminal.show`, whose leaf lookup misses
    // for a session that never had a pane, and reported a live worker's own handle as stale.
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
    // `getLiveLeafForHandle` is the one that re-checks `rendererGraphEpoch`, and that check is the
    // entire reason the sender is validated: a long-lived shell keeps a stale
    // `ORCA_TERMINAL_HANDLE` across a window reload. A cheaper probe would start passing it.
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
    // A graph that is not ready yet is not evidence the handle died, and `terminal.show` lets that
    // error through today. Answering `live: false` here would make a command refuse its own sender
    // during startup instead of failing loudly.
    const { probes: p } = probes({ leafError: new Error('graph_not_ready') })
    expect(() => resolveTerminalIdentityFromProbes('term_1', p)).toThrow('graph_not_ready')
  })
})
