# Automation Schedule UI Refresh

## Problem

- `AutomationSchedulePicker.tsx` puts cadence, custom schedule editing, weekly day, and a native `type="time"` input into one narrow popover. The native time input is an inconsistent Chromium control and is the weakest part of the automation editor.
- `Custom cron` is exposed as a normal creation choice even though cron is storage/provider syntax. Orca still needs to parse cron for imported, external, and legacy schedules, but new users should choose a schedule, not write cron.
- `formatAutomationSchedule` currently returns `Custom cron: ...` for every valid cron expression, leaking raw schedule syntax into list/detail surfaces and Hermes run output.
- User-facing copy calls Hermes jobs "cron" in dialog titles, warnings, toasts, and source empty states.
- Local and external automation rows show schedule, next run, location, agent, and usage, but the scan order does not make the automation behavior obvious.

## Goal

Make automations read as scheduled agent runs:

1. Replace native time input with Orca-styled controls for cadence, run time, weekly day, and hourly minute.
2. Hide custom schedules from the normal create path while preserving load/edit/save for existing custom schedules.
3. Format supported cron shapes with friendly labels and hide unsupported valid cron behind `Custom schedule`.
4. Remove provider-cron wording from user-facing copy.
5. Improve list/detail scan order for local and external automations without changing scheduler semantics or adding timezone UI.

## Non-goals

- Do not change persisted automation schema, IPC payloads, scheduler ownership, RRULE generation, cron execution semantics, missed-run grace, or SSH dispatch behavior.
- Do not add timezone selection or timezone explanations.
- Do not remove valid custom schedule support for existing Orca automations or editable Hermes jobs.
- Do not add custom recurrence builders beyond the existing presets.
- Do not redesign run history.

## Design

### 1. Structured Schedule Picker

- Keep `AutomationSchedulePicker` controlled by `AutomationDraft`; do not add persisted fields.
- For normal schedules, render a cadence `Select` with only `hourly`, `daily`, `weekdays`, and `weekly`. Do not mount a `Select` whose value is `custom` after removing the custom item.
- Use existing shadcn primitives: `Select` for cadence/day/hour/minute, `ToggleGroup` or `Select` for AM/PM, `Button` for actions, and the current `Popover`.
- Store all changes back into the existing draft shape:
  - `draft.preset` remains the source of cadence.
  - `draft.time` remains `HH:mm`.
  - `draft.dayOfWeek` remains `0`-`6`.
  - hourly schedules use only the minute from `draft.time`; changing hourly controls must not make the hour meaningful.
- Minute controls must support every minute `0`-`59`, not only 5-minute steps. Existing unusual minutes must round-trip visibly.
- Use compact responsive grids with `minmax(0, 1fr)` so controls shrink instead of overflowing the dialog/popover.
- Keep the trigger label derived from `formatAutomationSchedule(buildAutomationRrule(...))` for non-custom drafts.

### 2. Advanced Schedule Fallback

- When `draft.preset === 'custom'`, render an `Advanced schedule` panel instead of the normal cadence controls.
- Show the saved expression in an editable field and save the raw trimmed value unchanged when valid. Local Orca advanced schedules should validate with `isValidAutomationSchedule`; provider-backed editors may pass a stricter validator.
- Copy must say "advanced schedule", not "cron". Inline invalid text and save toasts should be `Enter a valid advanced schedule before saving.`
- Include a secondary `Use simple schedule` action that switches to a supported preset and clears `scheduleWarning`. It may default to weekdays unless the custom expression is classified into a simple preset; either way, do not rewrite the custom schedule until the user explicitly switches.
- Existing unsupported schedules still open on the current warning path: `scheduleWarning` blocks save until the user picks a supported preset. Only schedule-picker actions should clear that warning.

### 3. Shared Schedule Formatting

- Extend `formatAutomationSchedule(schedule)` to handle both RRULE and cron input; rename the parameter internally if helpful.
- RRULE formatting stays unchanged for current presets.
- Cron formatting should use the parsed cron sets, not regexes over the original string, so names, ranges, lists, and `7` as Sunday normalize consistently.
- Keep cron parsing in `src/shared/automation-schedules.ts` and expose a small cron-only validator/classifier for provider code paths. Do not duplicate a second cron parser in renderer components.
- Friendly-format only these cron shapes:
  - hourly: one minute, all hours, unrestricted day-of-month, month, and day-of-week.
  - daily: one minute, one hour, unrestricted day-of-month, month, and day-of-week.
  - weekdays: one minute, one hour, unrestricted day-of-month/month, day-of-week exactly Monday-Friday.
  - weekly: one minute, one hour, unrestricted day-of-month/month, day-of-week exactly one day.
