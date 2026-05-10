# Agent on_path detection — instrument before fixing

Captured 2026-05-10 from a PostHog dashboard cleanup pass on https://us.posthog.com/project/406068/dashboard/1562016. The `agent_picks_agent_kind_on_path` tile (insight 8478272) reads ~30% `on_path: false` for `claude-code` picks, which is implausible for users actively choosing the agent they intend to run. This doc is the handoff for picking up the fix.

A previous draft proposed a renderer-side hydration gate. That was wrong — the wizard already does hydrate-then-detect (commit `a327d946`, shipped in the same release that started emitting `onboarding_agent_picked`). The doc was diagnosing a race that no longer exists. The corrected direction is: **instrument the actual failure mechanism first, decide on the fix from data, not from speculation.**

## Symptom

Insight 8478272 reads:

| agent_kind | picks | on_path % |
|---|---|---|
| codex | 44 | 68.2% |
| claude-code | 33 | 72.7% |
| pi | 14 | 92.9% |
| opencode | 14 | 92.9% |
| cursor | 7 | 85.7% |
| gemini | 5 | 100.0% |

For the most-popular agents (`codex`, `claude-code`), ~30% of picks read `on_path: false`. Orca invokes these agents by typing the command into a terminal — a user who can run them at all *must* have the binary on PATH. So either Orca's view of PATH is incomplete at detection time, or these users genuinely can't run the agent and are picking aspirationally.

## Why the original "PATH-hydration race" hypothesis is wrong

The wizard's agent step at `src/renderer/src/components/onboarding/use-onboarding-flow.ts:207` calls `refreshDetectedAgents()`, which routes to `preflight:refreshAgents` → `refreshShellPathAndDetectAgents()` → `hydrateShellPath({ force: true })` → `mergePathSegments()` → `detectInstalledAgents()`. This sequence already awaits the login-shell spawn before running `which`. Commit `a327d946` ("improve agent detection on wizard mount", 2026-05-08) introduced this exact ordering.

`a327d946` shipped in v1.3.44, which is the same release that first emitted `onboarding_agent_picked`. Every row currently in tile 8478272 was produced by code that already does hydrate-then-detect. There is no renderer-vs-main race. Adding a renderer-side gate would be solving a problem that's already solved.

## What the gap actually has to be

Three remaining mechanisms can produce `on_path: false` for a real claude user:

### Mechanism 1 — `hydrateShellPath` itself is failing for a meaningful slice of users

