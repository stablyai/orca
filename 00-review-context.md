# Review Context

## Branch Info

- Base: origin/main
- Current: brennanb2025/Support-upstream-remote-as-base-ref-for-fork-based-workflows

## Changed Files Summary

- M src/main/git/repo.ts
- M src/main/ipc/repos-remote.test.ts
- M src/main/ipc/repos.ts
- M src/preload/api-types.d.ts
- M src/preload/index.d.ts
- M src/preload/index.ts
- M src/renderer/src/components/right-sidebar/SourceControl.tsx
- M src/renderer/src/components/settings/BaseRefPicker.tsx
- ?? src/main/git/repo.test.ts (untracked, new)

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File                                                        | Changed Lines                                            |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| src/main/git/repo.ts                                        | 195-222, 260-270, 276-277, 287-289                       |
| src/main/git/repo.test.ts                                   | 1-199 (new file)                                         |
| src/main/ipc/repos-remote.test.ts                           | 14-15, 31-33, 35, 197-303                                |
| src/main/ipc/repos.ts                                       | 21-23, 355-363, 365-370, 372-398, 400-404, 406, 423-427, 433-434, 442-443 |
| src/preload/api-types.d.ts                                  | 301-303                                                  |
| src/preload/index.d.ts                                      | 40-42                                                    |
| src/preload/index.ts                                        | 213-215                                                  |
| src/renderer/src/components/right-sidebar/SourceControl.tsx | 224-227                                                  |
| src/renderer/src/components/settings/BaseRefPicker.tsx      | 23-27, 39-40, 45, 52, 117-129                            |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Electron/Main (src/main/, src/preload/)

- src/main/git/repo.ts
- src/main/git/repo.test.ts
- src/main/ipc/repos-remote.test.ts
- src/main/ipc/repos.ts
- src/preload/api-types.d.ts
- src/preload/index.d.ts
- src/preload/index.ts

### Frontend/UI (src/renderer/)

- src/renderer/src/components/right-sidebar/SourceControl.tsx
- src/renderer/src/components/settings/BaseRefPicker.tsx

### Backend/IPC

(none - already categorized as Electron/Main)

### Config/Build

(none)

### Utility/Common

(none)

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->
<!-- NOTE: Skips should be RARE - only purely cosmetic issues with no functional impact -->

- BaseRefPicker.tsx:124 | Low | Purely cosmetic (no layout transition on hint toggle) | Add fade transition when multi-remote hint appears
- BaseRefPicker.tsx:27,52 | Low | Pure stylistic refactor (useState combining) | Combine defaultBaseRef + remoteCount into one useState
- repo.ts:191-193 | Low | Pre-existing duplication (getBaseRefDefault wrapper around getDefaultBaseRefAsync, plus sync/async duplication) | Remove trivial wrapper / consolidate sync & async probe orders
- BaseRefPicker.tsx:23-27,39-40 | Medium | Out of scope — pre-existing architecture (duplicate IPC call existed before this PR; consolidation would require lifting state / adding zustand slice, significant refactor beyond PR scope) | Two components call getBaseRefDefault independently
- SourceControl.tsx:224-227 | Low | Out of scope — tied to above duplicate-fetch refactor | Discards remoteCount on envelope
- BaseRefPicker.tsx:32-58 | Low | Out of scope — pre-existing (no request dedup/cache across mounts) | No caching on getBaseRefDefault
- SourceControl.tsx:227 | Low | False positive — typed IPC boundary guarantees shape; catch already handles exceptions | Defensive destructuring of result
- BaseRefPicker.tsx:39 | Low | False positive — TypeScript guarantees result.remoteCount is a number | NaN/negative guard on remoteCount

## Iteration State

<!-- Updated after each phase to enable crash recovery -->

Current iteration: 1
Last completed phase: Validation
Files fixed this iteration: []
Fix manifest:
  - src/main/ipc/repos.ts: 4 issues (SSH searchBaseRefs sanitize query, SSH dedup, SSH fallback probes, parallelize default+count)
  - src/renderer/src/components/settings/BaseRefPicker.tsx: 2 issues (reset defaultBaseRef, aria-live on hint)
  - src/main/git/repo.test.ts: 1 issue (git init version-agnostic)
  - src/main/ipc/repos-remote.test.ts: 1 issue (reset mockGitProvider.exec in beforeEach)
Note: src/main/git/repo.ts may need export change for normalizeRefSearchQuery to support the SSH sanitize fix
