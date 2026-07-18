# Claude Scoped OAuth Usage Limits

## Problem

Anthropic's current OAuth usage response reports Fable in `limits` as a model-scoped weekly limit instead of one of the legacy top-level Fable fields. Orca ignores `limits`, maps `fableWeekly` to `null`, and then depends on a hidden Claude `/usage` PTY read that is disabled on Windows and can fail silently elsewhere.

- `src/main/rate-limits/claude-fetcher.ts:300` models only top-level OAuth windows.
- `src/main/rate-limits/claude-fetcher.ts:393` maps only legacy Fable field names.
- `src/main/rate-limits/service.ts:1203` disables the PTY supplement on Windows.
- `src/renderer/src/components/status-bar/tooltip.tsx:172` renders Fable whenever `fableWeekly` is populated.

## Root Cause

The OAuth response contract evolved from dedicated model fields to generic entries shaped like `kind: "weekly_scoped"`, `percent`, `resets_at`, and `scope.model.display_name`. Orca's response type and mapper were not updated for that shape.

## Non-goals

- Do not change polling, credentials, token refresh, account switching, renderer layout, or usage percentage semantics.
- Do not remove the existing PTY supplement or legacy field compatibility.
- Do not generalize shared renderer state to arbitrary model windows in this targeted bug fix.

## Design

1. Extend the private OAuth response type with an optional `limits` array containing only the fields needed for safe parsing.
2. Select a Fable entry only when `kind` is `weekly_scoped`, the model display name is Fable (case-insensitive), and `percent` is finite.
3. Map the scoped entry to the existing seven-day `fableWeekly` window, including its reset timestamp.
4. Prefer the current scoped entry, then retain the three legacy top-level fields as fallbacks.
5. Keep malformed, unrelated, or absent entries non-fatal. Do NOT gate on `is_active`: it marks which limit is currently binding, not whether the entry's data is valid, so an `is_active: false` Fable entry with a finite `percent` must still render (#8979). Accept a missing activity flag for compatibility.

## Data Flow

- OAuth response
  - `limits[].weekly_scoped` Fable -> `fableWeekly`
  - otherwise legacy explicit Fable field -> `fableWeekly`
  - otherwise existing optional PTY supplement
- Existing provider state -> existing status-bar and details rendering

## Edge Cases

- `limits` is missing, null, malformed, or contains null entries.
- A scoped entry names another model.
- Fable percent is missing, non-numeric, or non-finite.
- Fable is inactive (`is_active: false`) but still carries a finite `percent`/reset, so it must render (#8979).
- `is_active` is omitted by an older server response but the remaining scoped entry is valid.
- Both current and legacy fields exist; the current scoped entry wins.
- Reset timestamps may be ISO strings, epoch seconds, epoch milliseconds, or absent.
- Windows, WSL, SSH, and remote runtimes use the same OAuth mapper and require no platform-specific execution.

## Test Plan

- Unit: reproduce a current real-response shape and assert Fable maps without a PTY attempt.
- Unit: assert scoped data wins over a legacy field.
- Unit: assert malformed and unrelated scoped entries are ignored while legacy fallback remains available; assert an inactive-but-valid Fable entry still surfaces (#8979).
- Regression: retain existing legacy-field and bare-`fable` behavior tests.
- Verification: focused Claude fetcher tests, typecheck, lint, and max-lines ratchet.
- Electron: refresh Claude usage and confirm Session, Weekly, and Fable remain visible in the existing status-bar details surface.

## UI Quality Bar

No UI implementation changes. The existing Fable row must reappear with the same typography, spacing, progress bar, percentage semantics, and reset copy as adjacent Session and Weekly rows.

## Review Screenshots

1. Claude usage details showing Session, Weekly, and Fable from a live OAuth refresh.
2. Adjacent status-bar context showing the Claude provider remains visually unchanged outside the restored row.

## Rollout

1. Add the scoped OAuth response types and mapper.
2. Add focused current-schema and compatibility regression tests.
3. Run focused and repository checks.
4. Validate the restored row in Electron and capture review screenshots.
5. Commit, push, and open an unmerged PR.

## Lightweight Eng Review

- Scope: Kept to the private OAuth mapper and tests; no shared-state or renderer generalization is required to restore Fable.
- Architecture/data flow: OAuth remains authoritative, with structured scoped data preferred over legacy fields and PTY used only as the existing final supplement.
- Failure modes covered: malformed optional data, unrelated models, inactive-but-valid limits (still rendered, #8979), missing activity flags, duplicate old/new representations, missing reset metadata, and platform-neutral execution.
- Test coverage required: current-schema success without PTY, precedence, inactive-but-valid rendering, malformed/unrelated entries, and legacy fallback.
- Performance/blast radius: One bounded linear scan of the small response `limits` array per existing OAuth refresh; no new requests, polling, subprocesses, IPC, storage, or renderer work.
- UI quality bar: Existing status-bar visuals must remain unchanged except for the restored Fable row.
- Required review screenshots: Live Claude details with all three rows; surrounding status-bar context.
- Residual risks: Anthropic may rename the scoped model display label; legacy and PTY fallbacks remain available.