The login-shell spawn at `src/main/startup/hydrate-shell-path.ts` has a 5-second ceiling. On a laptop with a slow `.zshrc` (corporate setup, nvm/asdf eager-load, p10k, async plugin loaders that block startup), the spawn hits the timeout and `hydrateShellPath` returns `ok: false`. `detectInstalledAgents` then runs against the seed-only PATH from `patchPackagedProcessPath` (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, etc.). That seed list does NOT include `~/.claude/local/bin` (where Anthropic's installer puts `claude`), `~/.codex/bin`, or other vendor-specific install dirs. `which claude` legitimately fails. `on_path: false` ships, but it's a hydration failure, not a "user doesn't have claude" signal.

Other shell failure modes inside `hydrateShellPath`: fish-shell quirks with `-ilc`, `EACCES` on the shell binary, broken rc files that crash before `printf`, shells that emit non-UTF-8 garbage that breaks the PATH parse.

### Mechanism 2 — The binary is genuinely not on the user's shell PATH

Users install agents in non-PATH locations and access them via aliases, dock shortcuts, or by typing the full path. They consider themselves a claude user; `which claude` legitimately returns nothing. Common cases: npm prefix not in PATH, `~/Applications/Claude.app/Contents/MacOS/claude` accessed via Spotlight, custom installer that drops into a directory the user never PATH-added.

### Mechanism 3 — Telemetry includes non-end-users

Dev environments, E2E test runs, staging builds, internal employees with intentionally weird installs. Less likely to be the dominant cause given the 33-pick sample size for claude-code, but non-zero.

The current schema can't distinguish between these. A user with mechanism (1) and a user with mechanism (2) emit the same `on_path: false` event. We can't pick the right fix without knowing which mechanism dominates.

## Plan: instrument first, fix second

**Step 1 — ship instrumentation.** Add two additive optional fields to `onboardingAgentPickedSchema`:

```ts
path_source: z.enum(['shell_hydrate', 'sync_seed_only']).optional(),
path_failure_reason: z.enum(['none', 'no_shell', 'timeout', 'spawn_error', 'empty_path']).optional()
```

`path_source`:
- `'shell_hydrate'` — `hydrateShellPath()` returned `ok: true` and the merged segments are in PATH at detection time.
- `'sync_seed_only'` — hydration failed (`ok: false`) and detection ran against `patchPackagedProcessPath`'s seed list only.

`path_failure_reason` answers "if `path_source = sync_seed_only`, why?" — closed enum derived from the actual failure paths in `src/main/startup/hydrate-shell-path.ts`:

| Value | Meaning | Code path |
|---|---|---|
| `'none'` | Hydration succeeded (paired with `path_source: 'shell_hydrate'`) | `child.on('close')` with non-empty segments |
| `'no_shell'` | `pickShell()` returned null (Windows or unrecognized shell env) | `hydrateShellPath` early-return at line 154-158 |
| `'timeout'` | 5s spawn ceiling fired SIGKILL — slow `.zshrc`, p10k async loaders, corporate setup, etc. | `setTimeout` callback at line 94-108 |
| `'spawn_error'` | `child.on('error')` fired — shell binary missing/EACCES, fork failure | line 114-121 |
| `'empty_path'` | Shell exited cleanly but `parseCapturedPath` returned no segments. Covers two sub-cases that produce the same observable: (a) parser couldn't find both `__ORCA_SHELL_PATH__` delimiters in stdout (rc file crashed mid-print, ANSI noise broke the parse, `printf` itself failed), and (b) delimiters found but the value between them is empty (genuinely empty `$PATH`). The two are diagnostically different but rare-(b) is vanishingly unlikely in the wild, so they share an enum value. If the data eventually shows `'empty_path'` dominant and ambiguous, split into `'parse_failed'` / `'path_empty'` — additive, no migration. | line 123-131, `segments.length === 0` |

This makes the dashboard answer two questions at once: (a) is the user reading correct PATH, and (b) if not, which failure mode are we hitting. Distinguishing `timeout` from `empty_path` from `spawn_error` directly drives the fix — slow `.zshrc` (`timeout`) wants a longer ceiling, parse failures (`empty_path`) want a different shell-invocation strategy, missing-shell (`spawn_error`) is unactionable and tells us to expect those rows as ambient noise.

`'none'` is load-bearing: it lets us write `path_failure_reason IS NOT NULL` filters that include the success case, instead of having to remember `IS NULL OR = 'none'`. Costs one extra string per success event.

**Implementation site**: `src/main/ipc/preflight.ts` is the natural owner. The classification needs to flow back to `refreshShellPathAndDetectAgents` from `hydrateShellPath`. Two structural changes required:

1. **Extend `HydrationResult` with `failureReason`.** `hydrate-shell-path.ts` knows which failure path fired — it just throws away the distinction today (every failure resolves to `{ segments: [], ok: false }`). Change the type to:

   ```ts
   type HydrationResult =
     | { ok: true; segments: string[]; failureReason: 'none' }
     | { ok: false; segments: []; failureReason: 'no_shell' | 'timeout' | 'spawn_error' | 'empty_path' }
   ```

   And tag each resolve site with the right reason — five sites, all in one file. The cached promise carries the discriminator forward; existing `result.ok` checks keep working unchanged.

2. **Plumb through `RefreshAgentsResult`.** `refreshShellPathAndDetectAgents` already has the `hydration` object — derive `pathSource` and `pathFailureReason` from it and add to the return type. Renderer reads both fields and attaches to `onboarding_agent_picked`.

This keeps the data flowing alongside the result it describes — no shared state, no synchronous getters off cached promises.

**Step 2 — wait for ~2 weeks of data and read the breakdown.**

Add two insights to dashboard 1562016 (project 406068, US Cloud):

**Insight A — share of `on_path: false` attributable to hydration failure, per agent**:

```sql
SELECT
  properties.agent_kind AS agent_kind,
  countIf(properties.on_path = false) AS on_path_false_total,
  countIf(properties.on_path = false AND properties.path_source = 'sync_seed_only')
    AS attributable_to_hydration_failure,
  countIf(properties.on_path = false AND properties.path_source = 'shell_hydrate')
    AS genuinely_not_on_path,
  round(
    countIf(properties.on_path = false AND properties.path_source = 'sync_seed_only') * 100.0
      / nullIf(countIf(properties.on_path = false), 0),
    1
  ) AS hydration_failure_share_pct
FROM events
WHERE event = 'onboarding_agent_picked'
  AND properties.path_source IS NOT NULL
  AND timestamp > now() - INTERVAL 30 DAY
GROUP BY agent_kind
HAVING on_path_false_total > 0
ORDER BY on_path_false_total DESC
```

The `hydration_failure_share_pct` column is the headline number for the Step-3 decision: if it's high, mechanism 1 (hydration is broken for these users) dominates; if it's low, mechanism 2 (binary genuinely missing) dominates.

**Insight B — path_failure_reason distribution** (POSIX-only — Windows always reports `no_shell` by design and would otherwise dominate this chart):

```sql
SELECT
  properties.path_failure_reason AS reason,
  count() AS picks,
  countIf(properties.on_path = false) AS resulted_in_on_path_false
FROM events
WHERE event = 'onboarding_agent_picked'
  AND properties.path_failure_reason IS NOT NULL
  AND properties.path_failure_reason != 'none'
  AND properties.platform != 'win32'
  AND timestamp > now() - INTERVAL 30 DAY
GROUP BY reason
ORDER BY picks DESC
```

Insight B is what drives the actual fix. If `timeout` dominates → lengthen the ceiling. If `empty_path` dominates → investigate shell-invocation strategy. If `spawn_error` dominates → the user's shell binary is missing/inaccessible and there's not much we can do in code; consider a UX state.

**Why the `platform != 'win32'` filter on Insight B**: `pickShell()` returns null on Windows by design (the seed PATH is canonical there), so every Windows `onboarding_agent_picked` emits `path_failure_reason: 'no_shell'`. Including those rows would make `'no_shell'` the dominant value in the chart for any user base with non-trivial Windows share, drowning out the actionable signal from POSIX users. `'no_shell'` is correctly emitted (it's the truth) — the dashboard just shouldn't read it as a fixable failure.

### Sample-size floor before reading Step-3

"~2 weeks" is a starting estimate, not a hard cutoff. Before declaring a dominant `path_failure_reason`, confirm the smallest non-zero bucket on Insight B has **≥30 events** for at least one popular agent (`claude-code` or `codex`). Below that, the breakdown is too noisy to drive a fix decision; extend collection to 3-4 weeks. Roughly: 33 picks/day × 14 days × ~30% on_path:false × 1/4 buckets = ~35 events/bucket worst-case at the 2-week mark, which is right at the floor.

PostHog API recipe: `.claude/skills/posthog-dashboard-edit/SKILL.md`. Validate via `POST /api/projects/406068/query/`, create with `POST /api/projects/406068/insights/` and `dashboards: [1562016]`, refresh-check via `?refresh=blocking`. Auth at `~/.posthog/credentials.json`.

**Step 3 — pick the fix from data.** The breakdown answers "which mechanism dominates":

- **If `path_source: 'sync_seed_only'` rows have most of the `on_path: false` events for claude-code/codex** → mechanism 1 dominates. Drill into Insight B for the failure reason:
  - `timeout` dominant → lengthen `SPAWN_TIMEOUT_MS` (5s → 10-15s on cold launch). Cheap, contained, the most common case for slow `.zshrc`/p10k/nvm-eager-load.
  - `empty_path` dominant → investigate shell-invocation strategy. Possibilities: switch from `-ilc` to `-lc` (skip interactive mode) to dodge fish-shell quirks; or print `PATH` more defensively (e.g., `echo "${DELIMITER}${PATH}${DELIMITER}"` instead of `printf` with positional `$PATH`).
  - `spawn_error` dominant → the user's `pickShell()`-resolved shell binary is missing or inaccessible. Probably can't fix in code; surface a "couldn't read your shell" UX state and a Refresh affordance in the wizard.
  - Investigate whether an additive seed for `~/.claude/local/bin`, `~/.codex/bin` is reasonable as a defense-in-depth backstop independent of which failure reason dominates.
- **If `path_source: 'shell_hydrate'` rows account for most `on_path: false` events** → mechanism 2 dominates. The user's PATH genuinely doesn't have the binary; `on_path` is reporting accurately. Decide whether the field is decision-bearing for the install-funnel work it was built for, or whether to drop it. Consider surfacing the install-instructions hint more aggressively for mechanism-2 users.
- **If both are roughly equal** → ship hydration fixes first (mechanism 1 is actionable), then re-evaluate the field's signal-to-noise.

**What we explicitly do NOT do now**:
- Don't change `detectInstalledAgents` timing. The wizard already calls the right path.
- Don't add `'partial'` to the `detection_state` enum. That conflates two failure modes.
- Don't deprecate `on_path`. The earlier reasoning that the field might be noise was based on the wrong diagnosis.

## Schema additions

In `src/shared/telemetry-events.ts`, on `onboardingAgentPickedSchema`:

```ts
const onboardingAgentPickedSchema = z
  .object({
    // ... existing fields ...
    path_source: z.enum(['shell_hydrate', 'sync_seed_only']).optional(),
    path_failure_reason: z
      .enum(['none', 'no_shell', 'timeout', 'spawn_error', 'empty_path'])
      .optional(),
  })
  .strict()
```

`.optional()` on both fields is load-bearing — events emitted before the deploy validate cleanly under `.strict()` schemas, mirroring the discipline already in the file.

`path_source` is intentionally redundant with `path_failure_reason` (`'shell_hydrate' ⇔ failure_reason === 'none'`). Justification: the dashboard's high-level "is hydration the problem" view stays clean as a binary instead of forcing every tile author to write the equivalent CASE expression inline. Cost is one extra string per event — accepted.

### Cross-boundary type sync

The `path_failure_reason` enum and the `HydrationResult` discriminator in `src/main/startup/hydrate-shell-path.ts` must stay in lockstep, but `src/shared/` cannot import from `src/main/` (it'd violate the renderer-bundling discipline). The bridge: declare the shared alias in `src/shared/types.ts`:

```ts
// src/shared/types.ts
export type ShellHydrationFailureReason =
  | 'none'
  | 'no_shell'
  | 'timeout'
  | 'spawn_error'
  | 'empty_path'
```

`hydrate-shell-path.ts` imports `ShellHydrationFailureReason` from `'../../shared/types'` and uses it for `HydrationResult.failureReason`. `telemetry-events.ts` mirrors the same enum into the schema and applies the `_OnboardingChecklistItemSync`-style bidirectional `extends` guard against `ShellHydrationFailureReason`. Adding a new failure mode in either place without updating the shared alias fails the build at the guard.

This matters more than the discipline itself: without the guard, a future hydration mode added in `hydrate-shell-path.ts` ships a `failureReason` value the schema rejects → the strict validator drops the **entire** `onboarding_agent_picked` event at parse time → we lose the `agent_kind`/`on_path` data on that pick, strictly worse than the ambiguity we have today. The compile-time guard is what makes the closed enum safe.

## Code changes

`src/main/startup/hydrate-shell-path.ts`:

```ts
type HydrationResult =
  | { ok: true; segments: string[]; failureReason: 'none' }
  | {
      ok: false
      segments: []
      failureReason: 'no_shell' | 'timeout' | 'spawn_error' | 'empty_path'
    }
```

Tag each resolve site:
- `pickShell()` returned null → `failureReason: 'no_shell'`
- `setTimeout` SIGKILL fires → `failureReason: 'timeout'`
- `child.on('error')` fires → `failureReason: 'spawn_error'`
- `child.on('close')` fires with empty segments → `failureReason: 'empty_path'`
- `child.on('close')` fires with non-empty segments → `failureReason: 'none', ok: true`

`src/shared/types.ts` — declare both shared aliases here so preload, main, and renderer all import from the same source:

```ts
export type ShellHydrationFailureReason =
  | 'none'
  | 'no_shell'
  | 'timeout'
  | 'spawn_error'
  | 'empty_path'

export type PathSource = 'shell_hydrate' | 'sync_seed_only'
```

`src/main/ipc/preflight.ts`:

```ts
import type { PathSource, ShellHydrationFailureReason } from '../../shared/types'

export type RefreshAgentsResult = {
  agents: string[]
  addedPathSegments: string[]
  shellHydrationOk: boolean   // already present
  pathSource: PathSource   // new
  pathFailureReason: ShellHydrationFailureReason   // new — typed against shared alias
}
```

`refreshShellPathAndDetectAgents` derives both fields from the `hydration` object it already has: `pathSource: hydration.ok ? 'shell_hydrate' : 'sync_seed_only'`, `pathFailureReason: hydration.failureReason`. Typing `pathFailureReason` against the shared alias keeps the IPC boundary in lockstep with the renderer-visible enum — drift one without the other and the build fails.

**Plumb through preload**: TWO files need updating:
- `src/preload/api-types.ts` — has the renderer-visible `RefreshAgentsResult` mirror (around line 249). Add `pathSource: PathSource` and `pathFailureReason: ShellHydrationFailureReason`, importing both types from shared. Without this update the renderer compiles fine (the IPC return is structurally compatible) but reads `undefined` for both fields at runtime — exactly the silent-instrument-dark failure mode the renderer-end attachment test (Tests section) is designed to catch.
- `src/preload/index.ts` — wires the IPC. No type changes here, just confirm the new fields flow through.

(Note: `.ts` not `.d.ts` for both per `AGENTS.md` — `.d.ts` would silently drop unresolved type references to `any`.)

Then `src/renderer/src/store/slices/detected-agents.ts` exposes the new fields off the store so the wizard can read both at click time.

`src/renderer/src/components/onboarding/use-onboarding-flow.ts`: the `onboarding_agent_picked` track call (around line 111) reads `pathSource` and `pathFailureReason` from the store and adds both to the event payload.

## UX

No user-visible change in this step. The instrumentation is silent. Once the data lands and we pick a fix, UX implications get re-evaluated. Specifically: if mechanism 1 dominates, the "No agents detected. Pick one to install later" callout is misleading for users whose hydration timed out — they may have agents installed and Orca just can't see them. The Refresh button (in the Agents settings pane) handles this case but isn't surfaced in the wizard. That's a follow-up product decision, not part of this instrumentation step.

## Tests

- `src/main/startup/hydrate-shell-path.test.ts` — five cases, one per failure reason. Use the `spawner` and `shellOverride` test hooks already exposed: success path returns `{ ok: true, failureReason: 'none' }`; null shell returns `'no_shell'`; SIGKILL-on-timeout returns `'timeout'`; spawn error returns `'spawn_error'`; close-with-empty-stdout returns `'empty_path'`.
- `src/main/ipc/preflight.test.ts` — `refreshShellPathAndDetectAgents` returns `pathSource: 'shell_hydrate', pathFailureReason: 'none'` when hydration succeeds; `'sync_seed_only'` paired with the corresponding failure reason for each ok:false case. Mock `hydrateShellPath` at the module boundary.
- `src/main/telemetry/validator.test.ts` — happy-path validation case for `onboarding_agent_picked` including both new fields. Existing strict-rejection tests cover unknown keys.
- **Renderer-end attachment test** for `use-onboarding-flow.ts`: render the wizard with a mocked store where `pathSource: 'sync_seed_only'` and `pathFailureReason: 'timeout'`, click an agent, assert the `track` spy receives both fields on the `onboarding_agent_picked` payload. This is the only test that catches "the plumbing compiles and unit tests pass but the wizard forgot to read the fields from the store." Without it, the entire instrument-first plan can ship dark for two weeks before a dashboard read shows the fields are null-only.

## Repo state context

- **Worktree**: `/Users/thebr/orca/workspaces/orca/agent-on-path-detection`. Branch `brennanb2025/agent-on-path-detection` off `origin/main` HEAD (release v1.3.47).
- **Released**: PR #1608 `feat(telemetry): onboarding cohort + extension events` shipped in v1.3.43+ (~2026-05-09). The `onboarding_agent_picked` event with the `on_path` field has data from that point onward. Commit `a327d946` is the wizard-mount detection improvement that already does hydrate-then-detect.
- **PostHog project**: 406068 (US Cloud). Dashboard 1562016 ("Orca onboarding funnel (new users)").
- **Sibling docs**: `docs/onboarding-telemetry-extensions.md` is the canonical reference for *why* `on_path` and the rest of the wizard fields exist. §4 "onboarding_agent_picked" explains the field semantics and original design intent.

## Affected dashboard tiles

- 8478272 — Agent picks: agent_kind × on_path. Add a sentence to the description: *"on_path: false includes both genuine 'not on PATH' and shell-hydration failures. Pair with insights A and B (path_source and path_failure_reason) to disambiguate."*
- 8478279 — Agent picks: detection_state × detected_count × from_collapsed. **Same caveat applies**: `detected_count` is computed from the same `detectInstalledAgents()` run as `on_path`, so under `path_source: 'sync_seed_only'` it under-reads for the same reason. Add to the description: *"detected_count is biased downward when shell-hydration fails — same disambiguation as 8478272 applies."*
- **New tile A** — Agent picks: agent_kind × path_source × on_path. Answers "is hydration the problem."
- **New tile B** — Path failure reason distribution. Answers "if hydration fails, which mode."

Both tiles drive the Step-3 fix decision.

## What NOT to do

- **Don't** add a renderer-side hydration gate. The wizard already runs `refreshDetectedAgents` (which awaits `hydrateShellPath({ force: true })`). The earlier draft of this doc proposed this fix and it would be duplicative work.
- **Don't** tighten `which`-based detection (e.g., adding `--version` probes). The mechanism is correct; we don't yet know what's wrong.
- **Don't** ship a fix before the instrumentation reads back. Picking a direction (mechanism 1 vs 2) without data is exactly how the previous draft of this doc went off-track.
- **Don't** read `process.env.PATH` synchronously and call it "good enough." Sync-seed PATH is incomplete by design on macOS/Linux.
- **Don't** combine `path_source` and `path_failure_reason` into a single field. Keeping `path_source` as a binary lets the dashboard's high-level "is hydration the problem" view stay clean (two values), while `path_failure_reason` carries the detail for drilldown. Collapsing them produces 5+ values per row in the high-level view, which obscures the headline.
- **Don't** ship the timeout fix without first confirming `timeout` is the dominant `path_failure_reason`. If `empty_path` is the dominant case, lengthening the timeout does nothing.
