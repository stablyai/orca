import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS,
  MAIN_TERMINAL_MODEL_HANDOFF_CATCH_UP_MS,
  MainTerminalModelDormancy,
  chunkDataAfterSeed
} from './main-terminal-model-dormancy'

function createHarness() {
  const dropped: string[] = []
  const materialized: string[] = []
  const state = {
    now: 1_000,
    generation: 1,
    outputSequence: 0,
    idle: true,
    handoff: new Map<string, boolean>(),
    dropped,
    materialized
  }
  const dormancy = new MainTerminalModelDormancy({
    now: () => state.now,
    lifecycleGeneration: () => state.generation,
    outputSequence: () => state.outputSequence,
    isModelIdle: () => state.idle,
    dropModel: (ptyId) => state.dropped.push(ptyId),
    materializeModel: (ptyId) => state.materialized.push(ptyId),
    setHandoffPending: (ptyId, pending) => state.handoff.set(ptyId, pending)
  })
  const goDormant = (ptyId: string): void => {
    dormancy.onChunk(ptyId, 0)
    state.now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS
    expect(dormancy.onChunk(ptyId, 0)).toBe(true)
  }
  return { state, dormancy, goDormant }
}

describe('MainTerminalModelDormancy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the model until the PTY has gone a full grace period without demand', () => {
    const { state, dormancy } = createHarness()
    expect(dormancy.onChunk('pty', 0)).toBe(false)
    state.now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS - 1
    expect(dormancy.onChunk('pty', 10)).toBe(false)
    state.now += 1
    expect(dormancy.onChunk('pty', 20)).toBe(true)
    expect(state.dropped).toEqual(['pty'])
    expect(dormancy.isDormant('pty')).toBe(true)
    expect(dormancy.wasEverDormant('pty')).toBe(true)
  })

  it('restarts the grace period whenever something needs the model', () => {
    const { state, dormancy } = createHarness()
    dormancy.onChunk('pty', 0)
    state.now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS - 1
    state.idle = false
    expect(dormancy.onChunk('pty', 0)).toBe(false)
    state.idle = true
    state.now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS - 1
    expect(dormancy.onChunk('pty', 0)).toBe(false)
    dormancy.noteDemand('pty')
    state.now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS - 1
    expect(dormancy.onChunk('pty', 0)).toBe(false)
    expect(state.dropped).toEqual([])
  })

  it('skips the model while dormant and idle, without rebuilding it', () => {
    const { state, dormancy, goDormant } = createHarness()
    goDormant('pty')
    expect(dormancy.onChunk('pty', 100)).toBe(true)
    expect(dormancy.onChunk('pty', 200)).toBe(true)
    expect(state.materialized).toEqual([])
  })

  it('rebuilds the model behind a gate handoff as soon as a chunk arrives with demand', () => {
    const { state, dormancy, goDormant } = createHarness()
    goDormant('pty')
    state.idle = false
    expect(dormancy.onChunk('pty', 100)).toBe(false)
    expect(state.materialized).toEqual(['pty'])
    expect(state.handoff.get('pty')).toBe(true)
    expect(dormancy.isDormant('pty')).toBe(false)
    expect(dormancy.wasEverDormant('pty')).toBe(true)
  })

  it('rebuilds the model on an out-of-band demand such as a hidden mark', () => {
    const { state, dormancy, goDormant } = createHarness()
    goDormant('pty')
    dormancy.noteDemand('pty')
    expect(state.materialized).toEqual(['pty'])
    expect(state.handoff.get('pty')).toBe(true)
  })

  it('ends the handoff at once when main already ingested every byte the seed covers', () => {
    const { state, dormancy, goDormant } = createHarness()
    goDormant('pty')
    dormancy.noteDemand('pty')
    state.outputSequence = 500
    dormancy.seedSettled('pty', 500)
    expect(state.handoff.get('pty')).toBe(false)
  })

  it('holds the handoff until the first chunk that starts at or past the seed', () => {
    const { state, dormancy, goDormant } = createHarness()
    goDormant('pty')
    dormancy.noteDemand('pty')
    state.outputSequence = 400
    dormancy.seedSettled('pty', 500)
    expect(state.handoff.get('pty')).toBe(true)
    dormancy.onChunk('pty', 450)
    expect(state.handoff.get('pty')).toBe(true)
    dormancy.onChunk('pty', 500)
    expect(state.handoff.get('pty')).toBe(false)
  })

  it('stops waiting for in-flight bytes after the catch-up deadline', () => {
    const { state, dormancy, goDormant } = createHarness()
    goDormant('pty')
    dormancy.noteDemand('pty')
    dormancy.seedSettled('pty', 500)
    vi.advanceTimersByTime(MAIN_TERMINAL_MODEL_HANDOFF_CATCH_UP_MS - 1)
    expect(state.handoff.get('pty')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(state.handoff.get('pty')).toBe(false)
  })

  it('does not go dormant while a handoff is pending', () => {
    const { state, dormancy, goDormant } = createHarness()
    goDormant('pty')
    dormancy.noteDemand('pty')
    state.now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS * 2
    expect(dormancy.onChunk('pty', 0)).toBe(false)
    expect(state.dropped).toEqual(['pty'])
  })

  it('keeps the model live for the rest of the generation after a failed seed', () => {
    const { state, dormancy, goDormant } = createHarness()
    goDormant('pty')
    dormancy.noteDemand('pty')
    dormancy.seedFailed('pty')
    expect(state.handoff.get('pty')).toBe(false)
    state.now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS * 2
    expect(dormancy.onChunk('pty', 0)).toBe(false)
    expect(state.dropped).toEqual(['pty'])
  })

  it('treats a materialize that throws as a failed seed', () => {
    const handoff: boolean[] = []
    const state = { handoff, now: 0, idle: true }
    const dormancy = new MainTerminalModelDormancy({
      now: () => state.now,
      lifecycleGeneration: () => 1,
      outputSequence: () => 0,
      isModelIdle: () => state.idle,
      dropModel: () => {},
      materializeModel: () => {
        throw new Error('boom')
      },
      setHandoffPending: (_ptyId, pending) => state.handoff.push(pending)
    })
    dormancy.onChunk('pty', 0)
    state.now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS
    dormancy.onChunk('pty', 0)
    dormancy.noteDemand('pty')
    expect(state.handoff).toEqual([true, false])
    state.now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS * 2
    expect(dormancy.onChunk('pty', 0)).toBe(false)
  })

  it('starts over when the PTY lifecycle generation changes', () => {
    const { state, dormancy, goDormant } = createHarness()
    goDormant('pty')
    dormancy.noteDemand('pty')
    state.generation = 2
    expect(dormancy.isDormant('pty')).toBe(false)
    expect(dormancy.wasEverDormant('pty')).toBe(false)
    expect(state.handoff.get('pty')).toBe(false)
  })

  it('lets an explicit seed cancel dormancy without rebuilding from the daemon', () => {
    const { state, dormancy, goDormant } = createHarness()
    goDormant('pty')
    dormancy.cancelDormancy('pty')
    expect(dormancy.isDormant('pty')).toBe(false)
    expect(state.materialized).toEqual([])
    expect(state.handoff.has('pty')).toBe(false)
  })

  it('releases a pending handoff when the PTY is forgotten', () => {
    const { state, dormancy, goDormant } = createHarness()
    goDormant('pty')
    dormancy.noteDemand('pty')
    dormancy.forget('pty')
    expect(state.handoff.get('pty')).toBe(false)
    expect(dormancy.wasEverDormant('pty')).toBe(false)
  })

  it('keeps a pinned PTY live, wakes it on pin, and restarts the grace period on release', () => {
    const { state, dormancy, goDormant } = createHarness()
    goDormant('pty')
    const release = dormancy.pin('pty')
    expect(state.materialized).toEqual(['pty'])
    dormancy.seedSettled('pty', 0)
    state.now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS * 2
    expect(dormancy.onChunk('pty', 0)).toBe(false)
    release()
    release()
    state.now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS - 1
    expect(dormancy.onChunk('pty', 0)).toBe(false)
    state.now += 1
    expect(dormancy.onChunk('pty', 0)).toBe(true)
  })

  it('holds a pin across a PTY generation change', () => {
    const { state, dormancy } = createHarness()
    dormancy.pin('pty')
    state.generation = 2
    dormancy.onChunk('pty', 0)
    state.now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS * 2
    expect(dormancy.onChunk('pty', 0)).toBe(false)
  })

  it('ignores demand for a PTY it never saw', () => {
    const { state, dormancy } = createHarness()
    dormancy.noteDemand('unknown')
    expect(state.materialized).toEqual([])
    expect(dormancy.isDormant('unknown')).toBe(false)
  })
})

describe('chunkDataAfterSeed', () => {
  it('drops a chunk the seed fully covers', () => {
    expect(chunkDataAfterSeed('abc', 10, 3, 10)).toBe('')
    expect(chunkDataAfterSeed('abc', 9, 3, 10)).toBe('')
  })

  it('keeps a chunk that starts at or after the seed', () => {
    expect(chunkDataAfterSeed('abc', 13, 3, 10)).toBe('abc')
    expect(chunkDataAfterSeed('abc', 20, 3, 10)).toBe('abc')
  })

  it('slices a straddling chunk at the seed offset', () => {
    expect(chunkDataAfterSeed('abcdef', 13, 6, 10)).toBe('def')
  })

  it('refuses to slice a transformed chunk that straddles the seed', () => {
    expect(chunkDataAfterSeed('abcdef', 13, 8, 10)).toBeNull()
    expect(chunkDataAfterSeed('abcdef', 20, 8, 10)).toBe('abcdef')
  })
})
