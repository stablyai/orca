# Multi-Agent Composer & Token Usage Dashboard — Design

Date: 2026-10-30
Branch: `feat/multi-agent-composer-and-usage-dashboard`
Status: awaiting approval

## Intent

Two features for our Orca fork (upstream: `stablyai/orca`):

1. **Multi-agent workspace creation.** The New Workspace composer picks a
   *list* of agents instead of one. The same harness may appear multiple
   times, each entry with its own CLI flags, model/effort/permission
   choices, and an optional custom display name. Creating the workspace
   opens one agent tab (or chat) per entry.
2. **Token usage dashboard.** A chart icon at the bottom-left of the left
   sidebar opens a drawer showing per-model token spend, quota windows,
   and a smooth daily time-series chart — covering every provider Orca
   already scans, plus a new `omp` usage store.

Why: parallel fleets of the same harness with different flags (e.g.
`codex --profile fast` + `codex --profile safe`) are currently impossible
without manual terminal work, and token spend is only visible in
Settings → Stats, which is too far away for daily monitoring.

## Goals

- Composer supports N agent entries; one harness N times; per-entry
  flags/model/effort/permission and custom name; one workspace, N tabs.
- Custom names survive restart and win over auto-generated tab titles.
- Retry of a failed creation replays the full agent list.
- Bottom-left sidebar icon opens a usage drawer; quotas + per-model
  table + daily chart; includes `omp` data; no new chart library.
- Plugin-compatible data shapes: the per-entry launch record is shaped
  so it can later move into the reserved `agentHarnesses` plugin
  contribution point without a data migration.

## Non-goals

- N-workspaces-per-agent mode (user explicitly chose one workspace, N panes).
- Implementing the reserved plugin points (`agentHarnesses`,
  `statusBarItems`, `sidebarCards`) — upstream keeps them empty-only; we
  only keep our data shapes compatible.
- Any charting library (recharts/d3/chart.js). House style is custom
  CSS-grid bars.
- Changes to omp itself (we only read its session files).
- Structured-chat surfaces for the *secondary* agents when the entry
  carries CLI flags: flags apply to terminal launches; a chat entry
  without flags may still open as chat per the user's Chat UI setting.

## Builder-check resolutions (2026-10-30)

These answers came from the builder review; they are part of the spec.

1. **Agent-less branch when the list is used.** With `agent: null` the
   pipeline seeds a blank initial terminal and suppresses linked-item
   prompts. For the multi-agent path we do NOT accept that: the launch
   loop suppresses the seeded blank tab (absorb or close it before the
   entries launch), and linked-work-item prompts ARE built and delivered
   to every entry (pass the linked-item prompt as the entry prompt when
   no `quickPrompt` exists).
2. **Creation surfaces.** v1 gates the list to local git-worktree
   targets (user decision). Folder-workspace, remote-host
   (`workspaceRunContext`) and ephemeral-VM targets collapse the rows
   to a single agent via the legacy path (first row's agent, flags and
   name dropped with an inline notice in the composer when a
   non-git-worktree target is selected with >1 rows). "Create more"
   (createMultiple) replays the N launches naturally per workspace.
3. **Blank Terminal.** Quick pick `null` stays the "blank terminal"
   representation. A single row without flags and without a custom name
   submits through the legacy `request.agent` path (byte-identical to
   today); any row with flags or a custom name, or any second row,
   switches the submit to the `agentLaunches` list. The list itself
   always has ≥1 entry.
4. **Per-entry surface.** `agentLaunches` entries gain
   `requestedSurface?: 'chat' | 'terminal'` and it is honored per entry
   via `launchAgentInNewTab`'s existing `requestedSurface`; an entry
   with `agentArgs` forces terminal (flags cannot apply to a chat).
5. **Post-success launch failures are toast-only in v1.** Creation
   Retry (pending panel) replays the list because it is on the request;
   failures after successful creation surface through the existing
   failure toasts, no retry UI.
6. **omp session roots.** `OmpUsageStore` reuses
   `resolveOmpSessionsDir` (`src/main/ai-vault/omp-session-root.ts`,
   honoring OMP_CODING_AGENT_DIR / OMP_PROFILE / PI_* / XDG profiles)
   and scans ALL resolved profile roots, for parity with ai-vault.
7. **Tab placement.** All entries launch into the workspace's default
   tab group with `pendingActivationSpawn: true`; the first entry's tab
   receives focus; no per-entry splits in v1.
8. **reasoningTokens** are NOT folded into output. They render as a
   separate table column (and a chart tooltip detail), keeping
   input+cached+output the stacked segments; totals never
   double-count.
9. **Dashboard scope.** Default `'all'` (machine-wide spend, which is
   where most local omp data lives), with an 'orca' / 'all' toggle in
   the drawer header (user decision). Quota rows are unaffected.

