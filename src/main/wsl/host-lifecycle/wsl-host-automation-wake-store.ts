import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WslHostAutomationDue, WslHostAutomationSchedule } from './wsl-host-automation-wake'

const FILE_NAME = 'wsl-host-automation-wakes.json'

export function readWslHostAutomationWakes(
  userDataPath: string
): Record<string, WslHostAutomationDue> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(userDataPath, FILE_NAME), 'utf8'))
    const due: Record<string, WslHostAutomationDue> = {}
    if (parsed && typeof parsed === 'object') {
      for (const [environmentId, value] of Object.entries(parsed)) {
        const entry = parseDue(value)
        if (entry) {
          due[environmentId] = entry
        }
      }
    }
    return due
  } catch {
    return {}
  }
}

function parseDue(value: unknown): WslHostAutomationDue | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('nextRunAt' in value) ||
    !('wakeUntil' in value) ||
    !('schedules' in value) ||
    typeof value.nextRunAt !== 'number' ||
    typeof value.wakeUntil !== 'number' ||
    !Array.isArray(value.schedules)
  ) {
    return null
  }
  const schedules = value.schedules.flatMap((schedule: unknown): WslHostAutomationSchedule[] =>
    schedule &&
    typeof schedule === 'object' &&
    'rrule' in schedule &&
    'dtstart' in schedule &&
    'missedRunGraceMinutes' in schedule &&
    typeof schedule.rrule === 'string' &&
    typeof schedule.dtstart === 'number' &&
    typeof schedule.missedRunGraceMinutes === 'number'
      ? [
          {
            rrule: schedule.rrule,
            dtstart: schedule.dtstart,
            missedRunGraceMinutes: schedule.missedRunGraceMinutes
          }
        ]
      : []
  )
  // A file from before lastSeenReadyAt: the host was up when its run was learned, so that run counts as
  // run there; a later one due since still wakes it. Never boots for a time it may already have run.
  const lastSeenReadyAt =
    'lastSeenReadyAt' in value && typeof value.lastSeenReadyAt === 'number'
      ? value.lastSeenReadyAt
      : value.nextRunAt
  return { nextRunAt: value.nextRunAt, wakeUntil: value.wakeUntil, schedules, lastSeenReadyAt }
}

export function writeWslHostAutomationWakes(
  userDataPath: string,
  due: Record<string, WslHostAutomationDue>
): void {
  writeFileSync(join(userDataPath, FILE_NAME), JSON.stringify(due))
}
