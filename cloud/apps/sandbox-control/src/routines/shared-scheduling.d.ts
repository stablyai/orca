// Types for shared-scheduling.js (see there). Mirrors src/shared/automations/scheduling/automation-schedule-parsing.ts.
export type ParsedCron = {
  kind: 'cron'
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  /** 0 = Sunday (7 is normalized to 0). */
  daysOfWeek: Set<number>
  dayOfMonthRestricted: boolean
  dayOfWeekRestricted: boolean
}

/** Throws on anything but a valid five-field cron expression. */
export function parseCronExpression(expression: string, options?: { rejectOversizedStep?: boolean }): ParsedCron

/** New-input gate: valid, can ever fire, and no oversized steps. */
export function isValidAutomationCronSchedule(schedule: string): boolean
