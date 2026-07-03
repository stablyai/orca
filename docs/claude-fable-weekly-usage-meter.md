# Claude Fable Weekly Usage Meter

## Problem

Claude Code now exposes weekly subscription usage alongside the 5-hour window, and its live `/usage` panel can show an explicit Fable-specific weekly bucket. Anthropic documents `rate_limits.five_hour` and `rate_limits.seven_day` in Claude Code statusline JSON, with weekly data present for Claude.ai subscribers after the first API response. The existing Orca Claude meter already has a weekly slot in shared state, but it needs a distinct Fable weekly slot so the status bar can show all three visible meters when Claude reports them.

Relevant code:

- `src/shared/rate-limit-types.ts:46` models provider usage with `session` and `weekly` windows.
- `src/main/rate-limits/claude-fetcher.ts:373` maps OAuth `five_hour` and `seven_day` into Orca's Claude provider state.
- `src/main/rate-limits/claude-pty.ts:18` parses hidden `claude` `/usage` output, but `WEEKLY_RE` only accepts `Current week`.
- `src/renderer/src/components/status-bar/StatusBar.tsx:1112` renders both session and weekly windows when both are present.
- `src/renderer/src/components/status-bar/tooltip.tsx:138` includes weekly usage in the details popover.

Research:

- Official Claude Code statusline docs: [`rate_limits.five_hour.used_percentage` and `rate_limits.seven_day.used_percentage`](https://code.claude.com/docs/en/statusline#available-data), plus matching `resets_at`, are the 5-hour and 7-day rate-limit fields.
- `harveyxiacn/cc-usage-monitor` uses Claude Code's statusline `rate_limits` data and shows both [`5h` and `7d` windows](https://github.com/harveyxiacn/cc-usage-monitor), matching Orca's existing `session` and `weekly` model.
- `leeguooooo/claude-code-usage-bar` independently exposes the same [`5h` and `7d` rate-limit usage](https://github.com/leeguooooo/claude-code-usage-bar) in a Claude Code statusLine integration.
- Fable is not part of the documented statusline schema above. Orca only treats it as Fable weekly usage when the live `/usage` panel renders a standalone `Fable` label or an OAuth response uses an explicit weekly/seven-day Fable field name.

Redacted live `/usage` shape this parser targets:

```text
Plan usage limits

Current session
18% remaining
Resets in 2h 10m

Current week (all models)
84% left
Resets in 5d 4h

Fable
42% consumed
Resets in 3d 2h
```

## Goal

Make Orca's existing Claude status-bar meter show the weekly Claude and Fable usage windows whenever Claude Code reports them, including newer `/usage` panel wording such as `Weekly limits`, `Fable`, or `7-day`.

## Non-goals

- Do not infer subscription quota from token logs.
- Do not spend user Claude quota during automated verification.
- Do not change provider account switching, polling cadence, or OAuth credential handling.

## Design

1. Keep `ProviderRateLimits.weekly` as the canonical generic 7-day UI field. OAuth already maps `seven_day` to `weekly`, and the status bar already renders it next to the 5-hour window.
2. Add `ProviderRateLimits.fableWeekly` as a distinct optional Claude window so the chip and popover can render Session, Weekly, and Fable simultaneously.
3. Accept both OAuth `utilization` windows and Claude Code-style `used_percentage` windows with epoch-second `resets_at` values.
4. Broaden the hidden Claude CLI parser so the generic weekly label accepts both old `Current week` wording and newer usage/statusline wording: `Weekly limits`, `Weekly usage`, `weekly rate limit`, and `7-day`.
5. Parse only a standalone `Fable` label into `fableWeekly` instead of collapsing it into generic `weekly`; ambiguous Fable copy is a section boundary, not a meter.
6. Broaden percent parsing to treat `consumed` like `used`, because Anthropic describes rate-limit percentages as consumed.
7. Add focused tests for the new weekly wording and retain existing old-copy coverage.

## Edge Cases

- Weekly data may be absent for API-key users or before the first Claude API response; keep `weekly: null`.
- The hidden PTY fallback may still only return session data; the status bar should continue showing the 5-hour meter without error.
- Reset timestamps/descriptions may be absent from CLI output; keep `resetsAt: null` and parse only visible reset text.
- Fable data may be absent from the documented statusline payload even when the interactive `/usage` panel shows it; keep `fableWeekly: null` unless an explicit weekly/seven-day field or standalone `Fable` label is present.
- A bare OAuth `fable` field is ambiguous because it does not encode the window length; ignore it until the upstream contract is clearer.

## Rollout

1. Update OAuth window mapping for statusline-style percentages, reset timestamps, and distinct Fable weekly fields when present.
2. Update `claude-pty` weekly label, Fable label, and percent parsing.
3. Add focused tests for statusline-style OAuth data, `Weekly limits`, `Fable`, and `7-day` wording.
4. Run focused tests, then typecheck/lint.
5. Validate in Electron by injecting a Claude provider state with 5-hour, generic weekly, and Fable weekly data and capturing status-bar screenshots.
6. Commit, push, open a PR, and attach screenshots in a PR comment.
