# Review Context

## Branch Info

- Base: origin/main
- Current: brennanb2025/agent-cockpit-UI-placement
- Merge base: b5b5e1b7278f74b41224b20a14a5cac8d44e6653

## Changed Files Summary

| File | Type |
| --- | --- |
| src/main/codex-accounts/runtime-home-service.test.ts | M |
| src/main/codex-accounts/service.test.ts | M |
| src/main/rate-limits/gemini-usage-fetcher.test.ts | M |
| src/renderer/src/App.tsx | M |
| src/renderer/src/components/dashboard/AgentDashboard.tsx | M |
| src/renderer/src/components/dashboard/DashboardAgentRow.tsx | M |
| src/renderer/src/components/dashboard/DashboardFilterBar.tsx | D |
| src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx | M |
| src/renderer/src/components/dashboard/useDashboardFilter.ts | M |
| src/renderer/src/components/dashboard/useDashboardKeyboard.ts | M |
| src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx | D |
| src/renderer/src/components/right-sidebar/index.tsx | M |
| src/renderer/src/components/settings/AgentsPane.tsx | M |
| src/renderer/src/components/settings/ExperimentalPane.tsx | M |
| src/renderer/src/components/settings/experimental-search.ts | M |
| src/renderer/src/components/sidebar/AgentStatusHover.tsx | D |
| src/renderer/src/components/sidebar/SearchBar.tsx | M |
| src/renderer/src/components/sidebar/SidebarHeader.tsx | M |
| src/renderer/src/components/sidebar/WorktreeCard.tsx | M |
| src/renderer/src/components/sidebar/WorktreeCardAgents.tsx | A |
| src/renderer/src/components/sidebar/index.tsx | M |
| src/renderer/src/components/sidebar/useWorktreeAgentRows.ts | A |
| src/renderer/src/store/slices/ui.ts | M |
| src/shared/constants.ts | M |
| src/shared/types.ts | M |

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File | Changed Lines |
| --- | --- |
| src/main/codex-accounts/runtime-home-service.test.ts | (deletion only near line 66) |
| src/main/codex-accounts/service.test.ts | (deletion only near line 60) |
| src/main/rate-limits/gemini-usage-fetcher.test.ts | 205 |
| src/renderer/src/App.tsx | 151-153 |
| src/renderer/src/components/dashboard/AgentDashboard.tsx | 2, 48-54, 150, 173-177 |
| src/renderer/src/components/dashboard/DashboardAgentRow.tsx | 75-76, 90-97, 105-106, 159, 192, 218 |
| src/renderer/src/components/dashboard/DashboardFilterBar.tsx | DELETED |
| src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx | 47-50, 125, 152-158, 162 |
| src/renderer/src/components/dashboard/useDashboardFilter.ts | 1-2, 89-103, 107, 110-112, 191 |
| src/renderer/src/components/dashboard/useDashboardKeyboard.ts | 48-56 |
| src/renderer/src/components/right-sidebar/DashboardBottomPanel.tsx | DELETED |
| src/renderer/src/components/right-sidebar/index.tsx | 237-240 |
| src/renderer/src/components/settings/AgentsPane.tsx | (deletions only) |
| src/renderer/src/components/settings/ExperimentalPane.tsx | 215-216, 221-225, 236, 238-239, 276-277 |
| src/renderer/src/components/settings/experimental-search.ts | 21, 23, 28-32 |
| src/renderer/src/components/sidebar/AgentStatusHover.tsx | DELETED |
| src/renderer/src/components/sidebar/SearchBar.tsx | 76 |
| src/renderer/src/components/sidebar/SidebarHeader.tsx | 32-37, 61-68, 71-72, 142 |
| src/renderer/src/components/sidebar/WorktreeCard.tsx | 12, 532-541, 548 |
| src/renderer/src/components/sidebar/WorktreeCardAgents.tsx | 1-151 (NEW FILE) |
| src/renderer/src/components/sidebar/index.tsx | (deletion near line 53) |
| src/renderer/src/components/sidebar/useWorktreeAgentRows.ts | 1-142 (NEW FILE) |
| src/renderer/src/store/slices/ui.ts | 62-65, 75-80, 216-217, 244-255 |
| src/shared/constants.ts | 70-76 |
| src/shared/types.ts | 1017, 1019, 1053-1065 (deletions around 921, 1163) |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Frontend/UI
- src/renderer/src/App.tsx
- src/renderer/src/components/dashboard/AgentDashboard.tsx
- src/renderer/src/components/dashboard/DashboardAgentRow.tsx
- src/renderer/src/components/dashboard/DashboardWorktreeCard.tsx
- src/renderer/src/components/dashboard/useDashboardFilter.ts
- src/renderer/src/components/dashboard/useDashboardKeyboard.ts
- src/renderer/src/components/right-sidebar/index.tsx
- src/renderer/src/components/settings/AgentsPane.tsx
- src/renderer/src/components/settings/ExperimentalPane.tsx
- src/renderer/src/components/settings/experimental-search.ts
- src/renderer/src/components/sidebar/SearchBar.tsx
- src/renderer/src/components/sidebar/SidebarHeader.tsx
- src/renderer/src/components/sidebar/WorktreeCard.tsx
- src/renderer/src/components/sidebar/WorktreeCardAgents.tsx
- src/renderer/src/components/sidebar/index.tsx
- src/renderer/src/components/sidebar/useWorktreeAgentRows.ts
- src/renderer/src/store/slices/ui.ts

### Electron/Main (test-only changes)
- src/main/codex-accounts/runtime-home-service.test.ts
- src/main/codex-accounts/service.test.ts
- src/main/rate-limits/gemini-usage-fetcher.test.ts

### Utility/Common
- src/shared/constants.ts
- src/shared/types.ts

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

(none yet)

## Iteration State

Current iteration: 1
Last completed phase: Setup
Files fixed this iteration: []
