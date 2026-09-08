# Browser Storage Catalog (direct `localStorage`/`sessionStorage` call sites)

Every direct `localStorage`/`sessionStorage` call site under `frontend/src`,
excluding `*.test.ts(x)` files and the `window.api.ui`/`settings`/`session`
implementation in `web-preload-api.ts` (that's the bulk-data hybrid
mechanism, covered in
[`ui-settings-session-hybrid.md`](./ui-settings-session-hybrid.md) — this
doc is the ~30 small, feature-specific keys scattered elsewhere). 30
non-excluded files were inspected; 6 contain only comments/doc-strings
mentioning storage, no executable call (listed at the bottom).

## 1. Onboarding / feature education

| Key | Type | Feature | Data | file:line | Ephemeral/Important | Duplicates store? |
|---|---|---|---|---|---|---|
| `orca.featureWall.visitedWorkflows.v1` | localStorage | Feature Wall workflow tour progress | `FeatureWallWorkflowId[]` | `components/feature-wall/feature-wall-completion-persistence.ts:81,201` | Ephemeral/cosmetic | Sole copy |
| `orca.featureWall.completedWorkflows.v1` | localStorage | Feature Wall workflow tour completion | `FeatureWallWorkflowId[]` | `components/feature-wall/feature-wall-completion-persistence.ts:96,215` | Ephemeral | Sole copy |
| `orca.featureWall.visitedAgentSteps.v1` | localStorage | Feature Wall "Agents" tour steps visited | `AgentsStepId[]` | `components/feature-wall/feature-wall-completion-persistence.ts:111,229` | Ephemeral | Sole copy |
| `orca.featureWall.completedAgentSteps.v1` | localStorage | Feature Wall "Agents" tour steps completed | `AgentsStepId[]` | `components/feature-wall/feature-wall-completion-persistence.ts:126,243` | Ephemeral | Sole copy |
| `orca.featureWall.visitedWorkbenchSteps.v1` | localStorage | Feature Wall "Workbench" tour steps visited | `WorkbenchStepId[]` | `components/feature-wall/feature-wall-completion-persistence.ts:141,257` | Ephemeral | Sole copy |
| `orca.featureWall.completedWorkbenchSteps.v1` | localStorage | Feature Wall "Workbench" tour steps completed | `WorkbenchStepId[]` | `components/feature-wall/feature-wall-completion-persistence.ts:156,271` | Ephemeral | Sole copy |
| `orca.featureWall.visitedReviewSteps.v1` | localStorage | Feature Wall "Review" tour steps visited | `ReviewStepId[]` | `components/feature-wall/feature-wall-completion-persistence.ts:171,285` | Ephemeral | Sole copy |
| `orca.featureWall.completedReviewSteps.v1` | localStorage | Feature Wall "Review" tour steps completed | `ReviewStepId[]` | `components/feature-wall/feature-wall-completion-persistence.ts:186,299` | Ephemeral | Sole copy |
| `orca.browserUse.enabled` | localStorage | Browser-Use agent skill "enabled" toggle | `'1'`/`'0'` flag | `components/feature-wall/BrowserUseSkillSetupCard.tsx:55`; `components/settings/BrowserUsePane.tsx:90,95`; `components/onboarding/onboarding-feature-setup.ts:205` | Somewhat important (loses an explicit toggle) | Sole copy — no store slice |
| `orca.orchestration.enabled` | localStorage | Multi-agent "orchestration" feature enable flag | `'1'` flag | `lib/orchestration-setup-state.ts:2,6,14`; `feature-tips/FeatureTipsModal.tsx:148`; `onboarding-feature-setup.ts:206` | Somewhat important | Sole copy |
| `orca.orchestration.setupDismissed` | localStorage | Dismissal of the "set up orchestration" nudge | `'1'` flag | `lib/orchestration-setup-state.ts:3,19`; `components/floating-terminal/FloatingTerminalPanel.tsx:1399`; `FeatureTipsModal.tsx:149`; `onboarding-feature-setup.ts:208` | Ephemeral | Sole copy |
| `orca.setupGuideTelemetryCompletedSteps.v1` | localStorage | Setup-guide telemetry de-dup | `FeatureWallSetupStepId[]` | `lib/feature-education-telemetry.ts:18-19,141,159` | Ephemeral (telemetry bookkeeping) | Sole copy |
| `orca.terminalPaneSplitTelemetry.v1` | localStorage | Terminal-pane-split telemetry de-dup (capped to last 32) | `string[]` | `lib/feature-education-telemetry.ts:20,183-186,221` | Ephemeral | Sole copy |
| `orca.mobile.sidebar-onboarding-dismissed` | localStorage | One-time "Try it" badge on Orca Mobile sidebar entry | `'1'` flag | `components/sidebar/mobile-sidebar-onboarding-badge.ts:4,8,58` | Ephemeral | Sole copy |
| `orca.workspaceBoardMovedHintSeen.v1` | localStorage | One-time hint that Workspace Board moved location | `'true'` flag | `components/sidebar/SidebarToolbar.tsx:16,63,66` | Ephemeral | Reads `featureInteractions` (backend-synced) only to decide *eligibility*; the seen-flag itself is local-only |
| `orca.preflightBanner.dismissed.<issueId>` (template) | localStorage | GitHub-CLI setup preflight-banner dismissal, invalidated when a new GitHub project appears | `{ githubKeys: string[] }` JSON | `components/landing-preflight-dismissal.ts:13,20-21,35,61` | Ephemeral | Sole copy |
| `orca.linearTicketsSkill.setupDismissed[.wsl.<distro>\|.host]` (template) | localStorage | Dismissal of Linear-agent-skill setup reminder, scoped per local runtime | `'1'` flag | `components/sidebar/linear-agent-skill-runtime.ts:7,129-133,140`; write `LinearAgentSkillSetupPrompt.tsx:236` | Ephemeral | Sole copy |
| `orca.terminalShortcutCapturedNotice.<actionId>` (template) | localStorage | Once-only toast that a keybinding was captured/shadowed by the terminal | `'true'` flag | `lib/terminal-shortcut-capture-notification.tsx:14,19,27` | Ephemeral | Sole copy |

