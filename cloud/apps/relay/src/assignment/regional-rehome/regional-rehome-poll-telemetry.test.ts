import { describe, expect, it } from 'vitest'
import {
  REGIONAL_REHOME_POLL_SUMMARY_INTERVAL_MS,
  RegionalRehomePollTelemetry
} from './regional-rehome-poll-telemetry.js'

describe('regional rehome poll telemetry', () => {
  it('names the gate that stopped the poll, not just the empty result', () => {
    const lines: string[] = []
    const telemetry = new RegionalRehomePollTelemetry((line) => lines.push(line))
    let now = 1_000
    for (let poll = 0; poll < 3; poll++) {
      telemetry.record({ now: (now += 6_000), gate: 'budget-closed', candidates: 0 })
    }
    telemetry.record({ now: (now += 6_000), gate: 'open', candidates: 0, selectionMs: 12 })
    expect(lines).toEqual([])
    telemetry.record({
      now: now + REGIONAL_REHOME_POLL_SUMMARY_INTERVAL_MS,
      gate: 'open',
      candidates: 7,
      selectionMs: 30
    })
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'orca_relay_regional_rehome_poll_summary',
      polls: 5,
      'budget-closed': 3,
      open: 2,
      candidates: 7,
      selectionMsMax: 30
    })
  })

  it('starts a fresh window after each summary', () => {
    const lines: string[] = []
    const telemetry = new RegionalRehomePollTelemetry((line) => lines.push(line))
    telemetry.record({ now: 0, gate: 'control-closed', candidates: 0 })
    telemetry.record({
      now: REGIONAL_REHOME_POLL_SUMMARY_INTERVAL_MS,
      gate: 'control-closed',
      candidates: 0
    })
    telemetry.record({
      now: REGIONAL_REHOME_POLL_SUMMARY_INTERVAL_MS * 2,
      gate: 'fleet-safety',
      candidates: 0
    })
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!)).toMatchObject({
      polls: 1,
      'control-closed': 0,
      'fleet-safety': 1,
      candidates: 0,
      selectionMsMax: 0,
      selectionMsP95: 0
    })
  })
})
