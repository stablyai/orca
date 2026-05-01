# Review Context

## Branch Info

- Base: origin/main
- Current: brennanb2025/feature-2-per-repo-issue-source-selector

## Changed Files Summary

| File                                                              | Type |
| ----------------------------------------------------------------- | ---- |
| docs/per-repo-issue-source-selector.md                            | A    |
| src/main/github/client-issue-source.test.ts                       | A    |
| src/main/github/client-work-items.test.ts                         | M    |
| src/main/github/client.ts                                         | M    |
| src/main/github/gh-utils.test.ts                                  | M    |
| src/main/github/gh-utils.ts                                       | M    |
| src/main/github/issues.test.ts                                    | M    |
| src/main/github/issues.ts                                         | M    |
| src/main/ipc/github.test.ts                                       | M    |
| src/main/ipc/github.ts                                            | M    |
| src/main/ipc/repos.ts                                             | M    |
| src/main/persistence.test.ts                                      | M    |
| src/main/persistence.ts                                           | M    |
| src/preload/api-types.ts                                          | M    |
| src/renderer/src/components/TaskPage.tsx                          | M    |
| src/renderer/src/components/github/IssueSourceSelector.tsx        | A    |
| src/renderer/src/store/slices/github.ts                           | M    |
| src/renderer/src/store/slices/repos.ts                            | M    |
| src/shared/types.ts                                               | M    |

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File                                                         | Changed Lines                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| docs/per-repo-issue-source-selector.md                       | 1-222 (entire new file)                                                                                      |
| src/main/github/client-issue-source.test.ts                  | 1-481 (entire new file)                                                                                      |
| src/main/github/client-work-items.test.ts                    | 1-3, 11-12, 21-22, 33-34, 37-39, 54-55, 60-67, 105                                                           |
| src/main/github/client.ts                                    | 5, 26-27, 584-585, 587-595, 597, 619-625, 720-726, 729                                                       |
| src/main/github/gh-utils.test.ts                             | 14-15, 18-19, 89-198                                                                                         |
| src/main/github/gh-utils.ts                                  | 4, 57-64, 100, 130, 165-202                                                                                  |
| src/main/github/issues.test.ts                               | 4-10, 13, 24, 36, 40-46                                                                                      |
| src/main/github/issues.ts                                    | 1-4, 11, 16, 21-30, 35-41, 85-90, 120-122, 125-128, 142-143, 149, 192-193, 195, 268-269, 271, 313-317, 344-348 |
| src/main/ipc/github.test.ts                                  | 98, 126                                                                                                      |
| src/main/ipc/github.ts                                       | 1-4, 77, 84, 92-98, 104, 308, 322, 328, 333, 340-346                                                         |
| src/main/ipc/repos.ts                                        | 210-218                                                                                                      |
| src/main/persistence.test.ts                                 | 252-279                                                                                                      |
| src/main/persistence.ts                                      | 359-367, 374-385                                                                                             |
| src/preload/api-types.ts                                     | 311-319                                                                                                      |
| src/renderer/src/components/TaskPage.tsx                     | 61, 639-652, 664-669, 805-810, 909-938, 1246-1252, 1262, 1333-1342, 2001-2040, 2042-2059, 2689-2758          |
| src/renderer/src/components/github/IssueSourceSelector.tsx   | 1-178 (entire new file)                                                                                      |
| src/renderer/src/store/slices/github.ts                      | 8, 22-24, 49-55, 281-304, 313, 405-406, 864-931                                                              |
| src/renderer/src/store/slices/repos.ts                       | 19-27                                                                                                        |
| src/shared/types.ts                                          | 7-23, 36-39, 624, 657-661, 667-671                                                                           |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Electron/Main (priority 1: src/main/, src/preload/)
- src/main/github/client-issue-source.test.ts
- src/main/github/client-work-items.test.ts
- src/main/github/client.ts
- src/main/github/gh-utils.test.ts
- src/main/github/gh-utils.ts
- src/main/github/issues.test.ts
- src/main/github/issues.ts
- src/main/persistence.test.ts
- src/main/persistence.ts
- src/preload/api-types.ts

### Backend/IPC (priority 2: src/main/ipc/)
- src/main/ipc/github.test.ts
- src/main/ipc/github.ts
- src/main/ipc/repos.ts

### Frontend/UI (priority 3: src/renderer/, *.tsx)
- src/renderer/src/components/TaskPage.tsx
- src/renderer/src/components/github/IssueSourceSelector.tsx
- src/renderer/src/store/slices/github.ts
- src/renderer/src/store/slices/repos.ts

### Utility/Common (priority 5)
- src/shared/types.ts
- docs/per-repo-issue-source-selector.md

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

