import { afterEach, describe, expect, it, vi } from 'vitest'

const collect = vi.hoisted(() => vi.fn())
vi.mock('../../../../orcad/diagnostics/orcad-terminal-census', () => ({
  collectOrcadTerminalCensus: collect
}))

import { ORCAD_TERMINAL_CENSUS_METHODS } from './orcad-terminal-census'
import { TerminalUpdateAdmission } from '../../../terminal/stop/terminal-update-admission'

const handler = ORCAD_TERMINAL_CENSUS_METHODS[0]!.handler

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
})
