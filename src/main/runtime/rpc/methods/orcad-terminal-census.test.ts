import { afterEach, describe, expect, it, vi } from 'vitest'

const collect = vi.hoisted(() => vi.fn())
vi.mock('../../../orcad/orcad-terminal-census', () => ({ collectOrcadTerminalCensus: collect }))

import { ORCAD_TERMINAL_CENSUS_METHODS } from './orcad-terminal-census'
import { TerminalUpdateAdmission } from '../../terminal/stop/terminal-update-admission'

const handler = ORCAD_TERMINAL_CENSUS_METHODS[0]!.handler
const idle = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 7 }

function call(
  params: Record<string, unknown>,
  released: number,
  terminalUpdateAdmission = new TerminalUpdateAdmission(async () => [])
) {
  const runtime = {
    releaseFinishedAutomationRunTerminals: vi.fn(async () => released),
    terminalUpdateAdmission
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the runtime member faked above.
  const result = handler({ activatedAt: 1, ...params } as never, { runtime } as never)
  return { runtime, result }
}

afterEach(() => {
  vi.useRealTimers()
  collect.mockReset()
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

  it('answers unverifiable, still closed, when a spawn started before the close never settles', async () => {
    vi.useFakeTimers()
    const admission = new TerminalUpdateAdmission(async () => [])
    await admission.admit(undefined)
    const { result } = call({ closeAdmissionForMs: 60_000 }, 0, admission)
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(result).resolves.toMatchObject({
      liveSessions: null,
      admissionClosedUntil: expect.any(Number)
    })
    expect(collect).not.toHaveBeenCalled()
    expect(admission.isClosed()).toBe(true)
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
