import { describe, expect, it, vi } from 'vitest'
import {
  CodexAccountRestartStops,
  codexAccountRestartPaneKey,
  type CodexAccountRestartStopDeps,
  type CodexRestartStopOutcome
} from './codex-account-restart-stops'

const pane = { worktreeId: 'wt', tabId: 'tab', leafId: 'leaf' }
const paneKey = codexAccountRestartPaneKey(pane)
const session = { key: 'session_id' as const, id: 'thread-1' }

function heldStopDeps() {
  let release!: (outcome: CodexRestartStopOutcome) => void
  const stop = vi.fn(
    () =>
      new Promise<CodexRestartStopOutcome>((resolve) => {
        release = resolve
      })
  )
  const deps: CodexAccountRestartStopDeps = {
    resolveOccupant: () => ({
      ptyId: 'pty-a',
      incarnationId: 'inc-a',
      provenance: { threadId: 'thread-1', transcriptPath: '/old/rollout.jsonl' }
    }),
    stop
  }
  return { deps, stop, release: (outcome: CodexRestartStopOutcome) => release(outcome) }
}

const request = (opId: string) => ({ ...pane, ptyId: 'pty-a', opId })

describe('account restart stop admission races', () => {
  it('a double click joins the stop in flight and both clicks get its result', async () => {
    const stops = new CodexAccountRestartStops()
    const { deps, stop, release } = heldStopDeps()
    const first = stops.request(request('op-a'), deps)
    const second = stops.request(request('op-b'), deps)
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    // A click that lands after the stop was dispatched joins it too.
    const third = stops.request(request('op-c'), deps)
    release('ended')
    const expected = { outcome: 'stopped', opIds: ['op-a', 'op-b', 'op-c'] }
    await expect(first).resolves.toEqual(expected)
    await expect(second).resolves.toEqual(expected)
    await expect(third).resolves.toEqual(expected)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('a Dismiss before the stop is authorized sends zero stops', async () => {
    const stops = new CodexAccountRestartStops()
    const { deps, stop } = heldStopDeps()
    const result = stops.request(request('op-a'), deps)
    expect(stops.withdraw({ ...pane, opId: 'op-a' })).toBe(true)
    await expect(result).resolves.toEqual({
      outcome: 'not-started',
      reason: 'withdrawn',
      opIds: ['op-a']
    })
    expect(stop).not.toHaveBeenCalled()
    await expect(stops.resolveResume({ paneKey, providerSession: session })).resolves.toEqual({
      kind: 'none'
    })
  })

  it('a Dismiss during a dispatched stop lets it settle but keeps the old account', async () => {
    const stops = new CodexAccountRestartStops()
    const { deps, stop, release } = heldStopDeps()
    const result = stops.request(request('op-a'), deps)
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    expect(stops.withdraw({ ...pane, opId: 'op-a' })).toBe(true)
    release('ended')
    await expect(result).resolves.toMatchObject({ outcome: 'stopped' })
    await expect(stops.resolveResume({ paneKey, providerSession: session })).resolves.toEqual({
      kind: 'pinned'
    })
  })

  it('a Dismiss after the stop settled still keeps the old account for the resume', async () => {
    const stops = new CodexAccountRestartStops()
    const { deps, release } = heldStopDeps()
    const result = stops.request(request('op-a'), deps)
    await Promise.resolve()
    await Promise.resolve()
    release('ended')
    await result
    expect(stops.withdraw({ ...pane, opId: 'op-a' })).toBe(true)
    await expect(stops.resolveResume({ paneKey, providerSession: session })).resolves.toEqual({
      kind: 'pinned'
    })
  })

  it('a stale Dismiss for another operation or pane changes nothing', async () => {
    const stops = new CodexAccountRestartStops()
    const { deps, stop, release } = heldStopDeps()
    const result = stops.request(request('op-a'), deps)
    expect(stops.withdraw({ ...pane, opId: 'op-old' })).toBe(false)
    expect(stops.withdraw({ ...pane, leafId: 'other-leaf', opId: 'op-a' })).toBe(false)
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    release('ended')
    await result
    await expect(stops.resolveResume({ paneKey, providerSession: session })).resolves.toMatchObject(
      { kind: 'selected' }
    )
  })

  it('a click after Dismiss during the same stop is the newer answer', async () => {
    const stops = new CodexAccountRestartStops()
    const { deps, stop, release } = heldStopDeps()
    const result = stops.request(request('op-a'), deps)
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    stops.withdraw({ ...pane, opId: 'op-a' })
    void stops.request(request('op-b'), deps)
    release('ended')
    await expect(result).resolves.toEqual({ outcome: 'stopped', opIds: ['op-a', 'op-b'] })
    await expect(stops.resolveResume({ paneKey, providerSession: session })).resolves.toMatchObject(
      { kind: 'selected' }
    )
  })

  it('a pane that turned over before authorization sends zero stops', async () => {
    const stops = new CodexAccountRestartStops()
    const { deps, stop } = heldStopDeps()
    let occupant = deps.resolveOccupant(request('op-a'))
    const turning: CodexAccountRestartStopDeps = {
      ...deps,
      resolveOccupant: () => occupant
    }
    const result = stops.request(request('op-a'), turning)
    occupant = 'superseded'
    await expect(result).resolves.toMatchObject({ outcome: 'not-started', reason: 'superseded' })
    expect(stop).not.toHaveBeenCalled()
  })
})
