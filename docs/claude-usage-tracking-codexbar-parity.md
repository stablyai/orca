# Claude Usage Tracking: CodexBar Parity Plan

## Goal

Make Orca's Claude usage limit tracking behave like CodexBar's Claude implementation: automatic, resilient, and source-aware internally, without asking users to choose between OAuth, CLI, or other data sources.

This plan intentionally does not introduce new product behavior from scratch. Each proposed change is based on CodexBar's existing implementation.

## User-Facing Principle

Users should not need to pick a usage source.

The normal product behavior should remain automatic:

- Try the best live Claude usage source.
- Repair or fall back when a source fails.
- Keep the last useful usage snapshot visible when refresh is deferred or temporarily unavailable.
- Show a specific, actionable status only when Orca cannot recover automatically.

Any "source planner" described below is internal plumbing only. It should not imply a visible source picker for normal users.

## CodexBar References

CodexBar's Claude implementation already separates source selection from execution:

- `ClaudeSourcePlanner.resolve(...)` builds an ordered automatic plan.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeSourcePlanner.swift:173`
- App auto mode tries OAuth, then CLI, then web.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeSourcePlanner.swift:173`
- CLI runtime auto mode tries web, then CLI.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeSourcePlanner.swift:181`
- `ClaudeUsageFetcher.StepExecutor` executes the selected path.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:461`
- OAuth failures can trigger delegated Claude CLI refresh, then credentials are reloaded and OAuth is retried.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:324`
- OAuth credential loading accounts for Keychain prompt policy and cached credentials.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:250`
- Claude source types are explicit: auto, api, oauth, web, cli.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageDataSource.swift:3`

CodexBar's Codex implementation is also a useful pattern for fallback discipline:

- Auto mode tries OAuth, then CLI.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Codex/CodexProviderDescriptor.swift:43`
- Codex OAuth refresh is performed before usage fetch when credentials need refresh.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Codex/CodexProviderDescriptor.swift:169`
- Fallback from OAuth to CLI is limited to failures the CLI can plausibly repair.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Codex/CodexProviderDescriptor.swift:199`
- Codex CLI usage is fetched through `codex app-server` JSON-RPC.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/UsageFetcher.swift:1012`

## Current Orca Behavior To Preserve Or Change

Orca currently reads Claude OAuth credentials and calls Anthropic's OAuth usage endpoint:

- OAuth usage endpoint and headers are in `claude-fetcher.ts`.
  Reference: `src/main/rate-limits/claude-fetcher.ts:24`
- OAuth credential reads intentionally let the server decide whether a token is valid because local expiry metadata is not authoritative.
  Reference: `src/main/rate-limits/claude-fetcher.ts:80`
- System-default Keychain lookup intentionally mirrors Claude's legacy service ordering.
  Reference: `src/main/rate-limits/claude-fetcher.ts:193`
- Renderer currently maps many auth-looking failures into "Refresh failed" / softer auth copy.
  Reference: `src/renderer/src/components/status-bar/tooltip.tsx:115`

Preserve:

- Managed-account safety around live Claude sessions and refresh-token rotation.
- System-default support.
- Existing OAuth usage endpoint mapping.
- Existing PTY fallback parser behavior where safe.

Change:

- Do not treat a single OAuth failure as overall Claude usage failure.
- Distinguish deferred, recoverable, fallbackable, and terminal failures.
- Use CLI fallback and delegated refresh intentionally, following CodexBar's shape.

## Proposed Changes

### 1. Add An Internal Claude Usage Refresh Plan

Create an internal planner that returns ordered attempts for the current account/runtime state.

Initial app automatic order should match CodexBar's app auto ordering:

1. OAuth usage API.
2. CLI/PTY usage fallback.
3. Web usage source later, only if Orca intentionally adopts CodexBar's web/cookie machinery.

CodexBar basis:

- `ClaudeSourcePlanner.makeSteps` app auto returns OAuth, CLI, web.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeSourcePlanner.swift:173`
- `ClaudeUsageDataSource` defines source identifiers separately from execution.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageDataSource.swift:3`

Orca implementation target:

- Add a focused module near `src/main/rate-limits/`, for example `claude-usage-refresh-plan.ts`.
- Keep it internal to main-process rate-limit refresh.
- Do not expose a normal user setting for source selection.

### 2. Add Source Attempt Execution

Separate "which source should be tried" from "how each source fetches usage."

CodexBar basis:

- `StepExecutor.loadLatestUsage` switches on source and executes OAuth, web, or CLI.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:461`

