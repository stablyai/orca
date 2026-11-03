import { afterEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_SESSION as SESSION,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { structuredStatusSummariesEqual } from './structured-agent-session-status-summary-equality'

let rig: RestTestRig | undefined
afterEach(async () => {
  await rig?.dispose()
  vi.restoreAllMocks()
})

it('publishes schedule-only changes to the summary and distinguishes its identity and state', async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  await foundRestTestChat(rig)
  const summary = rig.host.readStatusSummary(SESSION)!
  const usageLimitContinue = { turnItemId: 'cut', resetsAt: 50_000, state: 'scheduled' as const }
  vi.spyOn(rig.host.usageLimitContinue, 'readState').mockReturnValue(usageLimitContinue)
  rig.host.publishWorkChanged(SESSION)
  const scheduled = rig.host.readStatusSummary(SESSION)!
  expect(scheduled.usageLimitContinue).toEqual(usageLimitContinue)
  expect(rig.statusEvents.at(-1)).toMatchObject({ type: 'status', session: { usageLimitContinue } })
  expect(structuredStatusSummariesEqual(summary, scheduled)).toBe(false)
  expect(
    structuredStatusSummariesEqual(scheduled, {
      ...scheduled,
      usageLimitContinue: { ...usageLimitContinue }
    })
  ).toBe(true)
  for (const difference of [
    { turnItemId: 'new' },
    { resetsAt: 60_000 },
    { state: 'cancelled' as const },
    { state: 'failed' as const },
    { state: 'off' as const }
  ]) {
    expect(
      structuredStatusSummariesEqual(scheduled, {
        ...scheduled,
        usageLimitContinue: { ...usageLimitContinue, ...difference }
      })
    ).toBe(false)
  }
})
