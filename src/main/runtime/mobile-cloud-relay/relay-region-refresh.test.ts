import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayAssignment } from './relay-http-client'
import type * as RelayHttpClientModule from './relay-http-client'
import type { RelayRegionWindow } from './relay-region-correction-protocol'
const fake = vi.hoisted(() => ({ assign: vi.fn() }))
vi.mock('./relay-http-client', async (original) => ({
  ...(await original<typeof RelayHttpClientModule>()),
  requestRelayAssignment: fake.assign
}))
import { RelayRegionRefresh } from './relay-region-refresh'
const HOUR = 60 * 60_000
const window: RelayRegionWindow = {
  generation: 1,
  assignmentEpoch: 1,
  incumbentRegion: 'asia-east2',
  expiresAt: 24 * HOUR,
  policyVersion: 1
}
const assignment: RelayAssignment = {
  v: 1,
  cellUrl: 'https://source.example.test',
  assignmentEpoch: 1,
  lease: 'test',
  regionCorrection: { v: 1, window }
}
let scheduler: RelayRegionRefresh
function setup(random = 0.5) {
  const measure = vi.fn().mockResolvedValue({
    outcome: 'conclusive',
    measurements: { 'us-central1': 30, 'asia-east2': 200 }
  })
  const applyAssignment = vi.fn(() => true)
  const isOnline = vi.fn(() => true)
  scheduler = new RelayRegionRefresh({
    directorUrl: 'https://director.example.test',
    relayHostId: 'test-host',
    token: () => 'test-token',
    assignment: () => assignment,
    isCurrent: () => true,
    isOnline,
    applyAssignment,
    measure,
    random: () => random,
    now: () => Date.now()
  })
  return { measure, applyAssignment, isOnline }
}
describe('broker-owned region decision refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    fake.assign.mockReset()
  })
  afterEach(() => {
    scheduler?.close()
    vi.useRealTimers()
  })

  it('retries exactly the same report without probing or extending its window', async () => {
    const { measure } = setup()
    fake.assign
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ...assignment, regionCorrection: { v: 1, reportStatus: 'accepted' } })
    scheduler.start(assignment)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(measure).toHaveBeenCalledOnce()
    expect(fake.assign).toHaveBeenCalledTimes(2)
    expect(fake.assign.mock.calls[0]![0].regionCorrection).toEqual(
      fake.assign.mock.calls[1]![0].regionCorrection
    )
  })

  it('does not report a measurement that completed after broker close', async () => {
    const { measure } = setup()
    let resolve!: (value: unknown) => void
    measure.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    scheduler.start(assignment)
    scheduler.close()
    resolve({ outcome: 'inconclusive', reason: 'incomplete-measurement' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.assign).not.toHaveBeenCalled()
  })
  it('uses a successor window after an expired report retry', async () => {
    setup()
    fake.assign.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      ...assignment,
      regionCorrection: { v: 1, window: { ...window, generation: 2, expiresAt: 48 * HOUR } }
    })
    scheduler.start(assignment)
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(25 * HOUR)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.assign.mock.calls[1]![0].regionCorrection).toEqual({ v: 1, action: 'issue-window' })
  })
})
