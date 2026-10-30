# Multi-Agent Composer & Usage Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Composer supports N agent entries (same harness multiple times, per-entry CLI flags + custom names → one workspace, N tabs), a bottom-left sidebar icon opens a token-usage drawer (quotas, per-model table, daily chart) covering all existing providers plus a new `omp` usage store.

**Architecture:** Renderer-side sequential launch: `WorktreeCreationRequest` gains a serializable `agentLaunches` list; after creation completes, each entry launches via the existing `launchAgentInNewTab` stack (flags, surface routing, prompt delivery, `quickCommandLabel` all reused as-is). The usage drawer is a left `Sheet` mirroring `WorkspaceKanbanDrawer`, fed by existing usage-provider IPC plus a new `OmpUsageStore` (JSONL scan of `~/.omp/agent/sessions`) that plugs into the existing `UsageProviderStoreLifecycle`/IPC/slice machinery.

**Tech Stack:** Electron + React 19 + TypeScript, Zustand, shadcn/Radix, Tailwind v4, vitest; no new dependencies.

**Spec:** `docs/specs/2026-10-30-multi-agent-composer-and-usage-dashboard-design.md` (includes the 9 builder-check resolutions — binding).

## Global Constraints

- No new runtime dependencies; no chart library.
- All user-facing strings via `translate()` with `auto.<area>.<Component>.<hash>` keys.
- shadcn primitives + lucide icons only; CSS-variable colors defined in BOTH light and dark in `src/renderer/src/assets/main.css`.
- `agentLaunches` entries are plain serializable data (survive JSON round-trip into `WorktreeCreationRequest` and Retry).
- The legacy single-agent composer path stays byte-identical when the list is a single flag-less, name-less row (builder-check resolution 3).
- omp `reasoningTokens` never fold into output totals (resolution 8).
- Multi-agent list gated to local git-worktree targets; folder/remote/VM collapse to legacy single-agent (resolution 2).

## Review Focus

- Retry after creation failure replays the whole list from the persisted request (no dropped entries, no duplicate blanks).
- Same-harness rows keep distinct tab labels and both land in the workspace's default group (no clobbering, no splits).
- A row with `agentArgs` forces terminal surface even when Chat UI prefers chat (resolution 4).
- Zero-usage and empty-provider states render placeholders, never NaN/undefined, in chart, table and footer.
- Stale/corrupt omp JSONL lines (partial writes, non-usage records, missing model) are skipped without killing the scan; totals double-check `totalTokens` vs component sums.
- Drawer closes cleanly when sidebar collapses or workspace board opens (mutual exclusion, lingering unmount).
- `ompUsage:getDaily` returns non-zero days for the real local corpus (acceptance in spec).

---

### Task 1: `agentLaunches` on `WorktreeCreationRequest` + legacy-path predicate

**Files:**
- Modify: `src/renderer/src/lib/pending-worktree-creation.ts`
- Test: `src/renderer/src/lib/pending-worktree-creation.test.ts` (create if absent)

**Interfaces:**
- Produces: `type AgentLaunchListEntry = { agent: TuiAgent; agentArgs?: string | null; sessionOptions?: Record<string, string>; sessionOptionsYieldToAgentArgs?: true; requestedSurface?: 'chat' | 'terminal'; displayName?: string }`; `WorktreeCreationRequest.agentLaunches?: AgentLaunchListEntry[]`; `function usesAgentLaunchList(request: Pick<WorktreeCreationRequest, 'agent' | 'agentLaunches'>): boolean` (true iff list present AND (length > 1 OR any entry has agentArgs/sessionOptions/displayName)).

- [ ] **Step 1: Write the failing test**