- Return `Custom schedule` for all other valid cron expressions, including intervals, multiple hours/minutes, monthly/yearly restrictions, and cron rules with both day-of-month and day-of-week restricted. Those use cron OR semantics and must not be mislabeled as weekly/daily.
- Return `Invalid schedule` for invalid or impossible schedules.
- Add focused tests for simple cron labels, `MON-FRI`, Sunday via `7`, interval cron falling back to `Custom schedule`, monthly cron falling back, DOM+DOW OR cron falling back, invalid schedules, and the cron-only helper rejecting RRULE input.
- Replace duplicate schedule-description logic in `HermesCronOutputView` with the shared formatter or make it call the same classifier. Schedule metadata should show the friendly label as the visible value; keep the raw provider string only as secondary detail such as a tooltip when useful.

### 4. Hermes And External Interop

- User copy should say `Hermes automation`, not `Hermes cron`, in titles, warnings, toasts, source empty states, and same-host validation.
- Keep cron strings internally for Hermes create/update. `buildHermesCronSchedule` can keep returning a 5-field schedule; this is provider payload, not user copy.
- For Hermes saves, preset schedules must be converted to 5-field cron before the IPC call. A custom advanced expression must pass the shared cron-only provider validator before calling `createExternal`/`updateExternal`; `isValidAutomationSchedule` alone is too broad because it accepts Orca RRULEs.
- For external rows/detail, prefer `job.rawSchedule` when it parses and can be displayed without losing provider context, then format it with `formatAutomationSchedule`. Fall back to provider `job.schedule` when raw schedule is missing, provider-specific, or paired with context that the raw expression omits, such as an OpenClaw cron timezone. Do not feed arbitrary provider display strings into validation just to show a label.
- External edit must preserve SSH target compatibility: keep the current same-host check between the selected workspace repo connection and the external manager target before calling `createExternal`/`updateExternal`.
- After external create/update/action, refresh from `listExternalManagers`; external mutation APIs do not return a normalized job payload.

### 5. List And Detail Scan Order

- Local list rows should scan as: name/status, schedule, next run, then quieter metadata for location/agent and usage. Keep the right-side next-run affordance, but make the schedule the primary secondary line.
- External list rows and `ExternalAutomationManagers` should use the same schedule display helper when a raw schedule can be shown safely, with provider/location/run-count as quieter metadata.
- Detail should group behavior before usage: schedule, next run, run location, session mode, and grace should sit together before cost/tokens/usage coverage.
- Preserve the existing SSH availability warning in detail. Do not add timezone selection or explanatory timezone copy.
- Use existing tokens, compact typography, lucide icons, and shadcn primitives from `docs/STYLEGUIDE.md`; do not add new colors, shadows, or card nesting.

## Consistency Requirements

- Create/update local automations should continue to refresh after save and select the saved automation.
- Editing a local automation should keep the current latest-before-open and latest-before-save checks so non-schedule edits do not reset `dtstart` or `nextRunAt`.
- Derived labels should be computed from current `automation.rrule` or external job data during render, not cached in draft state.
- Focus/visibility and `AUTOMATIONS_CHANGED_EVENT` refresh behavior should remain intact so external mutations and scheduler changes update list/detail surfaces.
- On external mutation failure, refresh before leaving the stale editor state visible when possible.

## Edge Cases

- Existing valid custom schedules must open as advanced schedules and save unchanged if the user makes no schedule change.
- Existing unsupported schedules must remain blocked by `scheduleWarning` until the user chooses a supported schedule.
- Non-5-minute values, midnight/noon, and Sunday weekly schedules must round-trip.
- Hourly schedules must ignore the stored hour.
- Cron with restricted month/day-of-month, multiple run times, or DOM+DOW restrictions must not receive misleading friendly labels.
- Local, SSH, Hermes, and OpenClaw rows must tolerate missing worktrees, disconnected SSH sources, missing raw schedules, and provider-specific display strings.
- Small dialog widths must not overflow schedule labels or controls.

## Rollout

1. Update shared schedule formatting and tests.
2. Replace picker controls and advanced fallback copy.
3. Update automation dialog/save/external copy.
4. Update local and external list/detail schedule scan layout.
5. Remove duplicated Hermes output schedule formatting.
6. Run focused schedule tests, then lint/typecheck.
7. Validate create/edit UI in Electron for local, SSH, existing custom, unsupported saved schedule, and Hermes edit flows.
