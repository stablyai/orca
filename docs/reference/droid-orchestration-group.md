# Droid Orchestration Group

## Problem

Issue #4560 reports that Orca CLI / orchestration cannot be used with a Droid agent. Droid is already a first-class launchable agent in `src/shared/tui-agent-config.ts:240`, title detection token-matches Droid in `src/shared/agent-detection.ts:38` and `src/shared/agent-detection.ts:397`, and `--inject` accepts a detected running agent through `runtime.isTerminalRunningAgent` in `src/main/runtime/rpc/methods/orchestration.ts:429`. The gap found locally is that orchestration agent groups are hardcoded to `claude`, `openclaude`, `codex`, `opencode`, and `gemini` in `src/main/runtime/orchestration/groups.ts:7`, so `@droid` resolves to no recipients.

## Root Cause

The orchestration group resolver has its own closed list of addressable agent-name groups instead of deriving from the agent set that Orca can launch and recognize. Droid was added to the catalog and status paths, but not to this separate group list.

## Non-Goals

- Do not change Droid hook installation or Droid CLI launch semantics.
- Do not add a protocol adapter or new orchestration transport.
- Do not broaden `--inject` to send preambles into arbitrary shells.
- Do not change UI layout, styling, or agent picker ordering.

## Design

1. Add `droid` to orchestration's agent-name group allowlist.
2. Keep title matching token-based so `@droid` does not match Android paths, titles, or package names.
3. Update orchestration group tests to cover `@droid` positive and Android false-positive cases.
4. Update CLI-facing error/help text and shipped orchestration skill docs where they name example agent groups so Droid is not implied unsupported.

## Data Flow

- User sends `orca orchestration send --to @droid ...`.
- CLI calls `orchestration.send`.
- Runtime lists terminal summaries.
- `resolveGroupAddress` sees `@droid`, matches terminal titles with the existing token regex, and returns Droid terminal handles.
- Runtime inserts one message per recipient and delivers pending messages to idle terminals.

## Edge Cases

- `@droid` must match `Droid ready` and `Droid - action required`.
- `@droid` must not match `Android build`, `/tmp/android`, or `my-droid-worker`.
- Sender is still excluded from group fan-out.
- Unknown groups continue resolving to an empty list.
- SSH/remote terminals rely on the same terminal summaries and titles, so no local-path assumptions are introduced.

## Test Plan

- Unit: `src/main/runtime/orchestration/groups.test.ts` covers `@droid` positive fan-out and Android/path/hyphen false positives.
- Unit: existing `src/shared/agent-detection` coverage remains the title-status source of truth; no changes expected.
- Unit: existing orchestration RPC group fan-out tests should continue passing.
- Manual/CLI: with a Droid terminal title, `orca orchestration send --to @droid --subject ...` should resolve recipients; without one it should report no recipients.

## UI Quality Bar

Not UI-visible. Behavior changes only affect CLI orchestration group routing and error/help copy.

## Review Screenshots

No required UI screenshots. Stage 6 should capture a terminal/CLI validation artifact only if Electron validation creates a visible terminal state.

## Rollout

1. Update orchestration group allowlist and tests.
2. Update example/error copy.
3. Run focused unit tests for group resolution and orchestration send behavior.
4. Run typecheck/lint if the focused tests pass.

## Lightweight Eng Review

- Scope: reduced to group resolution and copy because Droid is already in launch, hook, title, and process-recognition paths.
- Architecture/data flow: keep the boundary inside `src/main/runtime/orchestration/groups.ts`; runtime RPC continues delegating fan-out through the existing resolver.
- Failure modes covered:
  - Android false positives from substring matching.
  - Hyphen/path token false positives.
  - Sender exclusion in group fan-out.
  - Unknown groups preserving empty-resolution behavior.
- Test coverage required:
  - `src/main/runtime/orchestration/groups.test.ts` for `@droid` matching and false positives.
  - Existing `src/main/runtime/rpc/methods/orchestration.test.ts` smoke for agent group fan-out.
- Performance/blast radius: no material concern; one string added to a small in-memory list and one extra unit-test case.
- UI quality bar: not UI-visible.
- Required review screenshots: none; validation should rely on CLI/test output unless a visible terminal state is exercised.
- Residual risks: if Droid's real TUI never sets a title containing `Droid`, `@droid` still needs foreground-process-aware group resolution in a follow-up. Current code already synthesizes Droid titles from hooks, so this is expected to work for hook-enabled Droid sessions.

## Codex Review

- Round 1: tightened scope to include shipped orchestration skill/help text because it documents the same hardcoded group list users see when learning the feature.
- Residual issues: none known within the small group-routing fix.