Test `usesAgentLaunchList` truth table: single bare entry → false (legacy); two entries → true; one entry with flags/name/options → true; absent list → false. Test `agentLaunches` survives `JSON.parse(JSON.stringify(request))` round-trip.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/lib/pending-worktree-creation.test.ts`
Expected: FAIL (types/functions not defined).

- [ ] **Step 3: Implement**

Add `AgentLaunchListEntry` + optional `agentLaunches` field (doc comment: post-create launches replayed on Retry; empty = legacy flow) and `usesAgentLaunchList` in `pending-worktree-creation.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/renderer/src/lib/pending-worktree-creation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/pending-worktree-creation.ts src/renderer/src/lib/pending-worktree-creation.test.ts
git commit -m "feat(composer): serializable agentLaunches list on WorktreeCreationRequest"
```

### Task 2: Composer agent-row state model

**Files:**
- Create: `src/renderer/src/hooks/composer-state/composer-agent-entries.ts`
- Test: `src/renderer/src/hooks/composer-state/composer-agent-entries.test.ts`

**Interfaces:**
- Consumes: `AgentPickerDraft` (`src/shared/agent-launch-picker.ts`), `agentPickerLaunchInputs(draft, entry)` from Task 1's sibling module (already exists).
- Produces: `type ComposerAgentEntry = { id: string; draft: AgentPickerDraft; displayName: string }`; pure helpers `createComposerAgentEntry(agent: TuiAgent): ComposerAgentEntry`; `entriesToLaunchList(entries: ComposerAgentEntry[]): AgentLaunchListEntry[]` (maps via `agentPickerLaunchInputs`, includes `requestedSurface` from draft, trims displayName, omits empty); `isLegacySingleAgentSubmit(entries: ComposerAgentEntry[]): boolean` (false iff >1 rows OR any row has arguments/non-empty name/sessionOptions).

- [ ] **Step 1: Write the failing tests**

`createComposerAgentEntry('codex')` → draft.agent codex, empty name. `entriesToLaunchList` on two same-harness entries with different arguments and names → two `AgentLaunchListEntry` records with correct agentArgs/displayName/requestedSurface. `isLegacySingleAgentSubmit` truth table mirrors Task 1. Two entries, same empty name → both entries emitted (no dedup, resolution: collisions allowed).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/hooks/composer-state/composer-agent-entries.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/renderer/src/hooks/composer-state/composer-agent-entries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/composer-state/composer-agent-entries.ts src/renderer/src/hooks/composer-state/composer-agent-entries.test.ts
git commit -m "feat(composer): agent entry list state model"
```

### Task 3: Multi-row agent section UI

**Files:**
- Modify: `src/renderer/src/components/new-workspace/NewWorkspaceComposerAgentSection.tsx`
- Modify: `src/renderer/src/components/new-workspace/new-workspace-composer-card-props.ts`
- Test: `src/renderer/src/components/new-workspace/NewWorkspaceComposerAgentSection.test.tsx`

**Interfaces:**
- Consumes: `ComposerAgentEntry` + mutators from Task 2.
- Produces: props extension on `NewWorkspaceComposerCardProps`: `agentEntries: ComposerAgentEntry[]`, `onAgentEntryChange(id: string, patch: Partial<ComposerAgentEntry>): void`, `onAddAgentEntry(): void`, `onRemoveAgentEntry(id: string): void`, `agentEntriesLocked: boolean` (true when target is folder/remote/VM — rows collapse to single-agent notice per resolution 2).

- [ ] **Step 1: Write the failing tests**

