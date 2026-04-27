# Review Context

## Branch Info

- Base: origin/main (merge-base: b19db2301df9fe908386318207d15d65157c6d9b)
- Current: brennanb2025/Support-upstream-remote-as-base-ref-for-fork-based-workflows

## Changed Files Summary

- A src/main/git/repo.test.ts (new, 204 lines)
- M src/main/git/repo.ts
- M src/main/ipc/repos-remote.test.ts
- M src/main/ipc/repos.ts
- M src/preload/api-types.d.ts
- M src/preload/index.d.ts
- M src/preload/index.ts
- M src/renderer/src/components/right-sidebar/SourceControl.tsx
- M src/renderer/src/components/settings/BaseRefPicker.tsx
- M src/shared/types.ts

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File                                                       | Changed Lines                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| src/main/git/repo.test.ts                                  | 1-204 (new file)                                                                             |
| src/main/git/repo.ts                                       | 7-42, 231-254, 269, 279-289, 293, 295-296, 302, 308-357                                       |
| src/main/ipc/repos-remote.test.ts                          | 14-15, 27-44, 103, 204-390                                                                    |
| src/main/ipc/repos.ts                                      | 8, 21-24, 357-365, 367-372, 374-433, 435-442, 444, 460-468, 470-474, 478, 480-482, 486-495   |
| src/preload/api-types.d.ts                                 | 3, 302                                                                                       |
| src/preload/index.d.ts                                     | 3, 41                                                                                        |
| src/preload/index.ts                                       | 9, 214                                                                                       |
| src/renderer/src/components/right-sidebar/SourceControl.tsx | 224-227, 230-231                                                                             |
| src/renderer/src/components/settings/BaseRefPicker.tsx     | 23-27, 39-40, 42-43, 46, 53-57, 88-89, 123-144                                                |
| src/shared/types.ts                                        | 24-44                                                                                        |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Electron/Main (Priority 1)

- src/main/git/repo.ts
- src/main/git/repo.test.ts
- src/preload/api-types.d.ts
- src/preload/index.d.ts
- src/preload/index.ts

### Backend/IPC (Priority 2)

- src/main/ipc/repos.ts
- src/main/ipc/repos-remote.test.ts

### Frontend/UI (Priority 3)

- src/renderer/src/components/right-sidebar/SourceControl.tsx
- src/renderer/src/components/settings/BaseRefPicker.tsx

### Utility/Common (Priority 5)

- src/shared/types.ts

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

(none yet)

## Iteration State

Current iteration: 1
Last completed phase: Setup
Files fixed this iteration: []
