# Retired browser viewport operation ownership

The viewport operation captures a guest ID, then awaits CDP commands. Closing a tab deletes its viewport state, but the old continuation can subsequently recreate the UA-intent entry. A failed UA clear can also restore the old value over a replacement guest's completed desktop preset, or a late clear can delete the replacement's mobile intent.

The correction reuses that captured guest ID at three mutation boundaries: before publishing an applied preset's UA intent, before reading/deleting a cleared preset's intent, and before failed-clear rollback. Same-owner rollback, native UA profiles, navigation behavior, and the per-tab promise chain are preserved.

## Evidence

The regression fixture calls the actual manager, registration, unregistration, and viewport implementation. Electron WebContents and pending debugger replies are controlled ports; no native browser or window is launched.

- Baseline: **7 failing ownership regressions, 5 passing controls**.
- Fixed: **12/12 ownership cases**, plus **30 existing viewport, navigation, partial-failure, and UA cases**.
- Sixteen pending UA-clear rejections after `unregisterAll` leave **16 retired UA entries before, zero after**. Registration, preset, and promise maps remain empty.
- Other regressions cover closed-tab late success, failed-clear rollback, mobile/desktop replacement, and native-to-default profile replacement.
- Controls preserve ordinary serialized mobile/desktop/null operations, both native-profile presets, same-owner rollback, and the replacement promise tail while old queued operations settle.
- An independent reviewer ran all 12 candidate cases and reviewed the three mutation guards before promotion.

The retained entries are tab ID strings and booleans. This does **not** demonstrate retained native WebContents, a process RSS slope, or gigabyte-scale memory growth. In-flight CDP work still owns its continuation until it settles. Positive and negative post-close command replies are injected schedules, not an affected-host trace.

## Ordinary callers and compatibility

The renderer requests overrides when the user selects a viewport preset and on guest `dom-ready`, including null presets. The trusted IPC handler validates dimensions before calling this manager. Navigation later reads the UA-intent map, so stale replacement values can alter the standing mobile/desktop identity. The fixture does not execute the renderer or IPC producer.

Both local webview and host-side offscreen registrations use these maps. The correction changes no wire fields, protocol, execution-host ownership, native process lifecycle, folder/worktree handling, or UI layout. It only prevents an operation for a different guest from mutating the current registration's state.

`source-versions.json` records 11 paths at audit checkpoint `4a09b1d1`, independent main `291b4ddd`, and reported v1.4.198 `e0826956`. The viewport implementation, registration, registry declarations, IPC handler, and toolbar producer match all three. Ten sources match independent main and eight match v1.4.198. The guest-session producer contains an earlier audit fix; historical navigation and fixture sources differ. This is a current-dependency replay with the exact historical viewport source, not a historical app-binary replay.

The browsing activity in #19831 makes this path applicable in principle. The report does not establish the required overlap or tab count, and this small metadata mechanism does not account for its reported memory totals.

## Reproduction

From the worktree, run the fixed regression suite:

```sh
ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config docs/audits/browser-viewport-owner-retention/vitest.config.mjs
```

Run the same tests with the exact baseline viewport implementation; exit status 1 and seven failed cases are expected:

```sh
ORCA_BACKGROUND_LAUNCH=1 ORCA_VIEWPORT_BASELINE=1 node node_modules/vitest/vitest.mjs run --config docs/audits/browser-viewport-owner-retention/vitest.config.mjs
```

The import overlay never rewrites product files. `baseline-source.txt` contains only the original viewport module; current support modules remain in use. `baseline-results.json`, `fixed-results.json`, and `validation.json` record the measured results and their scope.
