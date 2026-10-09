import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { PROVEN_ABSENT_LEAF_PTY_TTL_MS as TTL_MS } from './orca-runtime-core'

type VerdictInternals = {
  provenAbsentLeafPtyVerdicts: Map<string, number>
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
}

function createRuntime(
  probePtyLiveness = vi.fn<(ptyId: string) => Promise<boolean | null>>(async () => false)
) {
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    hasPty: (id) => id === 'live',
    probePtyLiveness
  })
  const internals = runtime as unknown as VerdictInternals
  return {
    runtime,
    probe: probePtyLiveness,
    verdicts: internals.provenAbsentLeafPtyVerdicts,
    isAbsent: (id: string) => internals.isLeafPtyProvenAbsent(id)
  }
}

afterEach(() => vi.restoreAllMocks())

describe('leaf PTY verdict expiry', () => {
  it('retires old unique IDs on a live-PTY consult without probing that live PTY', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const { verdicts, isAbsent, probe } = createRuntime()
    for (let index = 0; index < 1_000; index++) {
      await expect(isAbsent(`retired-${index}`)).resolves.toBe(true)
    }
    expect(verdicts.size).toBe(1_000)
    now.mockReturnValue(100_000 + TTL_MS)

    await expect(isAbsent('live')).resolves.toBe(false)

    expect(verdicts.size).toBe(0)
    expect(probe).toHaveBeenCalledTimes(1_000)
  })

  it('preserves every fresh verdict and the exact per-key TTL between bulk sweeps', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const { verdicts, isAbsent, probe } = createRuntime()
    await isAbsent('initial')
    now.mockReturnValue(101_000)
    for (let index = 0; index < 1_000; index++) {
      await isAbsent(`fresh-${index}`)
    }
    now.mockReturnValue(100_000 + TTL_MS)
    await isAbsent('live')
    expect(verdicts.size).toBe(1_000)
    now.mockReturnValue(101_000 + TTL_MS - 1)
    probe.mockClear()
    for (let index = 0; index < 1_000; index++) {
      await expect(isAbsent(`fresh-${index}`)).resolves.toBe(true)
    }
    expect(probe).not.toHaveBeenCalled()
    now.mockReturnValue(101_000 + TTL_MS)
    probe.mockResolvedValue(null)

    await expect(isAbsent('fresh-0')).resolves.toBe(false)

    expect(probe).toHaveBeenCalledOnce()
    expect(verdicts.has('fresh-0')).toBe(false)
  })

  it('sweeps at most once per TTL through a burst of probes and live sends', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const { verdicts, isAbsent } = createRuntime()
    const iterations = vi.spyOn(verdicts, Symbol.iterator)
    for (let index = 0; index < 1_000; index++) {
      await isAbsent(`dead-${index}`)
      await isAbsent('live')
    }
    expect(iterations).toHaveBeenCalledOnce()
    now.mockReturnValue(100_000 + TTL_MS)
    for (let index = 0; index < 1_000; index++) {
      await isAbsent('live')
    }
    expect(iterations).toHaveBeenCalledTimes(2)
    expect(verdicts.size).toBe(0)
  })

  it('cleans old entries when a delayed probe completes after the next sweep is due', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const { verdicts, isAbsent, probe } = createRuntime()
    await isAbsent('old')
    let finish!: (value: boolean | null) => void
    probe.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const pending = isAbsent('new')
    now.mockReturnValue(100_000 + 2 * TTL_MS)
    finish(false)

    await expect(pending).resolves.toBe(true)

    expect([...verdicts]).toEqual([['new', 100_000 + 2 * TTL_MS]])
  })

  it('resumes pruning after a backward clock adjustment without expiring future-dated evidence', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const { verdicts, isAbsent, probe } = createRuntime()
    await isAbsent('future-dated')
    now.mockReturnValue(1_000)
    await isAbsent('after-clock-change')
    now.mockReturnValue(1_000 + TTL_MS)

    await isAbsent('live')

    expect([...verdicts]).toEqual([['future-dated', 100_000]])
    await expect(isAbsent('future-dated')).resolves.toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('leaves unverifiable probes uncached and preserves concurrent probe coalescing', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    let finish!: (value: boolean | null) => void
    const probe = vi.fn(() => new Promise<boolean | null>((resolve) => (finish = resolve)))
    const { verdicts, isAbsent } = createRuntime(probe)
    const first = isAbsent('ssh-id')
    const second = isAbsent('ssh-id')
    expect(first).toBe(second)
    finish(null)
    await expect(first).resolves.toBe(false)
    expect(verdicts.size).toBe(0)
    probe.mockRejectedValueOnce(new Error('host unavailable'))
    await expect(isAbsent('ssh-id')).resolves.toBe(false)
    expect(verdicts.size).toBe(0)
  })
})
