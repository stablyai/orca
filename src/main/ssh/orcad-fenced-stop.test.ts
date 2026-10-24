import { describe, expect, it, vi } from 'vitest'
import { ORCAD_UPDATE_ADMISSION_STOP_BY_MS } from '../../shared/orcad-terminal-census'
import { runFencedStop, type FencedStop } from './orcad-fenced-stop'

const idle = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 }

function fence(overrides: Partial<FencedStop<string, string>> = {}) {
  let clock = 1_000
  const steps: FencedStop<string, string> = {
    recountCensus: vi.fn(async () => idle),
    releaseIncumbentAdmission: vi.fn(async () => {}),
    now: () => clock,
    refuse: (census) => (census.liveSessions === 0 ? null : 'live'),
    prepare: vi.fn(async () => {}),
    stale: () => 'stale',
    stop: vi.fn(async () => 'stopped'),
    stopMayHaveBeenSent: (stopped) => stopped !== 'withdrawn',
    ...overrides
  }
  return { steps, advance: (ms: number) => (clock += ms) }
}

describe('runFencedStop', () => {
  it('counts, prepares and stops, keeping admission closed through a sent stop', async () => {
    const { steps } = fence()
    await expect(runFencedStop(steps)).resolves.toEqual({ stopped: 'stopped' })
    expect(steps.releaseIncumbentAdmission).not.toHaveBeenCalled()
  })

  it.each([
    ['the count refuses', { recountCensus: async () => ({ ...idle, liveSessions: 1 }) }, 'live'],
    ['the count fails', { recountCensus: () => Promise.reject(new Error('gone')) }, 'live']
  ])('reopens and stops nothing when %s', async (_case, overrides, refused) => {
    const { steps } = fence(overrides)
    await expect(runFencedStop(steps)).resolves.toEqual({ refused })
    expect(steps.stop).not.toHaveBeenCalled()
    expect(steps.releaseIncumbentAdmission).toHaveBeenCalledOnce()
  })

  it('reopens and rethrows when the step before the stop fails', async () => {
    const { steps } = fence({ prepare: () => Promise.reject(new Error('disk full')) })
    await expect(runFencedStop(steps)).rejects.toThrow('disk full')
    expect(steps.stop).not.toHaveBeenCalled()
    expect(steps.releaseIncumbentAdmission).toHaveBeenCalledOnce()
  })

  it('stops nothing once the count may have outlived its fence', async () => {
    const box: { advance?: (ms: number) => void } = {}
    const made = fence({
      prepare: async () => box.advance?.(ORCAD_UPDATE_ADMISSION_STOP_BY_MS + 1)
    })
    box.advance = made.advance
    await expect(runFencedStop(made.steps)).resolves.toEqual({ refused: 'stale' })
    expect(made.steps.stop).not.toHaveBeenCalled()
    expect(made.steps.releaseIncumbentAdmission).toHaveBeenCalledOnce()
  })

  it('reopens after a stop that was never sent, and not after one that throws', async () => {
    const withdrawn = fence({ stop: async () => 'withdrawn' })
    await runFencedStop(withdrawn.steps)
    expect(withdrawn.steps.releaseIncumbentAdmission).toHaveBeenCalledOnce()

    const thrown = fence({ stop: () => Promise.reject(new Error('SSH timed out')) })
    await expect(runFencedStop(thrown.steps)).rejects.toThrow('SSH timed out')
    // The stop may still be on its way; admission lapses on its own instead.
    expect(thrown.steps.releaseIncumbentAdmission).not.toHaveBeenCalled()
  })
})
