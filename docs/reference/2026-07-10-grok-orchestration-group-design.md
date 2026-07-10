# Grok Orchestration Group Design

## Problem

Orca recognizes Grok as a TUI agent, but orchestration group routing does not
recognize `@grok`. A point-to-point message sent to a Grok terminal handle works,
while the equivalent named-group message resolves no recipients.

## Goals

- Add `@grok` to the supported agent-name orchestration groups.
- Match Grok terminal titles case-insensitively using the existing standalone-token
  rules.
- Exclude the sender from the resolved recipient list.
- Keep documentation and executable guidance tests aligned with the runtime list.

## Non-Goals

- Change Grok process detection, startup, hooks, transcript parsing, or native chat.
- Change raw `terminal.send` behavior or add reply tracking.
- Add Grok-specific routing outside the existing generic agent-name resolver.
- Add UI or provider-specific Git hosting behavior.

## Architecture

`AGENT_NAME_GROUPS` remains the single runtime allowlist for named orchestration
groups. Adding `grok` to that list automatically extends the `GroupAddress` type
and reuses `titleMatchesAgentNameGroup`; no Grok-only branch is introduced.

The existing resolver continues to operate on `RuntimeTerminalSummary.title`, so
local, SSH, macOS, Linux, and Windows terminals follow the same path. Explicit
terminal-handle routing remains unchanged.

## Matching Contract

- `@grok` matches titles such as `Grok`, `Grok CLI`, and spinner-prefixed
  `⠋ Grok`.
- Matching is case-insensitive.
- The sender handle is excluded.
- Titles where `grok` is embedded in a larger/path/hyphenated token, including
  `ngrok`, `/tmp/grok`, and `my-grok-worker`, do not match.
- A valid `@grok` address with no matching terminal preserves the existing
  no-recipient error from `orchestration.send`.

## Files

- `src/main/runtime/orchestration/groups.ts`: add the named group.
- `src/main/runtime/orchestration/groups.test.ts`: cover positive, negative,
  case-insensitive, spinner-title, and sender-exclusion behavior.
- `skills/orchestration/SKILL.md`: advertise `@grok` in the group list.
- `config/scripts/orchestration-skill-guidance.test.mjs`: prevent documentation
  drift.

## Testing

Development follows red-green TDD:

1. Add resolver and guidance assertions and observe them fail without `grok`.
2. Add `grok` to the runtime allowlist and skill documentation.
3. Run the focused resolver and guidance suites.
4. Run formatting, type checking, and the repository's relevant validation gates.

## Success Criteria

- `orca orchestration send --to @grok ...` resolves every matching Grok terminal
  except the sender.
- False-positive title tokens remain excluded.
- Runtime source, tests, and installed skill guidance list the same group.
- No behavior outside named-group resolution changes.
