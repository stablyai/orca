# Codex Usage-Limit Detection Patterns

## Exact strings captured from Codex sessions

```text
You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Apr 23rd, 2026 10:42 AM.
```

```text
You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at May 14th, 2026 2:32 PM.
```

The May string appeared twice. These were the only Codex usage-limit error variants in the 19
retained sessions searched from April 17 through July 9, 2026.

## Stable detection strings

Use both when structured event data is available:

```text
payload.codex_error_info == "usage_limit_exceeded"
payload.type == "error"
```

For live terminal output, detect the stable prefix:

```text
You've hit your usage limit.
```

and require this reset marker later in the same live-screen match:

```text
or try again at
```

Do not depend on the upgrade sentence or URL. They are product copy and may change independently
of the limit and reset fields.

## Regex for live terminal output

Strip ANSI escape sequences before matching. Match case-insensitively because rendering should
not affect detection.

```regex
/you['’]ve\s+hit\s+your\s+usage\s+limit\.[\s\S]*?or\s+try\s+again\s+at\s+(?<reset>[A-Z][a-z]{2,8}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))\.?/i
```

Captured `reset` examples:

```text
Apr 23rd, 2026 10:42 AM
May 14th, 2026 2:32 PM
```

If the live-tail implementation normalizes terminal text into one line, use the same regex. If it
preserves wrapped lines, `[\s\S]*?` permits the copy between the prefix and reset marker to wrap.

## Narrow reset-time regex

After the usage-limit prefix has already been confirmed, extract only the timestamp with:

```regex
/or\s+try\s+again\s+at\s+(?<reset>[A-Z][a-z]{2,8}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))\.?/i
```

Normalize the captured value before parsing:

```text
Apr 23rd, 2026 10:42 AM -> Apr 23, 2026 10:42 AM
May 14th, 2026 2:32 PM -> May 14, 2026 2:32 PM
```

Remove `st`, `nd`, `rd`, or `th` only when it immediately follows the day number. Preserve the
year and AM/PM marker.

## Structured reset fields

Codex session events also expose Unix-second timestamps that need no text parsing:

```text
payload.rate_limits.primary.resets_at
payload.rate_limits.secondary.resets_at
```

The corresponding exhaustion values are:

```text
payload.rate_limits.primary.used_percent
payload.rate_limits.secondary.used_percent
```

When an exhausted structured window is present, use its `resets_at`. If multiple windows are at
100%, use the latest reset. Use the captured `or try again at` time when structured data is absent.

## Required safety checks

- Match against the live PTY tail, not terminal-history files or arbitrary scrollback.
- Reconfirm the complete usage-limit match immediately before resuming.
- Deduplicate repeated matches with the same PTY and parsed reset timestamp.
- The text timestamp has no timezone. For SSH sessions, do not silently interpret it in the Orca
  client's timezone; prefer Unix `resets_at`, or retain the runtime host's timezone context.
- Add the auto-resume grace period only after parsing the provider's reset time.

## Fixtures

```ts
export const CODEX_USAGE_LIMIT_FIXTURES = [
  {
    text: "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Apr 23rd, 2026 10:42 AM.",
    resetText: 'Apr 23rd, 2026 10:42 AM',
  },
  {
    text: "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at May 14th, 2026 2:32 PM.",
    resetText: 'May 14th, 2026 2:32 PM',
  },
] as const
```
