# Settings changes in the crash breadcrumb trail

A settings write that actually changes something records a durable
`settings_changed` crash breadcrumb, so the "Recent activity" section of a crash
report shows what the user was reconfiguring before the process died.

This lane is separate from the `settings_changed` product-analytics event
(`src/shared/telemetry-event-registry.ts`, fired from `src/main/ipc/settings.ts`).
Analytics covers a whitelist of experimental boolean toggles and never reaches a
crash bundle; the breadcrumb covers every changed key and travels with the report.

## Why it exists

Field report `0d740d3f` (v1.4.200, macOS 25.6.0 x64, renderer, SIGBUS) carried a
user note: "turning of the always on mode". Triage could neither corroborate nor
refute it — the breadcrumb trail had no record of any setting ever changing — and
the toggle was eventually exonerated only by hand, flipping it 46 times through
the real status-bar dropdown. A crumb naming `computerAwakeMode` /
`keepComputerAwakeWhileAgentsRun` and its new value would have settled that from
the payload. Cross-check a user note against this crumb before spending triage on
reproduction.

## What may be recorded

Settings hold API tokens, account identifiers, absolute paths, repo names,
hostnames and custom agent commands, and a crash bundle is uploaded off the
user's machine. `src/main/crash-reporting/settings-change-breadcrumb.ts` records
the setting **key** always, and the **value** only when it is bounded and safe:

- booleans and finite numbers verbatim;
- strings only when the key is in `SAFE_ENUM_SETTING_VALUES` **and** the value is
  a member of that key's closed vocabulary;
- everything else — strings, arrays, objects, unrecognised keys — as a shape:
  `string(42)`, `array(3)`, `object(5)`, `cleared`, `unset`, `set`.

An unknown key is unsafe by default, and the allowlist is keyed, not a global word
list: `terminalGpuAcceleration` holding `'off'` is still a shape, because only
`computerAwakeMode` owns that vocabulary. Widening the allowlist is a privacy
decision: the tests in `settings-change-breadcrumb.test.ts` reject an entry whose
values are not short enum tokens that survive the crash redactor
(`sanitizeCrashReportString`) unchanged, and prove a token-shaped and a
path-shaped setting stay out of the emitted crumb. Previous values are never
recorded.

## Cost

The crumb is emitted through `recordCoalescedDurableCrashBreadcrumb`, keyed on the
sorted changed-key list with a 5s window, so a debounced field edit or slider drag
costs one ring slot and a `suppressedSinceLast` count instead of flooding the
30-slot ring. A bulk write reports at most 12 value entries plus
`omittedKeyCount`. Nothing is deep-walked or stringified per write.
