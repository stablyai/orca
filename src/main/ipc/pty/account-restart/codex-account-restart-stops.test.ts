import { describe, expect, it, vi } from 'vitest'
import {
  CodexAccountRestartStops,
  type CodexAccountRestartStopDeps,
  type CodexRestartOccupant
} from './codex-account-restart-stops'

const pane = { worktreeId: 'wt', tabId: 'tab', leafId: 'leaf', ptyId: 'pty-a' }
const occupant: CodexRestartOccupant = {
  ptyId: 'pty-a',
  incarnationId: 'inc-a',
  provenance: {
    threadId: 'thread-1',
    transcriptPath: '/old-home/sessions/rollout-thread-1.jsonl'
  }
}

function deps(overrides: Partial<CodexAccountRestartStopDeps> = {}): CodexAccountRestartStopDeps {
  return {
    resolveOccupant: () => occupant,
    stop: vi.fn(async () => 'ended' as const),
    ...overrides
  }
}

describe('Codex account restart stop admission', () => {
  it('stops the frozen incarnation once and reports every joined op', async () => {
    const stops = new CodexAccountRestartStops()
    const d = deps()
    const result = await stops.request({ ...pane, opId: 'op-1' }, d)
    expect(d.stop).toHaveBeenCalledTimes(1)
    expect(d.stop).toHaveBeenCalledWith(occupant, expect.any(Function))
    expect(result).toEqual({ outcome: 'stopped', opIds: ['op-1'] })
  })

  it('sends zero stops for an ineligible pane', async () => {
    const stops = new CodexAccountRestartStops()
    const d = deps({ resolveOccupant: () => 'resume-unavailable' })
    const result = await stops.request({ ...pane, opId: 'op-1' }, d)
    expect(d.stop).not.toHaveBeenCalled()
    expect(result).toEqual({
      outcome: 'not-started',
      reason: 'resume-unavailable',
      opIds: ['op-1']
    })
  })

  it('rejects malformed requests without resolving the pane', async () => {
    const stops = new CodexAccountRestartStops()
    const d = deps({ resolveOccupant: vi.fn(() => occupant) })
    const result = await stops.request({ ...pane, leafId: '', opId: 'op-1' }, d)
    expect(result.outcome).toBe('not-started')
    expect(d.resolveOccupant).not.toHaveBeenCalled()
    expect(d.stop).not.toHaveBeenCalled()
  })

  it('classifies only the stamped exit of the stopped incarnation as a restart exit', async () => {
    const stops = new CodexAccountRestartStops()
    let release!: () => void
    const d = deps({
      stop: () =>
        new Promise((resolve) => {
          release = () => resolve('ended')
        })
    })
    const result = stops.request({ ...pane, opId: 'op-1' }, d)
    await Promise.resolve()
    await Promise.resolve()
    // Unstamped and other-incarnation exits keep their ordinary meaning.
    expect(stops.classifyExit('pty-a', undefined, 'stream')).toBe('ordinary')
    expect(stops.classifyExit('pty-a', 'inc-other', 'stream')).toBe('ordinary')
    expect(stops.classifyExit('pty-other', 'inc-a', 'stream')).toBe('ordinary')
    expect(stops.classifyExit('pty-a', 'inc-a', 'stream')).toBe('restart')
    release()
    await result
  })
})