Orca implementation target:

- Split Claude refresh into source attempt functions:
  - `fetchClaudeUsageViaOAuth(...)`
  - `fetchClaudeUsageViaCli(...)`
  - possible future `fetchClaudeUsageViaWeb(...)`
- Keep the existing OAuth endpoint logic in the OAuth attempt.
- Reuse existing `fetchViaPty` for the CLI attempt.

### 3. Classify OAuth Failures Before Deciding What To Do

Add structured OAuth failure classification.

Failure kinds should include:

- missing credentials
- stale or unauthorized access token
- refreshable credentials present but access token unavailable
- delegated refresh required
- delegated refresh deferred by live Claude session
- Keychain denied or unavailable
- missing required scope
- network/proxy/DNS failure
- Anthropic server failure
- response parse failure
- rate-limited usage endpoint

CodexBar basis:

- Codex fallback is intentionally limited to specific OAuth credential/auth errors.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Codex/CodexProviderDescriptor.swift:199`
- Claude OAuth maps credential/fetch errors distinctly before retrying or surfacing.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:286`
- Missing Claude OAuth scope gets a specific actionable message.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:444`

Orca implementation target:

- Add `claude-usage-error-classification.ts`.
- Use classification to decide:
  - retry OAuth after delegated refresh
  - fall back to CLI
  - defer because live Claude owns refresh
  - surface terminal error

### 4. Add Delegated Claude CLI Refresh For Safe Cases

When OAuth credentials appear stale or access is unauthorized, let Claude CLI repair its own credentials, then re-read credentials and retry OAuth once.

CodexBar basis:

- Expired Claude OAuth credentials can trigger `loadAfterDelegatedRefresh`.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:324`
- CodexBar asserts delegated refresh is allowed in the current interaction context before running it.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:345`
- After delegated refresh, CodexBar invalidates changed credential caches, syncs Keychain without prompt, reloads credentials, and retries OAuth.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:369`

Orca implementation target:

- Add a guarded delegated refresh step for system-default accounts and managed accounts only when no live Claude PTY owns the same credentials.
- After delegation, re-run Orca's existing credential read order and retry the OAuth usage request once.
- Keep this disabled for cases where Orca already knows live Claude is using/rotating that credential set.

### 5. Preserve Managed Live-Session Safety, But Change The State

Current Orca managed-account behavior avoids rotating refresh tokens while a live Claude terminal may rotate them. Keep that safety rule.

Change the user-visible outcome from generic failure to a deferred state.

CodexBar basis:

- Delegated refresh is gated by interaction policy and can be unavailable rather than blindly attempted.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:345`
- CodexBar tracks delegated refresh outcomes and reports them distinctly.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:350`

Orca implementation target:

- Add a first-class `deferredByLiveClaudeSession` usage refresh outcome.
- Keep last successful snapshot visible if present.
- Tooltip/status should say the refresh is waiting for the live Claude session rather than "Refresh failed."

### 6. Apply The Same Recovery Logic To System Default

Do not assume failures are managed-account only.

System default can still fail when:

- Keychain access is denied.
- Claude rotated credentials and Orca has stale cached data.
- The access token is rejected by the OAuth usage endpoint.
- Required scope is missing.
- Network/proxy settings block `api.anthropic.com`.

CodexBar basis:

- OAuth credential loading accounts for cached credentials, Keychain prompt policy, and Keychain access.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:250`
- Post-delegation retry re-reads credentials instead of reusing the stale token.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:408`

Orca implementation target:

- Use the same internal plan for system default and managed accounts.
- For system default, allow delegated refresh when safe.
- Re-read Keychain / `.credentials.json` after any delegated repair.

### 7. Store Attempt Metadata With Usage State

Add metadata to Claude provider state so the renderer can show precise state without parsing raw error strings.

Suggested metadata:

- `source`
- `attemptedSources`
- `failureKind`
- `credentialSource`
- `authProvenance`
- `deferredByLiveClaudeSession`
- `lastSuccessfulSource`

CodexBar basis:

