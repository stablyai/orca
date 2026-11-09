// The desktop's cron dialect (src/shared/automations/scheduling), bundled into the Worker as is so
// a routine and a local automation read the same expression the same way. Plain JS on purpose:
// the Worker's stricter tsconfig would otherwise type-check the desktop's sources; the types this
// boundary relies on are declared in shared-scheduling.d.ts (and pinned by test/routines-schedule.test.ts).
export {
  isValidAutomationCronSchedule,
  parseCronExpression
} from '../../../../../src/shared/automations/scheduling/automation-schedule-parsing'
