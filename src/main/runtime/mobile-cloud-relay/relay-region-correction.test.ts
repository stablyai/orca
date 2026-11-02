import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayRegionPreferenceResolver } from './relay-region-preference'
import { RelayAssignRateGate } from './relay-assign-rate-gate'
import { requestRelayAssignment } from './relay-http-client'
import type { RelayRegionWindow } from './relay-region-correction-protocol'

const paths: string[] = []
const US = 'https://us.director.example.test'
const ASIA = 'https://asia.director.example.test'
const DIRECTOR = 'https://director.example.test'
const window: RelayRegionWindow = {
  generation: 1,
  assignmentEpoch: 5,
  incumbentRegion: 'asia-east2',
  expiresAt: 1_000_000,
  policyVersion: 1
}
afterEach(() => {
  for (const path of paths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})
function resolver(us: number | null, asia: number | null, override?: string) {
  const path = mkdtempSync(join(tmpdir(), 'relay-decision-'))
  paths.push(path)
  const probe = vi.fn(async (origin: string) => (origin === US ? us : asia))
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      v: 1,
      regions: [
        { region: 'us-central1', probeOrigins: [US] },
        { region: 'asia-east2', probeOrigins: [ASIA] }
      ]
    })
  )
  return {
    path,
    probe,
    instance: new RelayRegionPreferenceResolver({
      directorUrl: DIRECTOR,
      userDataPath: path,
      probe,
      fetch,
      now: () => 0,
      diagnosticOverride: override
    })
  }
}
describe('window-bound region decisions', () => {
  it('compares against the actual incumbent despite a previous US placement cache', async () => {
    const { instance, path, probe } = resolver(50, 100)
    writeFileSync(
      join(path, 'orca-relay-region-preference.json'),
      JSON.stringify({ v: 2, directorUrl: DIRECTOR, region: 'us-central1', expiresAt: 999_999 })
    )
    expect(await instance.measureDecision(window)).toEqual({
      outcome: 'conclusive',
      measurements: { 'us-central1': 50, 'asia-east2': 100 }
    })
    expect(probe).toHaveBeenCalledTimes(8)
  })
  it.each([
    [76, 100],
    [100, 124],
    [400, 450]
  ])(
    'reports stable insufficient margins as conclusive evidence for director filtering (%i / %i)',
    async (us, asia) => {
      expect(await resolver(us, asia).instance.measureDecision(window)).toEqual({
        outcome: 'conclusive',
        measurements: { 'us-central1': us, 'asia-east2': asia }
      })
    }
  )
  it('allows the exact inclusive 25ms and 20 percent boundary', async () => {
    expect(await resolver(100, 125).instance.measureDecision(window)).toMatchObject({
      outcome: 'conclusive'
    })
  })
  it('does not certify a lone measurable region', async () => {
    expect(await resolver(40, null).instance.measureDecision(window)).toEqual({
      outcome: 'inconclusive',
      reason: 'incomplete-measurement'
    })
  })
  it('never converts diagnostic overrides into measured eligibility', async () => {
    const { instance, probe } = resolver(40, 100, 'us-central1')
    expect(await instance.measureDecision(window)).toEqual({
      outcome: 'inconclusive',
      reason: 'diagnostic-override'
    })
    expect(probe).not.toHaveBeenCalled()
  })
  it('invalidates legacy placement caches on upgrade', async () => {
    const { instance, path, probe } = resolver(40, 100)
    writeFileSync(
      join(path, 'orca-relay-region-preference.json'),
      JSON.stringify({ v: 1, directorUrl: DIRECTOR, region: 'asia-east2', expiresAt: 999_999 })
    )
    expect(await instance.resolve()).toBe('us-central1')
    expect(probe).toHaveBeenCalledTimes(8)
  })
  it('falls back from a strict old director without dropping the cold-start hint', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(
        Response.json({ v: 1, cellUrl: ASIA, assignmentEpoch: 1, lease: 'synthetic' })
      )
    const result = await requestRelayAssignment({
      directorUrl: DIRECTOR,
      relayHostId: 'synthetic-host',
      relayToken: 'synthetic-token',
      preferredRegion: 'asia-east2',
      reconnect: true,
      regionCorrection: { v: 1, action: 'issue-window' },
      fetch,
      assignRateGate: new RelayAssignRateGate()
    })
    expect(result.cellUrl).toBe(ASIA)
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({
      v: 1,
      relayHostId: 'synthetic-host',
      preferredRegion: 'asia-east2',
      reconnect: true
    })
    expect(result.regionCorrection).toBeUndefined()
  })
})
