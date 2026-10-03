# Implementation Tasks

## 1. Backend: Window Registry

- [x] 1.1 Create `src/main/window/window-registry.ts` with class WindowRegistry (register, deregister, getWindowByWorktreeId, getWorktreesByWindowId methods) and verify all unit tests pass
- [x] 1.2 Add unit tests in `src/main/window/__tests__/window-registry.spec.ts` covering registration, deregistration, queries, and edge cases (11 test cases) and verify all tests pass

## 2. Backend: Window Persistence

- [x] 2.1 Create `src/main/window/window-persistence.ts` with saveWindowState and loadWindowState functions and verify unit tests pass
- [x] 2.2 Add unit tests in `src/main/window/__tests__/window-persistence.spec.ts` covering save, load, recovery, and edge cases (8 test cases) and verify all tests pass

## 3. Backend: Window Creation Extension

- [x] 3.1 Modify `src/main/window/createMainWindow.ts` to accept optional `initialWorktreeId` param and pass it to renderer context and verify app still launches without errors
- [x] 3.2 Update `src/main/startup/main-window-controller.ts` to add `openMainWindowForWorktree(worktreeId)` function and verify it correctly opens new windows with correct worktree
- [ ] 3.3 Integrate WindowRegistry into window lifecycle: register on create, deregister on close and verify windows are tracked in registry during their lifetime

## 4. Backend: IPC Handler

- [ ] 4.1 Create `src/main/ipc/window-state.ts` with IPC handlers for window state events and verify handlers register without errors
- [x] 4.2 Modify `src/main/ipc/worktrees.ts` to add `worktree:open-in-new-window` handler that calls `openMainWindowForWorktree` and verify IPC unit tests pass (6 test cases)
- [ ] 4.3 Add unit tests in `src/main/ipc/__tests__/worktree-new-window.spec.ts` for handler validation, error cases, and concurrency and verify all tests pass

## 5. Backend: Preload Bridge

- [x] 5.1 Modify `src/main/preload.ts` to expose `window.api.worktrees.openInNewWindow(worktreeId, workspaceKey)` method and verify it's callable from renderer without errors

## 6. Frontend: Menu Item

- [x] 6.1 Modify `src/renderer/src/components/sidebar/WorktreeOpenInMenu.tsx` to add "Open in New Window" menu item and handler that calls `window.api.worktrees.openInNewWindow()` and verify menu item appears and is clickable
- [ ] 6.2 Add unit tests in `src/renderer/src/components/__tests__/WorktreeOpenInMenu.spec.tsx` for UI interaction (4 test cases) and verify all tests pass

## 7. Frontend: Window Initialization

- [x] 7.1 Create `src/renderer/src/hooks/use-window-init.ts` hook that reads `initialWorktreeId` from context and calls `activateAndRevealWorktree()` on mount and verify hook activates correct worktree on new window
- [x] 7.2 Modify `src/renderer/src/App.tsx` to call `use-window-init` hook on mount and verify app initializes with correct worktree when opened with `initialWorktreeId`

## 8. Integration & E2E Tests

- [x] 8.1 Create `e2e/__tests__/open-worktree-in-new-window.e2e.ts` with skeleton test cases covering UI interaction, multi-window behavior, persistence, git ops, cross-platform (15+ scenarios) and verify test file structure is valid
- [ ] 8.2 Run full test suite: `pnpm test` and verify all unit tests pass (>30 test cases total)

## 9. Build & Type Check

- [x] 9.1 Run `pnpm tc` (typecheck) and verify no TypeScript errors in modified/new files
- [ ] 9.2 Run `pnpm build` and verify Electron app builds without errors

## 10. Manual Verification

- [ ] 10.1 Start app locally (`pnpm start`), right-click a worktree, verify "Open in New Window" menu item appears
- [ ] 10.2 Click "Open in New Window", verify new window opens with correct worktree pre-loaded and terminal is ready
- [ ] 10.3 Open multiple worktrees in different windows, verify each window shows independent state and closing one doesn't affect others
- [ ] 10.4 Close all windows, restart app, verify windows are restored with correct worktrees

## 11. Code Quality

- [ ] 11.1 Run `pnpm lint` and verify no linting errors in modified/new files
- [ ] 11.2 Run `pnpm format` to ensure code formatting is consistent

## 12. Completion

- [ ] 12.1 Verify all planned tasks are complete and all tests pass (unit + E2E) and app runs without crashes
- [ ] 12.2 Ready for PR review and merge