## 2. Layout / panel geometry

| Key | Type | Feature | Data | file:line | Ephemeral/Important | Duplicates store? |
|---|---|---|---|---|---|---|
| `orca-floating-terminal-panel-bounds-v1` | localStorage | Floating terminal panel size/position | `FloatingTerminalPanelBounds` \| `FloatingTerminalAnchoredPanelBounds` JSON | `components/floating-terminal/floating-terminal-panel-bounds.ts:12,63-65` | Annoying to lose, but cosmetic | Sole copy — no store slice for this geometry |
| `orca-floating-terminal-trigger-position-v2` | localStorage | Floating-terminal launcher button's dragged position | `{left,top}` \| anchored variant JSON | `components/floating-terminal/floating-terminal-trigger-position.ts:7-8,51-53` | Cosmetic | Sole copy |
| `pet-overlay-position` (current) / `sidekick-overlay-position` (legacy, migration source) | localStorage | Desktop-pet overlay's dragged screen position | `{x,y}` JSON, clamped to viewport | `components/pet/PetOverlay.tsx:209-210,242,245,257,341` | Purely cosmetic | **Split-persistence feature**: `petSize` (a different attribute of the same pet) IS a Zustand field (`store/slices/ui.ts:957,2280-2284`) synced to backend via `uiSet`; only `position` is local-only |

## 3. GitHub project board UI state

| Key | Type | Feature | Data | file:line | Ephemeral/Important | Duplicates store? |
|---|---|---|---|---|---|---|
| `orca.githubProject.hiddenColumns` | localStorage | GitHub Project board — per-view hidden-column set | `Record<scopeKey, string[]>` JSON | `components/github-project/columns.ts:30,36,49` | Cosmetic, per-device by design | Sole copy — deliberately kept out of synced `settings` (comment: avoids bloating debounced settings writes) |
| `orca.githubProject.columnWidths` | localStorage | GitHub Project board — per-view column widths (`fr` grid weights) | `Record<scopeKey, Record<fieldId, number>>` JSON | `components/github-project/column-widths.ts:12,25,38` | Cosmetic, continuous drag feedback | Sole copy — same rationale |
| `orca:pr-comment-presentation` | localStorage | Dev-only override for PR comment list layout variant (`cards`\|`flat`\|`focus`) | string enum | `components/right-sidebar/pr-comment-presentation.ts:9,111,116` | Dev/debug tool only | N/A |

## 4. Auth / session / dev-server connections

