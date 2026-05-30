# Claude Workflow Detail Panel

## Problem

The existing agent-status integration tells the user that a Claude turn or orchestration branch exists, but not why it reached its current state. Claude hook payloads and private run/transcript files can contain richer state: phase-like events, subagent transcript previews, generated JS script references, elapsed time, and token/cost data where present. Orca already has dense row surfaces for agent status (`src/renderer/src/components/dashboard/DashboardAgentRow.tsx`, rendered inline by `src/renderer/src/components/sidebar/WorktreeCardAgents.tsx`) but no read-only drill-in surface for Claude workflow internals.

## Goal

Add a read-only detail panel that opens from a selected Claude agent-status row/workflow target and shows a readable timeline: row summary, state history, orchestration children, transcript previews, generated script path/preview, and basic usage metrics when those fields are present. The panel should help the user audit a Claude workflow without leaving Orca.

## Non-goals

- Do not edit or execute the workflow JS.
- Do not stream full transcript bodies into the sidebar row.
- Do not replace Claude Code's native transcript/session view.
- Do not implement a new workflow grouping model in this branch; reuse the existing orchestration lineage where child rows are already represented.
- Do not add stale/resume actions. The only new row behavior is opening detail for the selected Claude row/workflow target.

## Design

1. Add detail data APIs.
   - Summary data stays in the existing agent-status row data (`agentStatusByPaneKey`/retained entries via `useWorktreeAgentRows`); detail data is fetched lazily when the panel opens. Do not add transcript/script payloads to high-frequency agent-status updates.
   - Add a typed preload/main API such as `claudeWorkflows.getDetail({ target })`. The target is the selected row's current snapshot plus `worktreeId`, derived `connectionId`, and any optional file selectors, not a group lookup.
   - Main must validate that any renderer-provided path belongs to the selected target's worktree before reading it. Treat target paths as selectors, not authority.
   - Return state history, orchestration children, phases when derivable, agents, transcript previews, script preview, file paths, token/cost/elapsed metrics, and non-fatal warnings when present. Missing private Claude fields should produce summary-only detail, not an error.
   - Cap previews in main before IPC. Do not call generic `fs.readFile` for transcript/script previews because it can serialize up to the editor-sized file cap.
   - Put project-owned shared result/request types in a `.ts` file under `src/shared/`, not a `.d.ts`.

2. Add a renderer detail state.
   - Store only selected detail target, loading/error/detail cache, and an epoch.
   - Key cache by stable target identity: `paneKey` plus `worktreeId`/derived `connectionId`, and workflow run id or file path if the reader discovers one.
   - Derive `connectionId` from the owning worktree/repo (`getConnectionId(worktreeId)` pattern); `AgentStatusEntry` does not retain the IPC `connectionId`.
   - Invalidate cached detail when the selected row `updatedAt` or `stateStartedAt` advances, the worktree/repo changes, the derived connection id changes, or the file mtime returned by detail read changes.
   - Drop stale in-flight responses when the selected target or epoch changes.
   - Do not persist panel-open state across app relaunch.

3. Open the panel from Claude agent rows.
   - Add a compact icon-only details action to `DashboardAgentRow` through an optional prop, and pass it from `WorktreeCardAgents` only for Claude rows that have a detail target.
   - Use `Tooltip` for the icon label and `Button` `ghost`/`icon-xs` or `icon-sm` sizing to match `DashboardAgentRow` density.
   - Keep existing row clicks focusing the agent pane. Panel open is an explicit action so navigation behavior does not change.
   - Stop click, mousedown, and Enter/Space propagation on the details button, matching the existing nested-button pattern in `DashboardAgentRow`.

4. Build `ClaudeWorkflowDetailPanel`.
   - Use a right-side `Sheet` because this is a drawer/panel from an existing workspace surface.
   - Reuse `SheetContent`, `SheetTitle`, and `SheetDescription`; do not add custom overlay/shadow/color tiers.
   - Header: workflow/turn label, state, elapsed, last updated, and owning or parent terminal.
   - Tabs or segmented control: Timeline, Agents, Script. Keep the control compact; long labels must not resize the header.
   - Timeline: state-history list with phase names/durations when derivable, and child agents under each phase when the data supports it.
   - Agents: table/list of subagents with prompt, state, last message, token count, transcript preview.
   - Script: read-only code preview with script path. Allow copy path/content when available. Reveal/open-local actions only appear for local paths; remote paths show copy only.
   - Error/empty/loading states use existing muted text and buttons.

5. Keep data bounded.
   - Cap transcript preview events per agent and cap total returned preview bytes across the whole detail response.
   - Cap script preview bytes and mark truncation explicitly.
   - Avoid rendering markdown for raw transcript JSON; show concise plain text previews.
   - For large workflows, render only the first page/window of agents initially and provide "show more" pagination; do not add virtualization unless the list is proven large enough to need it.