- Source labels are preserved in fetch results for Codex OAuth and CLI.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Codex/CodexProviderDescriptor.swift:132`
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Codex/CodexProviderDescriptor.swift:253`
- Claude planner logs selected source and ordered steps.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:512`

Orca implementation target:

- Extend shared rate-limit types conservatively.
- Keep renderer copy based on structured state, not regex-only string matching.
- Continue to include sanitized diagnostics in main-process logs.

### 8. Replace Generic UI Failure For Known States

Known recoverable or deferred states should not render as "Refresh failed."

Suggested user-facing states:

- `Waiting for Claude session`
- `Refreshing sign-in`
- `Claude CLI unavailable`
- `Network issue`
- `Usage unavailable`
- `Refresh failed` only for unknown or terminal failures

CodexBar basis:

- Claude OAuth failures distinguish expired/delegated-refresh states from generic parse/network failure.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:338`
- Codex OAuth refresh errors include specific relogin messages for expired/revoked/reused refresh tokens.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexTokenRefresher.swift:17`

Orca implementation target:

- Update status-bar tooltip mapping to prefer structured `failureKind`.
- Keep the current auth regex fallback only for older/unstructured provider errors.

### 9. Add Debug-Only Source Visibility, Not A Normal Picker

Normal users should see automatic behavior only.

For debugging/support, it is useful to expose what happened:

- attempted OAuth
- delegated refresh attempted/skipped
- attempted CLI
- final source used
- sanitized failure kind

CodexBar basis:

- CodexBar has explicit source labels and source modes, but the app default remains automatic.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Codex/CodexProviderDescriptor.swift:35`
- Claude planner can describe selected and ordered sources.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeSourcePlanner.swift:99`

Orca implementation target:

- Add internal logs and possibly a debug tooltip line.
- Avoid a normal user-facing setting unless support data later proves it is needed.

### 10. Defer Web/Cookie Source Until After OAuth + CLI Parity

Do not implement Claude web/cookie tracking in the first pass.

CodexBar basis:

- CodexBar supports web as a later fallback source in Claude app auto.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeSourcePlanner.swift:177`
- CodexBar's web paths are substantial and involve browser session/cookie machinery.
  Reference: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeWeb/ClaudeWebAPIFetcher.swift:100`

Orca implementation target:

- Put web source behind a future milestone.
- First match the high-value resilience behavior: OAuth classification, delegated refresh, CLI fallback, deferred live-session state.

## Suggested PR Sequence

### PR 1: Internal Plan + Structured Outcomes

- Add internal Claude usage refresh plan.
- Add structured source attempt result and failure classification.
- Preserve existing behavior by executing only the current OAuth path first.
- Update logs and tests around classification.

CodexBar references:

- `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeSourcePlanner.swift:173`
- `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:461`
- `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Codex/CodexProviderDescriptor.swift:199`

### PR 2: CLI Fallback In Automatic Mode

- Add CLI source attempt using existing PTY parser.
- Fall back from OAuth to CLI for classified recoverable/auth cases.
- Preserve last successful snapshot when fallback fails.

CodexBar references:

- `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeSourcePlanner.swift:173`
- `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:461`
- `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/UsageFetcher.swift:1012`

### PR 3: Delegated Refresh + Retry

- Add safe delegated Claude CLI refresh for stale OAuth states.
- Re-read credentials after delegation.
- Retry OAuth once.
- Do not run delegated refresh when a live managed Claude session owns the credential rotation.

CodexBar references:

- `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:324`
- `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:345`
- `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:369`
- `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:408`

### PR 4: Renderer State Copy

- Replace generic `Refresh failed` for known Claude states.
- Prefer structured failure/deferred metadata over error regexes.
- Keep regex fallback for unstructured errors.

CodexBar references:

- `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:338`
- `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexTokenRefresher.swift:17`

## Test Plan

Add unit tests for:

- OAuth success remains OAuth success.
- OAuth missing credentials falls back to CLI.
- OAuth unauthorized attempts delegated refresh when safe.
- Delegated refresh re-reads credentials and retries OAuth once.
- Managed live Claude session returns deferred state instead of generic failure.
- System-default stale credentials use the same repair path.
- Missing scope produces actionable message.
- Network failure is classified separately from auth failure.
- CLI fallback unavailable preserves last known snapshot when present.
- Renderer maps known states to specific labels.

CodexBar references:

- Source planning: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeSourcePlanner.swift:173`
- OAuth delegated refresh: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift:324`
- Fallback discipline: `/Users/jinwoohong/stably/codexbar/Sources/CodexBarCore/Providers/Codex/CodexProviderDescriptor.swift:199`

## Non-Goals

- Do not add a normal user-facing source picker.
- Do not add Claude web/cookie tracking in the first implementation pass.
- Do not weaken managed-account live-session token safety.
- Do not rely on raw error-message regexes as the primary control flow.
