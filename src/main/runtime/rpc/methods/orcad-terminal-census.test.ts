import { afterEach, describe, expect, it, vi } from 'vitest'

const collect = vi.hoisted(() => vi.fn())
vi.mock('../../../orcad/orcad-terminal-census', () => ({ collectOrcadTerminalCensus: collect }))

import {
  closeTerminalAdmission,
  isTerminalAdmissionClosed,
  runAdmittedTerminalSpawn
} from '../../terminal-admission-fence'
import { ORCAD_TERMINAL_CENSUS_METHODS } from './orcad-terminal-census'

const handler = ORCAD_TERMINAL_CENSUS_METHODS[0]!.handler
const idle = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 7 }

function call(params: Record<string, unknown>, released: number) {
  const runtime = { releaseFinishedAutomationRunTerminals: vi.fn(async () => released) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the runtime member faked above.
  const result = handler({ activatedAt: 1, ...params } as never, { runtime } as never)
  return { runtime, result }
}

afterEach(() => {
  vi.useRealTimers()
  collect.mockReset()
  closeTerminalAdmission(0)
})

describe('orcad.terminalCensus', () => {
  it('lets an update through on a host whose only terminals are finished automation shells', async () => {
    vi.useFakeTimers()
    // Three idle run shells, closed by the release; the daemon drops them a moment later.
    collect
      .mockResolvedValueOnce({ ...idle, liveSessions: 3 })
      .mockResolvedValueOnce({ ...idle, liveSessions: 3 })
      .mockResolvedValue(idle)
    const { runtime, result } = call({ releaseFinishedAutomationTerminals: true }, 3)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(result).resolves.toEqual(idle)
    expect(runtime.releaseFinishedAutomationRunTerminals).toHaveBeenCalledOnce()
  })

  it('closes terminal admission before counting, says until when, and reopens on 0 (R32)', async () => {
    let admissionClosedWhileCounting = false
    collect.mockImplementation(async () => {
      admissionClosedWhileCounting = isTerminalAdmissionClosed()
      return idle
    })
    const fenced = await call({ closeAdmissionForMs: 60_000 }, 0).result
    expect(admissionClosedWhileCounting).toBe(true)
    expect(fenced).toMatchObject({ ...idle, admissionClosedUntil: expect.any(Number) })
    expect(isTerminalAdmissionClosed()).toBe(true)

    await expect(call({ closeAdmissionForMs: 0 }, 0).result).resolves.toMatchObject({
      admissionClosedUntil: 0
    })
    expect(isTerminalAdmissionClosed()).toBe(false)
    // A census that asks nothing about admission reports nothing about it.
    await expect(call({}, 0).result).resolves.toEqual(idle)
  })

  it('counts only after a spawn admitted before the fence has started, and refuses later ones', async () => {
    collect.mockResolvedValue({ ...idle, liveSessions: 1 })
    let finishSpawn: () => void = () => {}
    const inFlight = runAdmittedTerminalSpawn(
      () => {},
      () => new Promise<void>((resolve) => (finishSpawn = resolve))
    )
    await Promise.resolve()
    const census = call({ closeAdmissionForMs: 60_000 }, 0).result
    await Promise.resolve()
    expect(collect).not.toHaveBeenCalled()
    // A spawn arriving after the fence closed is refused at its start.
    await expect(
      runAdmittedTerminalSpawn(
        () => {
          if (isTerminalAdmissionClosed()) {
            throw new Error('refused')
          }
        },
        async () => {}
      )
    ).rejects.toThrow('refused')
    finishSpawn()
    await inFlight
    await expect(census).resolves.toMatchObject({ liveSessions: 1 })
  })

  it('answers unverifiable, still fenced, when an admitted spawn never settles', async () => {
    vi.useFakeTimers()
    const stuck = runAdmittedTerminalSpawn(
      () => {},
      () => new Promise<void>(() => {})
    )
    void stuck
    const census = call({ closeAdmissionForMs: 60_000 }, 0).result
    await vi.advanceTimersByTimeAsync(10_001)
    await expect(census).resolves.toMatchObject({
      liveSessions: null,
      admissionClosedUntil: expect.any(Number)
    })
    expect(collect).not.toHaveBeenCalled()
  })

  it('still counts terminals it may not close, and closes nothing for a plain census', async () => {
    collect.mockResolvedValue({ ...idle, liveSessions: 2 })
    const plain = call({}, 0)
    await expect(plain.result).resolves.toMatchObject({ liveSessions: 2 })
    expect(plain.runtime.releaseFinishedAutomationRunTerminals).not.toHaveBeenCalled()

    // A used or adopted shell is never released, so the update still sees it running.
    const update = call({ releaseFinishedAutomationTerminals: true }, 0)
    await expect(update.result).resolves.toMatchObject({ liveSessions: 2 })
  })
})
