# Failed Automation Rerun Action

## Problem

- Failed Orca automation run details show only the disabled/open-target action when no workspace launched, so a user who sees a `dispatch_failed` error has no local recovery action in the failed-run view: `src/renderer/src/components/automations/AutomationsPage.tsx:1858`.
- The reusable detail header already accepts actions, but the run detail action set is limited to `getAutomationRunViewState`/`openRunWorkspace`: `src/renderer/src/components/automations/AutomationRunPageFrame.tsx:9`, `src/renderer/src/components/automations/automation-run-view-state.ts:13`.
- Manual rerun behavior already exists as `runNow`, which creates a fresh manual run for the automation; the renderer wrapper currently refreshes the page after calling it: `src/renderer/src/components/automations/AutomationsPage.tsx:1033`, `src/main/automations/service.ts:66`.

## Goal

Add an easy rerun button to Orca automation run detail pages for failed launch/recovery statuses. The button creates a fresh manual run for the same automation through the existing `runNow` path.

## Non-goals

- Do not mutate or replay the failed run record.
- Do not add backend APIs or provider-specific rerun behavior.
- Do not add rerun support for external Hermes/OpenClaw run details in this change.
- Do not bypass existing SSH availability, worktree creation, or dispatch failure handling.

## Design

1. Add a small pure predicate near the run view state code, for example `canRerunAutomationRun({ automation, run })`.
   - Return `true` only when an Orca automation still exists, `run.automationId === automation.id`, and the run status is one of `dispatch_failed`, `skipped_unavailable`, or `skipped_needs_interactive_auth`.
   - Do not show rerun for `pending`, `dispatching`, `dispatched`, `completed`, or `skipped_missed`. `skipped_missed` is scheduler catch-up history, not a launch failure the detail page should recover.
2. In `AutomationsPage`, render a `Rerun` action in `AutomationRunPageFrame.actions` when that predicate is true for `selected` and `selectedAutomationRunPage`.
3. The action calls `window.api.automations.runNow({ id: selected.id })` through a small handler, then `refresh()`, then shows the existing queued toast. Wrap the call in `try/catch/finally`: if the automation was deleted or the IPC rejects, toast the error and refresh so the stale run detail can disappear.
4. Preserve dispatch behavior by reusing `runNow`; do not duplicate local/SSH dispatch logic in the renderer. `runNow` creates a new manual run and `AutomationService.requestDispatch` sends the existing `automations:dispatchRequested` payload to the renderer, where `useAutomationDispatchEvents` handles SSH reconnect, interactive-auth skips, worktree creation/reuse, and terminal launch.
5. Add a local in-flight state keyed by the failed run id. Disable only that rerun button while pending so repeated clicks in one window cannot queue duplicates before the first request settles.
6. Keep the existing `View run` / `Open workspace` action beside the new rerun action. Do not gate rerun on `selectedAutomationRunPageViewState.canOpen`; failed runs with no launch should still show the disabled view action plus enabled rerun.
7. Use existing shadcn `Button`, lucide icon sizing, and styleguide tokens. The button should be compact (`size="sm"`), outline-level emphasis, and fit the existing header action row.
8. Add focused tests for the pure predicate in `automation-run-view-state.test.ts`. Avoid component-level tests unless a harness already exists locally.

## Edge cases

- Failed run has no workspace because base ref refresh, SSH connection, missing project/workspace, or renderer availability failed: rerun remains available and lets the existing dispatch path try again.
- Failed run has a workspace but terminal is closed: rerun stays available, and open workspace behavior remains unchanged.
- Automation was deleted while the request is in flight or by another window: `runNow` can throw `Automation not found.`; catch it, clear pending state, and refresh.
- Selection changed while the request is in flight: capture `automation.id` and `run.id` before awaiting, clear that run id in `finally`, and avoid reading mutable `selected` after the await.
- SSH automation cannot reconnect or needs credentials: rerun still goes through `runNow`; existing dispatch code records `skipped_unavailable` or `skipped_needs_interactive_auth` as a new run.
- The user clicks rerun repeatedly in the same window: disable the rerun button while the request is pending.
- The user clicks rerun in two windows: the renderer guard will not prevent duplicate manual runs across windows. Do not claim backend idempotency unless a service-level dedupe key is added.
- Refresh after rerun may leave the failed run detail selected because `selectedAutomationRunPageId` still points at the old run. That is acceptable for this change, but the run list count and rows must refresh so the new manual run is visible after navigating back.
- `runNow` itself does not broadcast `orca:automations-changed`; the initiating page must call `refresh()` after the IPC resolves. Other windows update only when dispatch result handling fires the existing event or when focus/visibility refresh runs.

## Rollout

1. Add a small predicate/helper for rerun action visibility and unit tests if it can live near automation run view state without mixing responsibilities.
2. Add rerun pending state, error handling, and handler in `AutomationsPage`.
3. Render the new action in the selected Orca run detail header.
4. Run focused tests, then `pnpm typecheck` and `pnpm lint`.
