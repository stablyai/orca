import { describe, expect, it } from 'vitest'
import {
  getProcessGoneDedupeKey,
  getProcessGoneIncidentDedupeKey,
  ProcessGoneDedupe,
  ProcessGoneIncidentDedupe
} from './process-gone-dedupe'

describe('ProcessGoneDedupe', () => {
  it('suppresses duplicate keys inside the dedupe window', () => {
    const dedupe = new ProcessGoneDedupe({ windowMs: 2_000 })
    const key = getProcessGoneDedupeKey('GPU', 'crashed', 5)

    expect(dedupe.shouldRecord(key, 1_000)).toBe(true)
    expect(dedupe.shouldRecord(key, 2_999)).toBe(false)
    expect(dedupe.shouldRecord(key, 3_000)).toBe(true)
  })

  it('prunes stale keys outside the dedupe window', () => {
    const dedupe = new ProcessGoneDedupe({ windowMs: 2_000 })

    expect(dedupe.shouldRecord('a', 1_000)).toBe(true)
    expect(dedupe.shouldRecord('b', 1_500)).toBe(true)
    expect(dedupe.shouldRecord('c', 3_000)).toBe(true)

    expect(dedupe.size).toBe(2)
  })

  it('bounds unique keys during crash storms', () => {
    const dedupe = new ProcessGoneDedupe({ windowMs: 60_000, maxKeys: 3 })

    expect(dedupe.shouldRecord('a', 1_000)).toBe(true)
    expect(dedupe.shouldRecord('b', 1_001)).toBe(true)
    expect(dedupe.shouldRecord('c', 1_002)).toBe(true)
    expect(dedupe.shouldRecord('d', 1_003)).toBe(true)

    expect(dedupe.size).toBe(3)
    expect(dedupe.shouldRecord('a', 1_004)).toBe(true)
  })
})

describe('ProcessGoneIncidentDedupe', () => {
  const duplicateOomReport = {
    source: 'renderer' as const,
    processType: 'renderer',
    reason: 'oom',
    exitCode: -536870904,
    details: { processMetricsLargestPid: 55460 }
  }

  it('reproduces the 1.4.45 duplicate Windows OOM pair and suppresses the second report', () => {
    const dedupe = new ProcessGoneIncidentDedupe({ windowMs: 5 * 60_000 })

    expect(dedupe.shouldRecord(duplicateOomReport, 1_780_567_568_390)).toBe(true)
    // 2026-06-04 10:06:08Z -> 10:07:58Z: same largest PID, outside the old 2s event window.
    expect(dedupe.shouldRecord(duplicateOomReport, 1_780_567_678_050)).toBe(false)
  })

  it('records renderer incidents with a different largest process pid', () => {
    const dedupe = new ProcessGoneIncidentDedupe({ windowMs: 5 * 60_000 })

    expect(dedupe.shouldRecord(duplicateOomReport, 1_000)).toBe(true)
    expect(
      dedupe.shouldRecord(
        {
          ...duplicateOomReport,
          details: { processMetricsLargestPid: 55461 }
        },
        2_000
      )
    ).toBe(true)
  })

  it('prefers webContentsId over largest process pid when renderer identity is available', () => {
    const dedupe = new ProcessGoneIncidentDedupe({ windowMs: 5 * 60_000 })

    expect(
      dedupe.shouldRecord(
        {
          ...duplicateOomReport,
          details: { processMetricsLargestPid: 55460, webContentsId: 4 }
        },
        1_000
      )
    ).toBe(true)
    expect(
      dedupe.shouldRecord(
        {
          ...duplicateOomReport,
          details: { processMetricsLargestPid: 55460, webContentsId: 5 }
        },
        2_000
      )
    ).toBe(true)
    expect(
      dedupe.shouldRecord(
        {
          ...duplicateOomReport,
          details: { processMetricsLargestPid: 55461, webContentsId: 4 }
        },
        3_000
      )
    ).toBe(false)
  })

  it('does not incident-dedupe recoverable child process churn or reports without a pid', () => {
    expect(
      getProcessGoneIncidentDedupeKey({
        source: 'child',
        processType: 'GPU',
        reason: 'killed',
        exitCode: 9,
        details: { processMetricsLargestPid: 55460 }
      })
    ).toBeNull()
    expect(
      getProcessGoneIncidentDedupeKey({
        ...duplicateOomReport,
        details: {}
      })
    ).toBeNull()
  })
})
