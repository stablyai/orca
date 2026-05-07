# Review Context

## Branch Info

- Base: origin/main (merge base: a75e706a6cbe7900e9d46e5a8546afe654a56e8d)
- Current: brennanb2025/agent-status-on
- Branch has no commits yet — all changes are uncommitted (working tree)

## PR Goal (from docs/agent-dashboard-default-on.md)

Remove the `experimentalAgentDashboard` setting and its UI toggle. The "Detailed agent activity" feature (inline agent rows, retained "done" snapshots) becomes default-on for everyone. Renderer/main gates and runtime-flag IPC plumbing for the toggle UX get deleted. The persistence migration that adds `'inline-agents'` to `worktreeCardProperties` now fires for every user (was previously gated on the experiment being on). 26 files changed, 91 insertions / 495 deletions — primarily deletion of dead code paths.

## Changed Files Summary (all M, plus untracked design doc)

- src/main/codex-accounts/runtime-home-service.test.ts
- src/main/codex-accounts/service.test.ts
- src/main/index.ts
- src/main/ipc/app.ts
- src/main/persistence.test.ts
- src/main/persistence.ts
- src/preload/api-types.ts
- src/preload/index.ts
- src/renderer/src/App.tsx
- src/renderer/src/components/dashboard/RetainedAgentsSyncGate.tsx
- src/renderer/src/components/dashboard/useDashboardData.ts
- src/renderer/src/components/dashboard/useRetainedAgents.ts
- src/renderer/src/components/settings/ExperimentalPane.tsx
- src/renderer/src/components/settings/experimental-search.ts
- src/renderer/src/components/sidebar/SidebarHeader.tsx
- src/renderer/src/components/sidebar/WorktreeCard.tsx
- src/renderer/src/components/sidebar/WorktreeList.tsx
- src/renderer/src/components/sidebar/useWorktreeAgentRows.ts
- src/renderer/src/components/sidebar/visible-worktrees.ts
- src/renderer/src/components/terminal-pane/pty-connection.ts
- src/renderer/src/hooks/useAutoAckViewedAgent.ts
- src/renderer/src/hooks/useIpcEvents.ts
- src/shared/agent-hook-types.ts
- src/shared/constants.ts
- src/shared/telemetry-events.ts
- src/shared/types.ts
- docs/agent-dashboard-default-on.md (new, design doc)

## Changed Line Ranges (PR Scope — `+` side)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->
<!-- For pure deletions, the post-image line is where the deletion landed. Reviewers must also evaluate whether the deletion broke remaining call sites. -->

| File | Changed Lines (post-image) |
| ---- | -------------------------- |
| src/main/codex-accounts/runtime-home-service.test.ts | (deletion only @ pre-line 98) |
| src/main/codex-accounts/service.test.ts | (deletion only @ pre-line 92) |
| src/main/index.ts | 280-285, 440-451, 531-533 |
| src/main/ipc/app.ts | (deletions only @ pre-lines 9-27, 29) |
| src/main/persistence.test.ts | 615-622, 627, 647, 664 |
| src/main/persistence.ts | 178-184 |
| src/preload/api-types.ts | (deletions only @ pre-lines 345-348, 346-348) |
| src/preload/index.ts | (deletions only @ pre-lines 7, 241) |
| src/renderer/src/App.tsx | 159-163, 902-905 |
| src/renderer/src/components/dashboard/RetainedAgentsSyncGate.tsx | (deletions only @ pre-line 11-13) |
| src/renderer/src/components/dashboard/useDashboardData.ts | 160-163 |
| src/renderer/src/components/dashboard/useRetainedAgents.ts | 60 |
| src/renderer/src/components/settings/ExperimentalPane.tsx | 1-2 |
| src/renderer/src/components/settings/experimental-search.ts | 4-12 |
| src/renderer/src/components/sidebar/SidebarHeader.tsx | 134 |
| src/renderer/src/components/sidebar/WorktreeCard.tsx | 571-576 |
| src/renderer/src/components/sidebar/WorktreeList.tsx | 635, 647, 661 |
| src/renderer/src/components/sidebar/useWorktreeAgentRows.ts | 137 |
| src/renderer/src/components/sidebar/visible-worktrees.ts | 184, 195 |
| src/renderer/src/components/terminal-pane/pty-connection.ts | 359 |
| src/renderer/src/hooks/useAutoAckViewedAgent.ts | 105-109 |
| src/renderer/src/hooks/useIpcEvents.ts | 803 |
| src/shared/agent-hook-types.ts | 25-28 |
| src/shared/constants.ts | (deletion only @ pre-line 200-203) |
| src/shared/telemetry-events.ts | (deletion only @ pre-line 133) |
| src/shared/types.ts | 1380-1385 |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority: Critical > High > Medium > Low
- This PR is mostly *deletions* — deletion-impact agent is especially important here. Watch for dangling references to removed symbols (`experimentalAgentDashboard`, `AppRuntimeFlags`, `setAppRuntimeFlags`, `runtimeFlags`, `getRuntimeFlags`, `agentDashboardEnabledAtStartup`).

## File Categories

### Electron/Main (priority 1)
- src/main/index.ts
- src/main/ipc/app.ts
- src/main/persistence.ts
- src/main/persistence.test.ts
- src/main/codex-accounts/service.test.ts
- src/main/codex-accounts/runtime-home-service.test.ts
- src/preload/api-types.ts
- src/preload/index.ts

### Frontend/UI (priority 3)
- src/renderer/src/App.tsx
- src/renderer/src/components/dashboard/RetainedAgentsSyncGate.tsx
- src/renderer/src/components/dashboard/useDashboardData.ts
- src/renderer/src/components/dashboard/useRetainedAgents.ts
- src/renderer/src/components/settings/ExperimentalPane.tsx
- src/renderer/src/components/settings/experimental-search.ts
- src/renderer/src/components/sidebar/SidebarHeader.tsx
- src/renderer/src/components/sidebar/WorktreeCard.tsx
- src/renderer/src/components/sidebar/WorktreeList.tsx
- src/renderer/src/components/sidebar/useWorktreeAgentRows.ts
- src/renderer/src/components/sidebar/visible-worktrees.ts
- src/renderer/src/components/terminal-pane/pty-connection.ts
- src/renderer/src/hooks/useAutoAckViewedAgent.ts
- src/renderer/src/hooks/useIpcEvents.ts

### Utility/Common (priority 5)
- src/shared/agent-hook-types.ts
- src/shared/constants.ts
- src/shared/telemetry-events.ts
- src/shared/types.ts

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Format: [file:line] | [severity] | [reason] | [summary] -->

- src/renderer/src/components/settings/experimental-search.ts:3-13 | Medium | Stylistic refactor (numeric-index→named keys) is out of scope for a default-on PR; placeholder is documented | EXPERIMENTAL_PANE_SEARCH_ENTRIES[0] placeholder
- src/renderer/src/components/sidebar/visible-worktrees.ts:184,195 | Low | Bounded micro-perf in pre-first-render fallback only; agent map is small for typical users | Comparator rebuilds explicit-entries index
- src/renderer/src/components/dashboard/RetainedAgentsSyncGate.tsx:filename | Low | Component rename is out of scope; comment already explains the architectural role | Component still named "…SyncGate" after gate removed
- src/shared/types.ts:1386 | Low | Persisted field rename requires migration; design doc explicitly retained the legacy name | Field name still says `_inlineAgentsDefaultedForExperiment`

## Iteration State

Current iteration: 1
Last completed phase: Validation
Files fixed this iteration: []
