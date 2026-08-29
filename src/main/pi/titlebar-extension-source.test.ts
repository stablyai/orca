import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHarness } from './titlebar-extension-test-harness'

describe('generated titlebar spinner extension', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers no hooks outside an Orca pane', () => {
    expect(createHarness({ paneKey: undefined }).handlers).toEqual({})
  })

  it('animates the title through a turn and restores the base title on agent_end', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await vi.advanceTimersByTimeAsync(240)

    expect(harness.titles).toEqual([
      '⠋ π - work - project',
      '⠙ π - work - project',
      '⠹ π - work - project'
    ])

    await harness.callHook('agent_end')
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.titles.at(-1)).toBe('π - work - project')
  })

  // The reported crash: getSessionName() ran on every frame, so a session
  // replacement mid-turn threw out of a timer callback and killed the agent.
  it('never reads the session handle from inside the animation frame', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    const readsAfterStart = harness.getSessionName.mock.calls.length
    expect(readsAfterStart).toBe(1)

    await vi.advanceTimersByTimeAsync(4000)
    expect(harness.titles.length).toBeGreaterThan(40)
    expect(harness.getSessionName).toHaveBeenCalledTimes(readsAfterStart)
  })

  it('unbinds on session_start before any frame can run against the replaced ctx', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await vi.advanceTimersByTimeAsync(80)
    expect(vi.getTimerCount()).toBe(1)

    await harness.callHook('session_start')
    expect(vi.getTimerCount()).toBe(0)

    const titlesAtReplacement = harness.titles.length
    await vi.advanceTimersByTimeAsync(800)
    expect(harness.titles.length).toBe(titlesAtReplacement)
  })

  it('re-arms the spinner on the next turn after a session replacement', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    await vi.advanceTimersByTimeAsync(80)
    await harness.callHook('session_start')
    harness.reviveHandle('forked')

    const replacementCtx = { ui: { setTitle: vi.fn() } }
    await harness.callHook('agent_start', replacementCtx)
    await vi.advanceTimersByTimeAsync(160)

    expect(vi.getTimerCount()).toBe(1)
    expect(replacementCtx.ui.setTitle.mock.calls.map(([title]) => title)).toEqual([
      '⠋ π - forked - project',
      '⠙ π - forked - project'
    ])
  })

  it('unbinds instead of crashing when a frame writes through a replaced ctx', async () => {
    const harness = createHarness()
    const staleCtx = harness.createStaleContext()

    await harness.callHook('agent_start', staleCtx)
    // A throw from the frame surfaces here as a rejection — and in production as
    // the uncaughtException that took the whole agent process down.
    await vi.advanceTimersByTimeAsync(80)

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(800)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('degrades to a cwd-only title when the captured handle goes stale, without re-probing it', async () => {
    const harness = createHarness({ sessionName: undefined })
    harness.staleHandle()

    await harness.callHook('agent_start')
    await vi.advanceTimersByTimeAsync(160)

    expect(harness.titles).toEqual(['⠋ π - project', '⠙ π - project'])
    // Latched after the first throw: a dead handle is not retried every turn boundary.
    expect(harness.getSessionName).toHaveBeenCalledTimes(1)

    await harness.callHook('agent_end')
    expect(harness.titles.at(-1)).toBe('π - project')
    expect(harness.getSessionName).toHaveBeenCalledTimes(1)
  })

  it('keeps the last known session name when the handle goes stale mid-turn', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')
    harness.staleHandle()
    await vi.advanceTimersByTimeAsync(80)

    await harness.callHook('agent_end')
    expect(harness.titles.at(-1)).toBe('π - work - project')
  })

  it('settles session_shutdown when both the handle and the ctx are already stale', async () => {
    const harness = createHarness()
    harness.staleHandle()

    await expect(
      harness.callHook('session_shutdown', harness.createStaleContext())
    ).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unrefs the animation interval so it cannot hold a shutting-down agent alive', async () => {
    const harness = createHarness()

    await harness.callHook('agent_start')

    expect(harness.intervalUnrefs).toHaveLength(1)
    expect(harness.intervalUnrefs[0]).toHaveBeenCalledTimes(1)
  })
})