| Key | Type | Feature | Data | file:line | Ephemeral/Important | Duplicates store? |
|---|---|---|---|---|---|---|
| (all keys, via `.clear()`) | localStorage + sessionStorage | Web-mode auth-failure handler — wipes all client state, redirects to `/login` | N/A (blanket clear) | `renderer/src/web/main-web-bootstrap.tsx:92,97` | Deliberate wipe | N/A — this also clears the `ui`/`settings`/`session` caches from the hybrid doc |
| (all keys, via `.clear()`) | localStorage + sessionStorage | Explicit user logout | N/A (blanket clear) | `renderer/src/hooks/useLogout.ts:50,55` | Deliberate wipe | N/A |
| `orca.saved-instances` | localStorage | Web-mode "saved Orca server instances" picker (CR-006) — reconnect to previously-used self-hosted servers | `OrcaInstance[]` (`{id,label,url,team?,lastConnectedAt?}`) JSON | `hooks/useSavedOrcaInstances.ts:14,18,27` | **Important** — losing this means re-typing server URLs/labels for every self-hosted instance. No backend/store equivalent exists; candidate for syncing or backing up. | Sole copy |
| `orca.accountsDevServer.<environmentId>` (template) | localStorage | "Accounts" (Claude/Codex provider account) picker — remembers which dev server a runtime environment defaults to | plain string `devServerId` | `runtime/accounts-dev-server-connection.ts:16,25-26,31,43,45` | Somewhat important — required before `accounts.*` RPCs work (throws if absent) | Sole copy — comment explicitly says "not GlobalSettings ... not server-authoritative state" (deliberate design choice) |

## 5. Misc / dev-tooling / diagnostics

| Key | Type | Feature | Data | file:line | Ephemeral/Important | Duplicates store? |
|---|---|---|---|---|---|---|
| `orca:lazy-chunk-reload-attempted` | sessionStorage | Lazy-import chunk-load-error recovery — caps auto-reload to once per browser session | `'1'` flag | `lib/lazy-with-retry.ts:48,57,67` | Mechanical/ephemeral | N/A |
| `orca.previewLinkRoutingPreferenceDialog` / `.default` | sessionStorage | Dev-only (`import.meta.env.DEV`) trigger to preview the "open link in Orca vs. browser" dialog | `'1'` flag / `'orca'` string | `components/link-routing-preference-dialog.tsx:34-35,95,98-100` | Dev tool only | N/A |
| `orca.mobile.notificationPrefs` | localStorage | Mobile companion push-notification category toggles | `MobileNotificationPrefs` (5 booleans) JSON | `components/mobile/mobile-notification-settings.tsx:35,39,46` | Somewhat annoying to lose, low stakes | Sole copy — no store slice |
| `orca.diag.bugFePty001` | localStorage | **TEMP** diagnostic ring-buffer for the (now-resolved) BUG-FE-PTY-001 investigation | ring buffer `{t,msg}[]`, capped at 300 | `lib/bug-fe-pty-001-diagnostic-log.ts:11,28,40,81` | Diagnostic only — cleanup candidate, see README | N/A |
| `orca.diag.removeProject` | localStorage | **TEMP** diagnostic ring-buffer for a "Remove Project no-op" investigation | ring buffer `{t,msg}[]`, capped at 100 | `lib/remove-project-diagnostic-log.ts:11,24,36,75` | Diagnostic only — cleanup candidate | N/A |
| `ORCA_TRACE` | localStorage | Frontend execution-tracing toggle (console-output opt-in) | `'1'` flag | `shared/trace/browser.ts:81,106,110,114` | Dev/debug tool | N/A |

## Comment-only references (no executable call site)

- `renderer/src/web/OrcaInstanceSwitcher.tsx:1` — doc-comment only; real calls in `hooks/useSavedOrcaInstances.ts` (above).
- `renderer/src/hooks/useGit.ts:176` — comment about a hypothetical `sessionStorage` bearer token "nothing ever set" (dead reference).
- `renderer/src/auth/auth-api-client.ts:3` — comment asserting "No tokens are stored in localStorage" (documents an absence).
- `renderer/src/runtime/runtime-cache-client.ts:10` — comment referencing `window.api.cache`'s localStorage-backed stub (implemented elsewhere).
- `renderer/src/components/trace/TracePanel.tsx:6,290` — dev-console instructions in a comment/JSX help text, not executed code.
- `shared/trace/index.ts:7,72` — doc-comments pointing at `shared/trace/browser.ts` (cataloged above).

## Cross-cutting observations

1. **No Zustand-slice duplication found for any key above.** Every
   localStorage feature in this catalog is either a sole source of truth or
   deliberately excluded from the backend-synced store, per explicit
   "why localStorage, not settings" comments in `github-project/columns.ts:1-5`,
   `github-project/column-widths.ts:1-9`, and
   `runtime/accounts-dev-server-connection.ts:10-15`.
2. **One split-persistence exception**: `PetOverlay` — `size` syncs to the
   backend via the store's `ui.ts`/`uiSet`, `position` is local-only. Same
   feature, two tiers.
3. **Most annoying-to-lose entries**: `orca.saved-instances` and
   `orca.accountsDevServer.<envId>` — everything else is designed to
   degrade silently (reset to default) if storage is cleared.
4. **Two cleanup candidates**: `lib/bug-fe-pty-001-diagnostic-log.ts` and
   `lib/remove-project-diagnostic-log.ts` are both marked TEMP by their own
   header comments; the PTY-001 investigation is already resolved.
