import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import '../../../shared/automations/scheduling/automation-schedule-occurrences'
import type { WslHostAutomationDue } from './wsl-host-automation-wake'
import {
  readWslHostAutomationWakes,
  writeWslHostAutomationWakes
} from './wsl-host-automation-wake-store'

const HOUR = 60 * 60 * 1000
const HOURLY = '0 * * * *'

/** By default the host was last seen ready an hour before the run, so the run was missed. */
function due(
  nextRunAt: number,
  graceHours = 12,
  lastSeenReadyAt = nextRunAt - HOUR
): WslHostAutomationDue {
  return {
    nextRunAt,
    wakeUntil: nextRunAt + graceHours * HOUR,
    schedules: [{ rrule: HOURLY, dtstart: 0, missedRunGraceMinutes: graceHours * 60 }],
    lastSeenReadyAt
  }
}

describe('persisted wake times', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('round-trips and drops malformed entries', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wsl-wake-'))
    writeWslHostAutomationWakes(dir, { a: due(1) })
    expect(readWslHostAutomationWakes(dir)).toEqual({ a: due(1) })
    writeFileSync(
      join(dir, 'wsl-host-automation-wakes.json'),
      JSON.stringify({ b: { nextRunAt: 1 } })
    )
    expect(readWslHostAutomationWakes(dir)).toEqual({})
    expect(readWslHostAutomationWakes(join(dir, 'missing'))).toEqual({})
  })
})