- src/main/github/issues.ts:123-128 | Low | Purely theoretical JSON.parse() misclassification with no realistic trigger. Fixing tightly couples caller to gh's behavior | listIssues catch wraps JSON.parse SyntaxErrors as classified errors
- src/renderer/src/store/slices/github.ts:889-896 | Medium | Explicitly documented design choice: "worst case we trigger a harmless re-fetch" — removing cache eviction in catch branch would require cross-cutting refactor that's out of scope | Cache eviction still runs on IPC failure
- src/renderer/src/store/slices/github.ts:864 | Medium | Low-probability race (rapid double-click); optimistic UI already snaps to whatever IPC returns; complex lock would be overkill for this scenario | Concurrent setIssueSourcePreference calls can resolve out of order
- src/renderer/src/components/github/IssueSourceSelector.tsx:3 | Low | Pure refactor; cross-file move with no functional impact | Extract sameGitHubOwnerRepo to shared module
- src/shared/types.ts:22 | Medium | Design choice explicitly documented in design doc §1; 'auto' ↔ undefined equivalence enforced at write sites; refactor out of scope | IssueSourcePreference has dual representation ('auto' | undefined)
- src/main/github/client.ts:720-730 | Low | countWorkItems ownerRepo fallback is pre-existing pattern not causing live bug; readability improvement only | ownerRepo = prOwnerRepo ?? issueOwnerRepo fallback makes control flow unclear
- src/main/github/gh-utils.ts:115 | Low | Pre-existing cache with no invalidation; documented v1 limitation in design doc §10 | ownerRepoCache not invalidated on remote changes
- src/main/github/client.ts:599,739 | Low | Pre-existing acquire/release pattern; fan-out factor not materially worse than before PR | Semaphore slot can hold 2 gh subprocesses
- src/main/github/client.ts:366-417 | Low | Pre-existing fallback behavior in listRecentWorkItems not introduced by this PR | Mixed-source results possible when issueOwnerRepo is null
- src/renderer/src/components/TaskPage.tsx:895-907 | Low | Memoization optimization; not a correctness issue; premature optimization | perRepoSourceState depends on entire workItemsCache
- src/renderer/src/components/TaskPage.tsx:915-937 | Low | Similar memoization optimization; effect is idempotent via ref guard | fellBack toast effect depends on entire workItemsCache
- src/main/github/issues.ts:11 | Low | JSDoc nit | JSDoc doesn't mention undefined==='auto' equivalence
- src/main/github/client-issue-source.test.ts:62-65 | Low | Test mocking pattern; making default mock assert would be noisy | Default resolveIssueSource mock masks preference-ignoring regressions
- src/renderer/src/components/TaskPage.tsx:805-810,1246-1252,1336-1342 | Low | Defense-in-depth pattern documented in comments | Two parallel nonce mechanisms (preferenceInvalidated + taskRefreshNonce)
- src/renderer/src/components/github/IssueSourceSelector.tsx:125-156 | Low | Only two options; Tab navigation is sufficient | role="radiogroup" / arrow-key navigation
- src/shared/types.ts:36-39 | Low | Type invariant leak acceptable per JSDoc; big refactor out of scope | issueSourcePreference on folder repos

## Iteration State

<!-- Updated after each phase to enable crash recovery -->

Current iteration: 1
Last completed phase: Validation
Files fixed this iteration: []

## Fix Manifest (Iteration 1)

| File | Issue | Severity |
| --- | --- | --- |
| src/main/github/issues.ts | Remove `preference` param from `updateIssue` and `addIssueComment` — silently routing through live preference re-creates the #1186 silent-source-switch class | High |
| src/main/ipc/github.ts | Drop `preference` argument from `gh:updateIssue` and `gh:addIssueComment` handlers after the underlying functions stop accepting it | High |
| src/main/github/gh-utils.ts | `resolveIssueSource` should set `fellBack: false` when fallback to origin produced null (no origin either) — avoids misleading toast when no source exists | Low |
| src/main/ipc/repos.ts | Validate `issueSourcePreference` value at IPC boundary to prevent persisting garbage | Medium |
| src/renderer/src/components/TaskPage.tsx | Change outer wrapper from `<span>` to `<div>` on line 2042 — wrapping `<div role="group">` inside `<span>` is invalid HTML | Medium |
| src/renderer/src/store/slices/github.ts | Add toast on persist failure in `setIssueSourcePreference` catch branch so user sees why UI reverts | Low |
| src/main/ipc/github.test.ts | Add a test verifying `repo.issueSourcePreference` is threaded through to `listIssues` (and at least one other handler) | Low |
| src/shared/types.ts | `issueSourceFellBack?: boolean` → `issueSourceFellBack?: true` to encode "present iff fell-back" invariant | Low |
| src/shared/types.ts | `upstreamCandidate?: GitHubOwnerRepo \| null` → `upstreamCandidate: GitHubOwnerRepo \| null` to match siblings | Low |
| src/renderer/src/store/slices/github.ts | Same as types.ts: tighten `upstreamCandidate` to match sibling shape | Low |
| docs/per-repo-issue-source-selector.md | Fix stale `persistence.ts:268` anchor; remove `src/preload/index.ts` mention in §5; correct "Extend" → "Add" for `client-issue-source.test.ts`; add `src/main/ipc/github.ts` to Files-to-touch | Low |