Renders row 0 as today (combobox + Configure agents gear). "+ Add agent" appends a row. Row shows combobox, flags chip (draft arguments), name input (placeholder = catalog label), remove button (not on row 0 when it's the only row). Per-row gear opens `AgentLaunchSetupPanel` popover bound to that row's draft. When `agentEntriesLocked` and rows > 1 → inline notice "Multiple agents apply only to local git workspaces; later rows will be ignored" (translate key), rows beyond 0 disabled. Cap: 8 rows, "Add agent" disabled at cap with toast on click.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/components/new-workspace/NewWorkspaceComposerAgentSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Keep row 0 rendering identical to today when it is the only row and carries no flags/name (legacy visual parity). Additional rows: compact row layout per spec; reuse `AgentCombobox`, `AgentLaunchSetupPanel`, `Button`, `Tooltip` primitives. Name input width ~40% row.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/renderer/src/components/new-workspace/NewWorkspaceComposerAgentSection.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/new-workspace/NewWorkspaceComposerAgentSection.tsx src/renderer/src/components/new-workspace/new-workspace-composer-card-props.ts src/renderer/src/components/new-workspace/NewWorkspaceComposerAgentSection.test.tsx
git commit -m "feat(composer): multi-row agent section with per-row flags and names"
```

### Task 4: Submit mapping + post-create launch loop

**Files:**
- Modify: `src/renderer/src/hooks/composer-state/quick-submit-action.ts`
- Modify: `src/renderer/src/hooks/composer-state/quick-creation-execution.ts`
- Create: `src/renderer/src/lib/composer-agent-launch-loop.ts`
- Test: `src/renderer/src/lib/composer-agent-launch-loop.test.ts`
- Test: extend existing composer submit tests where present

**Interfaces:**
- Consumes: Task 1 `usesAgentLaunchList`, Task 2 `entriesToLaunchList`, existing `launchAgentInNewTab` (`LaunchAgentInNewTabArgs`), `scheduleComposerCreateHandoff`, `executeQuickCreation`.
- Produces: `function runComposerAgentLaunchLoop(args: { worktreeId: string; request: WorktreeCreationRequest; quickPrompt: string; promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'; linkedItemPrompt: string | null }): { launched: number; failed: number }` — synchronous launch of each entry in order; per-entry failure collects into failed count and surfaces existing toasts (launchAgentInNewTab already toasts command-build failures; prompt-delivery failures toast via existing machinery). Suppress the seeded blank initial terminal (close it if the workspace shows one and no entry claimed it) and pass `linkedItemPrompt ?? quickPrompt` as each entry's prompt.

- [ ] **Step 1: Write the failing tests**

Mock `launchAgentInNewTab`. Two entries → two calls, first with `quickCommandLabel` of entry 0, both with `pendingActivationSpawn: true`, first with focus (activate/focus terminal callback), second without. Entry with `agentArgs` and `requestedSurface: 'chat'` → call receives `requestedSurface: 'terminal'` (forced) — wait, `LaunchAgentInNewTabArgs` has `requestedSurface?: 'chat' | 'terminal'` already; test that the loop passes `'terminal'` when agentArgs present. Linked-item prompt preferred over quickPrompt. Blank tab present in mock state → `closeTerminal`/absorb called before launches. Post-create failure (launch returns null) → failed count 1, loop continues to next entry, no throw.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/lib/composer-agent-launch-loop.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Hook into the same sequencing point where `composer-create-handoff` completes activation (where `seedAgentTabStateAfterWorktreeCreate` runs today for the single-agent path); when `usesAgentLaunchList(request)` → run the loop, else legacy path untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/renderer/src/lib/composer-agent-launch-loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/composer-agent-launch-loop.ts src/renderer/src/lib/composer-agent-launch-loop.test.ts src/renderer/src/hooks/composer-state/quick-submit-action.ts src/renderer/src/hooks/composer-state/quick-creation-execution.ts
git commit -m "feat(composer): post-create multi-agent launch loop"
```

### Task 5: omp usage scanner + store

**Review:** per-task — data migration / persisted format (`orca-omp-usage.json` cache shape, resume offsets).

**Files:**
- Create: `src/main/omp-usage/types.ts`, `src/main/omp-usage/scanner.ts`, `src/main/omp-usage/store.ts`
- Test: `src/main/omp-usage/scanner.test.ts`, `src/main/omp-usage/store.test.ts`

**Interfaces:**
- Consumes: `UsageProvider<TSession, TDaily>` + `UsageScanWorktreeRef` (`src/main/usage/usage-provider-contract.ts`), `resolveOmpSessionsDir` family (`src/main/ai-vault/omp-session-root.ts` — reuse for root discovery, scan ALL profile roots).
- Produces: `type OmpUsageSession = { sessionId: string; startedAt: string; endedAt?: string; cwd: string; model: string; provider: string; repoId?: string; worktreeId?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; totalTokens: number; costUsd: number }`; `type OmpUsageDailyAggregate = { day: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; totalTokens: number; costUsd: number }`; `class OmpUsageStore extends UsageProviderStoreLifecycle` with `id: 'omp'`, `label: 'omp'`, `schemaVersion: 1`; scanner `scanOmpUsageFiles(worktrees: UsageScanWorktreeRef[], sourceCache: UsageSourceCacheRef): Promise<UsageScanResult<OmpUsageSession, OmpUsageDailyAggregate>>`.

- [ ] **Step 1: Write the failing tests**

Fixture JSONL: `session` record (cwd+timestamp), `message` records with usage objects (input/output/cacheRead/cacheWrite/reasoningTokens + cost.total + model/provider), a partial/corrupt line, a message with zero usage, a model-change mid-session. Expect: session attributed to matching worktree by cwd prefix; totals = sum over usage messages; reasoningTokens tracked separately (not in outputTokens); costUsd = sum of cost.total; corrupt line skipped without error; resume from cached byte-offset appends only new lines (stat-keyed mtime+size). Daily aggregates group by local day of message timestamp.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/omp-usage/scanner.test.ts src/main/omp-usage/store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Follow `codex-usage/scanner.ts` structure (line-offset resume, per-file sessions, worktree attribution by cwd match). Zero-usage assistant messages contribute nothing. Multi-profile roots: scan each resolved root; dedupe by file path.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/omp-usage/scanner.test.ts src/main/omp-usage/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/omp-usage/
git commit -m "feat(usage): omp session scanner and usage store"
```

### Task 6: Provider registration (IPC, worker, preload, slice)

**Files:**
- Modify: `src/main/usage/usage-provider-contract.ts` (`UsageProviderId` gains `'omp'`)
- Modify: `src/main/usage/usage-scan-worker-protocol.ts` (`UsageScanWorkerProviderId` gains `'omp'`) + `usage-scan-worker-entry.ts` (case 'omp')
- Modify: `src/main/ipc/usage-provider-handlers.ts` (`ompUsage: OmpUsageStore` + registration)
- Modify: `src/main/startup/main-process-observers.ts` (`state.ompUsage = new OmpUsageStore(store)`)
- Modify: `src/preload/usage-provider-api.ts` or its aggregation point (expose `ompUsage` bridge)
- Modify: renderer usage-provider slices + StatsPane provider dropdown (add OmpUsagePane)
- Test: `src/main/ipc/usage-provider-handlers-readiness.test.ts` (extend)

**Interfaces:**
- Consumes: Task 5 `OmpUsageStore`.
- Produces: `window.api.ompUsage.*` with the full method set (getScanState/setEnabled/refresh/getSnapshot/getSummary/getDaily/getBreakdown/getRecentSessions); `'omp'` accepted everywhere `UsageProviderId` is consumed (renderer series builders, StatsPane).

- [ ] **Step 1: Write the failing test**

Extend the readiness test: `ompUsage` store registers handlers for all channels; `UsageProviderId` type-level acceptance via a compile-time assertion in the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/ipc/usage-provider-handlers-readiness.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/ipc/usage-provider-handlers-readiness.test.ts`
Expected: PASS. Also run `pnpm typecheck` (or repo equivalent) for the shared type widening ripples.

- [ ] **Step 5: Commit**

```bash
git add -A src/main/usage/ src/main/ipc/usage-provider-handlers.ts src/main/startup/main-process-observers.ts src/preload/ src/renderer/src/store/slices/usage-provider-slices.ts src/renderer/src/components/stats/
git commit -m "feat(usage): register omp provider across IPC, preload, slices and StatsPane"
```

### Task 7: Usage drawer shell + state + toolbar icon

**Files:**
- Create: `src/renderer/src/components/usage-dashboard/UsageDashboardDrawer.tsx`, `UsageDashboardSidebarHost.tsx`
- Modify: `src/renderer/src/components/sidebar/SidebarToolbar.tsx` (left cluster: chart icon button)
- Modify: `src/renderer/src/store/slices/ui/ui-slice-contract-preferences.ts` + `ui-slice-preference-actions.ts` (`usageDrawerOpen` transient flag)
- Modify: `src/renderer/src/components/sidebar/index.tsx` (mount host; mutual exclusion with workspace board)
- Modify: `src/renderer/src/components/settings/...` global settings types + defaults (`showUsageButton`, default true) with HideSidebarMenu integration
- Test: `src/renderer/src/components/usage-dashboard/UsageDashboardSidebarHost.test.tsx`

**Interfaces:**
- Consumes: `Sheet`/`SheetContent` (`components/ui/sheet`), drawer patterns from `WorkspaceKanbanSheet` (live sidebar width var, status-bar reserve), `AgentDashboardSidebarHost` mutual-exclusion effect pair.
- Produces: `UsageDashboardDrawer` accepting `{ leftSidebarStyle?: React.CSSProperties; statusBarVisible: boolean }`; ui-slice `usageDrawerOpen: boolean` + `setUsageDrawerOpen(open: boolean): void`.

- [ ] **Step 1: Write the failing tests**

Host renders drawer when `usageDrawerOpen && sidebarOpen`; closes drawer when sidebar closes; closes when workspace board opens (and vice versa via existing board effect). Toolbar shows icon (lucide `ChartColumn`, `size-3.5`) with tooltip "Token usage" when `showUsageButton` true; hidden when false. Icon click toggles `setUsageDrawerOpen`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/components/usage-dashboard/UsageDashboardSidebarHost.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/renderer/src/components/usage-dashboard/UsageDashboardSidebarHost.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/usage-dashboard/ src/renderer/src/components/sidebar/ src/renderer/src/store/slices/ui/
git commit -m "feat(usage): sidebar drawer shell with toolbar icon and transient state"
```

### Task 8: Drawer content — quotas, chart, table, footer

**Files:**
- Create: `src/renderer/src/components/usage-dashboard/UsageDashboardQuotaStrip.tsx`, `UsageDashboardDailyChart.tsx`, `UsageDashboardModelTable.tsx`, `usage-dashboard-series.ts`, `UsageDashboardDrawerContent.tsx`
- Test: `src/renderer/src/components/usage-dashboard/usage-dashboard-series.test.ts` + component tests

**Interfaces:**
- Consumes: `rateLimits` slice (`ProviderRateLimits`), `window.api.<provider>Usage.getDaily/getBreakdown/getSummary` per provider incl. `ompUsage` (Task 6), `openSettingsTarget({ pane: 'stats' })`, `ClaudeUsageDailyChart` bar idiom, `usage-overview-daily-series.ts` merge logic extended with omp.
- Produces: `usage-dashboard-series.ts`: `type UsageDashboardDailyPoint = { day: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens?: number; costUsd: number }`; `buildUsageDashboardDailySeries(providers: Array<{ id: UsageProviderId; daily: readonly UsageDashboardDailyPoint[] }>, days: number): UsageDashboardDailyPoint[]`; `buildUsageDashboardModelRows(breakdowns, scope)`.

- [ ] **Step 1: Write the failing tests**

Series merge: two providers with overlapping days sum per field; missing providers skipped; zero-day included (0-filled window); reasoningTokens only from omp, never into outputTokens. Model rows: sorted by totalTokens desc; missing cost → null (renders "—" not NaN). Component: quota strip renders one row per provider with windows/reset countdown (reuse UsageMetric idiom); chart renders one column per day with stacked segments (input/cached/output) with `--chart-1..5` classes, per-segment tooltip content (incl. reasoningTokens line for omp days); period selector 7/14/30 re-filters; scope toggle 'all' (default) / 'orca' switches fetch args; footer totals sum series; "Open full stats" calls deep link. Empty state: no providers with data → placeholder copy.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/components/usage-dashboard/`
Expected: FAIL.

- [ ] **Step 3: Implement**

Fetch on open + refresh button; no polling. Chart segments use `transition-[height] motion-safe:duration-300 ease-out`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/renderer/src/components/usage-dashboard/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/usage-dashboard/
git commit -m "feat(usage): drawer content — quotas, daily chart, model table, footer"
```

### Task 9: End-to-end verification + gates

**Files:**
- Test: throwaway verification script (not committed)

- [ ] **Step 1: Build the app**

Run: `pnpm install && pnpm build` (or repo's canonical build). Expected: clean build, typecheck passes.

- [ ] **Step 2: Manual smoke (spec acceptance)**

Launch dev app (`pnpm dev`). Composer: create workspace with two codex rows (`--profile fast` / `--profile safe` or local equivalents) + custom names → one workspace, two agent tabs with custom names, flags in process command line, names persist across app restart. Force a creation failure (bad base ref) → Retry → list replays. Drawer: quotas/chart/table render with local data; `ompUsage:getDaily` non-zero days (validate via devtools invoke); period + scope switches work; "Open full stats" deep-links.

- [ ] **Step 3: eng-gates**

Run: `python3 ~/.omp/agent/skills/eng-gates/scripts/gate.py -C ~/Documents/code-projects/orca fast` then `full`. Expected: both green (or documented WARN list, no suppressions).

- [ ] **Step 4: Commit any fixes + final commit**

```bash
git add -A && git commit -m "feat: multi-agent composer and usage dashboard (verification fixes)"
```

## Self-review notes

- Spec coverage: composer list (T1-T4), drawer icon/shell (T7), content (T8), omp store + registration (T5-T6), gates (T9). Resolutions 1-9 from the spec are reflected in T2 (r3), T4 (r1/r2-gating/r4/r5/r7), T5 (r6/r8), T8 (r8/r9).
- Types consistent: `AgentLaunchListEntry` (T1) consumed by T2/T4; `OmpUsageStore` (T5) consumed by T6; `usageDrawerOpen` (T7) consumed by T8's content mount.
- Review marks: T5 touches persisted cache format + resume offsets → per-task review. T4 touches launch sequencing (concurrency-adjacent but renderer-synchronous) — covered by whole-branch review.
- Proportion: plan stays at interface/signature level; bodies left to implementers.