## Anti-goals

- Extending the host-side creation pipeline with an agents[] array
  (`WorktreeCreationRequest` stays single-agent for the primary seed;
  multi-launch is a renderer-side sequence). A wrong guess here would
  fork the creation pipeline and break Retry semantics.

## Current state (verified in code)

- Composer: single `quickAgent: TuiAgent | null`
  (`NewWorkspaceComposerAgentSection.tsx`, `new-workspace-composer-card-props.ts`).
- Per-launch flags exist end-to-end: `AgentLaunchIntent.agentArgs`
  (tri-state), `AgentPickerDraft` + `agentPickerLaunchInputs()`
  (`shared/agent-launch-picker.ts`), `AgentLaunchSetupPanel` UI,
  `resolveAgentLaunchCommand` tokenizes/shell-quotes args.
- `launchAgentInNewTab` (`lib/launch-agent-in-new-tab.ts`) launches an
  agent into an existing worktree; `LaunchAgentInNewTabArgs` already
  accepts `agentArgs`, `sessionOptions`, `prompt`, `promptDelivery`, and
  **`quickCommandLabel`** (persisted tab label; suppresses generated
  titles per `terminal-tab-presentation.ts`).
- Drawer precedent: `WorkspaceKanbanDrawer`/`WorkspaceKanbanSheet`
  (`Sheet side="left"`, live sidebar width via `--workspace-sidebar-live-width`),
  transient state `agentDashboardDrawerOpen` in ui-slice
  (`ui-slice-contract-preferences.ts`).
- Usage data: per-provider stores (`ClaudeUsageStore`, `CodexUsageStore`,
  `OpenCodeUsageStore`, `MuseUsageStore`) behind
  `UsageProviderStoreLifecycle`; IPC `getSummary|getDaily|getBreakdown|
  getRecentSessions` per provider prefix; quotas in `RateLimitState`
  (push updates); daily chart precedent `ClaudeUsageDailyChart`
  (CSS-grid stacked bars). `UsageProviderId` union:
  `'claude'|'codex'|'devin'|'opencode'|'muse'|plugin:*`.
- omp sessions: `~/.omp/agent/sessions/<slug-cwd>/*.jsonl`; record types
  `session` (`cwd`, `timestamp`), `message` with
  `message.usage {input, output, cacheRead, cacheWrite, reasoningTokens,
  cost.total}` + `message.model` + `message.provider` (verified on real
  local files; cost is precomputed by omp — no pricing table needed).

## Approaches considered

### Feature 1 — how N agents get launched

**A. Host-side multi-launch in the creation pipeline** (extend
`WorktreeCreationRequest` with `agents[]`, teach the runtime to spawn N
panes). Rejected: forks the carefully-engineered creation/Retry/pending
pipeline; `resolveLaunchAgentTabId` assumes one agent tab; high blast
radius for a UX convenience.

**B. Renderer-side sequential launch via the existing launch stack**
(chosen). The creation request keeps its single primary `agent` (or
`null`), plus a serializable `agentLaunches` list. After the workspace
is created and activated, each entry is launched with
`launchAgentInNewTab` — the same path the tab-bar quick-launch uses, so
prompt delivery, surface routing (chat vs terminal), flag application,
`quickCommandLabel`, and error toasts all come for free.

Within B, two sub-choices:

- **B1: first entry rides the existing seeded path** (request.agent +
  startupPlan), remaining entries post-create. Rejected: two code paths,
  divergent flag/name handling for entry 0 vs 1..N.
- **B2 (chosen): all N entries launch post-create** via
  `launchAgentInNewTab`; `request.agent` stays `null` when the list is
  used. Single new code path, uniform semantics; the legacy single-agent
  flow remains byte-identical for everyone not using the list.

### Feature 2 — where the dashboard lives

**A. Full-screen top-level view** (extend `TopLevelView` union,
`openUsagePage()`, `AppWorkspaceShell` case). Rejected for v1: heavy
chrome (view switch + back-navigation), while the data is glanceable.
**B. Popover from the toolbar icon.** Rejected: too small for quota +
chart + table.
**C (chosen): Left drawer (`Sheet side="left"`, ~480px)** mirroring
`WorkspaceKanbanDrawer`: slides in next to the sidebar, closes on
outside click/Escape, content stays mounted while animating out
(lingering pattern). Balanced density, precedented pattern, zero router
changes.

### Feature 2 — omp data source

**A. New `OmpUsageStore` following `CodexUsageStore`** (chosen):
independent JSONL scan of `~/.omp/agent/sessions`, provider id `omp`,
IPC prefix `ompUsage:*`, feeds StatsPane and the drawer.
**B. Extend the AI Vault scanner.** Rejected: ai-vault parsing is
transcript-search oriented; usage aggregates need the provider-store
projections (daily, breakdown, snapshot) the dashboard consumes.