6. Support SSH explicitly.
   - Detail reads for SSH workflows must use the SSH filesystem provider path keyed by `connectionId`, never local `fs`.
   - If an active remote runtime owns the worktree, only read files inside that runtime worktree. Use the same containment rules as `runtime-file-client.ts`/`shared/cross-platform-path.ts`; do not fall back to local paths for remote-owned worktrees.
   - If remote detail read is unsupported for v1 or the connection drops, return summary-only detail with a warning. The panel should not throw or close.
   - Use `path`/cross-platform path helpers for path joins and containment. Do not split on `/` or assume POSIX paths when checking Windows/local paths.

## Data flow

```text
User clicks Claude row details
  -> renderer stores selected row/workflow target snapshot + epoch
  -> preload claudeWorkflows.getDetail({ target })
  -> main validates target paths and resolves local/SSH/runtime source
  -> main reads bounded previews and tolerant metadata
  -> renderer drops stale response if epoch/updatedAt changed
  -> detail cache keyed by target identity
  -> Sheet with Timeline/Agents/Script
```

## Edge cases

- Workflow files are still being written while the panel is open.
- Detail fetch races with selected row invalidation.
- Script preview is too large or binary-looking.
- Transcript JSONL contains malformed lines.
- Missing optional metrics or unknown/private Claude file fields.
- Remote workflow detail is unsupported or connection dropped.
- Workflow was dismissed while the panel is open.
- The workflow has many subagents and long labels.
- Renderer-supplied path is outside the owning worktree.
- Selected row has no discoverable Claude workflow file; panel shows row summary/state history with a warning.
- Windows drive-letter paths and SSH POSIX paths appear in the same app session.

## Test plan

- Unit: detail reader caps script/transcript previews and skips malformed JSONL lines.
- Unit: detail reader validates path containment for local, Windows-shaped, SSH, and outside-worktree paths.
- Unit: detail cache invalidates on row `updatedAt`/`stateStartedAt`.
- Unit: stale in-flight detail response is ignored after selected target/epoch changes.
- Unit: remote unsupported returns summary-only detail with warnings, not a thrown exception.
- Component: panel loading, error, summary-only, full detail, and large-agent states.
- Component: tabs/segmented control preserve state and do not overflow narrow widths; long paths/prompts truncate or wrap predictably.
- Electron: open detail from a Claude agent row, switch Timeline/Agents/Script, verify long labels and loading/error states.
- Electron/SSH: remote summary-only or full-detail path does not attempt local reveal/open actions.

## UI quality bar

- This should feel like an operational inspection panel, not a marketing page.
- Follow `docs/STYLEGUIDE.md`: existing tokens, shadcn primitives, lucide icons, quiet monochrome chrome, state color only where meaningful.
- Dense, scannable lists; no nested cards, no decorative backgrounds, no oversized headings, no custom shadows.
- The first viewport should show workflow identity, state, and the top timeline section without scrolling.
- Long paths and labels must truncate/wrap predictably.
- The panel must not obscure or break the existing worktree card list interaction.
- Icon-only actions need tooltips. Loading states longer than a spinner should include a short stage label.

## Review screenshots

1. Detail panel Timeline tab for a running workflow.
2. Agents tab with mixed states and transcript previews.
3. Script tab with generated JS preview and local path actions.
4. Error/summary-only remote state.
5. Narrow width with long labels and paths.
6. SSH/remote workflow state showing no local reveal/open action.

## Rollout

1. Add detail reader and tests with real observed Claude workflow fixtures.
2. Add preload/API and renderer detail store.
3. Add row action/open behavior.
4. Build `ClaudeWorkflowDetailPanel` using existing Sheet and UI primitives.
5. Add component tests and Electron screenshots.

## Lightweight Eng Review

- Scope: Kept to lazy read-only inspection. Resume actions, terminal spawning, and script edits are out of scope.
- Architecture/data flow: Agent rows stay cheap; detail data is fetched on demand through main/preload using the selected target snapshot. This avoids pushing transcript/script payloads through high-frequency status updates.
- IPC/security: Main validates paths and caps payloads before IPC. Renderer targets identify the desired workflow but do not authorize filesystem reads.
- SSH/Windows: Remote reads must route through the SSH/runtime provider and path containment must use cross-platform helpers.
- Failure modes covered:
  - Partial writes and malformed JSONL yield partial detail with warnings.
  - Row/target invalidation refetches detail without stale panel data.
  - Remote unsupported state is explicit and non-crashing.
  - Large scripts/transcripts are capped before IPC.
  - Dismissed workflow closes or resets the panel cleanly.
- Test coverage required:
  - Reader cap/malformed-line/path-validation tests.
  - Store cache invalidation and stale-response tests.
  - Component tests for tabs, loading, error, summary-only, long text.
  - Electron screenshots for all required panel states, including remote behavior.
- Performance/blast radius: Lazy bounded reads only. No row-level transcript payloads. Consider virtualization/pagination if agent count is high.
- UI quality bar: Right-side Sheet, quiet tokens, dense list/table patterns, no nested cards, no overlap or text clipping.
- Required review screenshots:
  1. Timeline tab.
  2. Agents tab.
  3. Script tab.
  4. Remote/error summary-only.
  5. Narrow long-label state.
  6. SSH/remote state with local-only actions hidden.
- Residual risks: Detail fidelity depends on Claude's private workflow file shape. Use tolerant parsing and observed fixtures; never treat missing optional metrics as an error.