## Design

### Part 1 — Composer agent list

**State model.** Replace `quickAgent: TuiAgent | null` in the composer
state with an ordered list (min length 1):

```ts
type ComposerAgentEntry = {
  id: string                 // stable row id
  draft: AgentPickerDraft    // existing type: agent, choices, arguments, surface
  displayName?: string       // trimmed; empty = catalog label
}
```

`AgentPickerDraft` (existing) already holds agent + arguments + model +
effort + permission + surface. Adding rows of the same harness is
naturally supported because entries are keyed by `id`, not by agent.

**UI.** In `NewWorkspaceComposerAgentSection`:
- Row 0 renders as today (agent combobox + "Configure agents" gear).
- Each additional entry renders as a compact row: agent combobox,
  inline "flags" summary chip (from the draft, e.g. `--profile fast`),
  name input (placeholder = catalog label), remove button.
- A per-row gear opens the **existing** `AgentLaunchSetupPanel` bound to
  that row's draft (model/effort/permission/arguments editor — reused
  as-is; it is already a standalone popover).
- "+ Add agent" button appends an entry. Cap at 8 entries with a toast
  beyond (guardrail, not a limit users hit in practice).
- Empty name ⇒ no `quickCommandLabel` passed ⇒ default catalog label.

**Submit.** `submitQuick` builds the `WorktreeCreationRequest` as
today, but with `agent: null` (when >0 entries with drafts exist) and a
new serializable field:

```ts
/** Post-create agent launches; replayed on Retry. Empty = legacy flow. */
agentLaunches?: Array<{
  agent: TuiAgent
  agentArgs?: string | null
  sessionOptions?: Record<string, string>
  sessionOptionsYieldToAgentArgs?: true
  displayName?: string
}>
```

These are exactly the `LaunchAgentInNewTabArgs` fields we need minus
runtime handles — shaped deliberately as a future
`agentHarnesses`-style data record (plain data: agent id + args +
label), so moving to a plugin contribution later is a type move, not a
migration.

**Launch sequencing.** After creation completes and the workspace
activates (same sequencing point `composer-create-handoff` already
owns), the handoff launches each entry in order via
`launchAgentInNewTab({ agent, worktreeId, agentArgs, sessionOptions,
prompt: quickPrompt, promptDelivery, quickCommandLabel: displayName,
groupId })`. Prompt delivery mode follows the composer's existing
`promptDelivery` choice; each launch gets its own delivery result
toast on failure (existing machinery). If an individual launch fails
(prompt or command build), the workspace and prior launches stay; the
failure surfaces via the existing toast, and Retry replays the whole
list (idempotency: launches target an existing worktree, so a retry
after success duplicates tabs only if the user retries a *succeeded*
creation — the pending panel already only offers Retry on error).

**Custom names.** `quickCommandLabel` on the launch args → persisted tab
label → wins over generated titles, survives restart (verified in
`tabs-hydration.ts` / `terminal-tab-title-batch.ts`). No new storage.

**Naming collisions.** Two entries with the same empty name get the same
catalog label — acceptable (they are still distinguishable by flags
chip and order); no dedup logic.

### Part 2 — Usage dashboard drawer

**Entry point.** `SidebarToolbar` left cluster, next to
`SidebarSettingsHelpMenu`: ghost `size="icon-xs"` button, lucide
`ChartColumn` icon (`size-3.5`), `Tooltip side="top" sideOffset={4}`,
i18n title "Token usage". Gated by a new `GlobalSettings.showUsageButton`
(default `true`), integrated with the `HideSidebarMenu` context-menu
pattern from `SidebarNav` so users can hide it like nav buttons.

**State.** Transient `usageDrawerOpen: boolean` + setter in the ui slice,
mirroring `agentDashboardDrawerOpen` (not persisted). Mounted from
`sidebar/index.tsx` next to `WorkspaceKanbanDrawer` as
`UsageDashboardSidebarHost` (closes when the sidebar closes; mutual
exclusion with the workspace board drawer, same effect pair as the
agent dashboard host).

**Drawer layout** (`components/usage-dashboard/`):
- `UsageDashboardDrawer.tsx` — `Sheet side="left"` per
  `WorkspaceKanbanSheet` (live sidebar width, status-bar reserve);
  width `w-[480px]`; header with title + refresh + period selector
  (7/14/30 days, default 14); body scrollable.
- **Quota strip**: per-provider rows reused/adapted from
  `UsageRosterPanel`'s `UsageRow`/`UsageMetric` (session/weekly/monthly
  windows, reset countdown, plan label). Data: existing
  `rateLimits` slice.
- **Daily chart**: `UsageDashboardDailyChart.tsx`, a generalized
  `ClaudeUsageDailyChart` — CSS-grid stacked bars (one column per day,
  stacked segments input/cached/output), `--chart-1..5` tokens,
  per-segment Radix Tooltip, `transition-[height] duration-300
  ease-out` on segments for smoothness (respects
  `prefers-reduced-motion` via Tailwind's `motion-safe:` prefix).
  Series: merged per-provider daily points via a new
  `usage-dashboard-series.ts` that extends
  `usage-overview-daily-series.ts` to include the `omp` provider.
- **Per-model table**: rows = model × provider
  (`getBreakdown kind:'model'` per provider), columns = model, tokens
  (input/output/cache), est. cost; sorted by total tokens desc; sticky
  header; period-scoped like the chart. Reuses number formatting from
  the existing stats panes.
- **Footer**: total tokens + total est. cost for the selected period,
  and a link button "Open full stats" → `openSettingsTarget({ pane:
  'stats' })` (existing deep link).

**Data wiring.** Renderer slice `usageDashboard` modeled on the existing
usage-provider slices: on drawer open, fetch summaries + daily +
breakdowns for all enabled providers (including `omp`) and quotas;
refresh button re-triggers `refreshRateLimits` + provider refreshes.
All fetching goes through existing `window.api.*` bridges — no new IPC
except `ompUsage:*`.

### Part 3 — `OmpUsageStore`

`src/main/omp-usage/` following `codex-usage/` as the template:

- `types.ts` — `OmpUsageSession` (sessionId, model, provider, cwd,
  repoId/worktreeId attribution, totals {input, output, cacheRead,
  cacheWrite, reasoningTokens}, costUsd), `OmpUsageDailyAggregate`,
  snapshot/summary/breakdown types mirroring codex ones.
- `transcript-file-discovery.ts` — walk
  `~/.omp/agent/sessions/*/*.jsonl` (respecting a future
  `OMP_AGENT_HOME` if trivially detectable; otherwise fixed home).
- `transcript-record-parser.ts` — line-delimited JSON; for each record
  with `type === 'message'` and `message.usage`, accumulate per session
  file: tokens keyed by `message.model` (fallback `message.provider`),
  cost from `message.usage.cost.total`, session start from the `session`
  record's `timestamp`, worktree attribution by resolving
  `session.cwd` against known repos/worktrees (same helper approach as
  the codex store's `getRepos`/`getAllWorktreeMeta` injection).
  Incremental resume: stat-keyed (mtime+size) line-offset cache like
  the codex parser — omp appends to files.
- `store.ts` — `OmpUsageStore extends UsageProviderStoreLifecycle`,
  `SCHEMA_VERSION = 1`, persisted `orca-omp-usage.json`.
- Registration: `UsageProviderId` gains `'omp'`; handler registration
  next to the others in `usage-provider-handlers.ts` (prefix
  `ompUsage`); instantiate in `main-process-observers.ts`; preload via
  `createUsageProviderApi('ompUsage', ...)`.
- Projections feed the existing StatsPane dropdown (add `OmpUsagePane`)
  and the dashboard series/table.

Attribution edge: sessions whose `cwd` matches no known worktree count
under an "unattributed" bucket (same as other providers).

## Constraints

- House style: shadcn primitives, lucide icons, CSS-variable colors in
  both light and dark, `translate()` for every user-facing string
  (keys follow the `auto.<area>.<Component>.<hash>` convention).
- No new runtime dependencies.
- All new state serializable where it crosses process boundaries
  (agentLaunches is part of WorktreeCreationRequest → must survive
  JSON round-trip; AgentPickerDraft is not serializable as-is, hence
  the flat `agentLaunches` entry shape).
- The composer's keyboard submit chord must submit the list.

## What's left to the builder

- Exact place where `composer-create-handoff` should hook the
  post-activation launch loop (it already sequences focus/activation;
  the launch loop belongs at the same point where the single-agent seed
  completes).
- Whether `quickCommandLabel` needs trimming normalization at the
  launch boundary (probably reuse whatever `createTab` does).
- i18n key hashes (generated per repo convention).
- Component test layout following the neighboring `.test.tsx` files
  (vitest + testing-library patterns already in the repo).
- The `prefers-reduced-motion` check for chart segment transitions.

## Verification (acceptance)

- Composer: create a workspace with two `codex` entries (`--profile`
  flags differing) + custom names → both tabs open in one workspace,
  panes show custom names, flags visible in the launched process
  command line, names survive app restart.
- Composer retry: force a creation failure (bad base ref), Retry →
  agent list replays.
- Drawer: icon opens/closes smoothly; quotas, chart, model table render
  with local Claude/Codex/omp data; period switch updates chart+table;
  "Open full stats" deep-links to Settings → Stats & Usage.
- `ompUsage:getDaily` returns non-zero days for the local
  `~/.omp/agent/sessions` corpus.
- eng-gates `gate fast` on touched files; `gate full` before done.