# Review Context

## Branch Info

- Base: origin/main (merge-base: ddb732cf)
- Current: brennanb2025/memory-remote-meaning

## Changed Files Summary

- M src/main/daemon/daemon-pty-adapter.test.ts
- M src/main/daemon/daemon-pty-adapter.ts
- M src/main/daemon/pty-session-id.test.ts
- M src/main/daemon/pty-session-id.ts
- M src/main/window/attach-main-window-services.ts
- M src/renderer/src/components/status-bar/ResourceUsageStatusSegment.tsx
- M src/renderer/src/components/status-bar/mergeSnapshotAndSessions.test.ts
- M src/renderer/src/components/status-bar/mergeSnapshotAndSessions.ts
- A docs/resource-usage-remote-mislabel.md
- A src/main/memory/hydrate-local-pty-registry.ts
- A src/shared/pty-session-id-format.ts

## Changed Line Ranges (PR Scope)

| File | Changed Lines |
| --- | --- |
| src/main/daemon/daemon-pty-adapter.test.ts | 377-426 |
| src/main/daemon/daemon-pty-adapter.ts | 9, 328-333 |
| src/main/daemon/pty-session-id.test.ts | 2, 79-107 |
| src/main/daemon/pty-session-id.ts | 3-9, 22-24 |
| src/main/window/attach-main-window-services.ts | 27, 67-73 |
| src/main/memory/hydrate-local-pty-registry.ts | (new file, all lines) |
| src/shared/pty-session-id-format.ts | (new file, all lines) |
| src/renderer/src/components/status-bar/ResourceUsageStatusSegment.tsx | 444-448, 733-745, 759-760, 771-772 |
| src/renderer/src/components/status-bar/mergeSnapshotAndSessions.test.ts | 56, 125-128, 140, 153-174, 190-243 |
| src/renderer/src/components/status-bar/mergeSnapshotAndSessions.ts | 31, 65-69, 78-81, 101-104, 110-114, 270-278, 293, 335, 354, 370-374, 387, 406-411, 415-422 |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Electron/Main
- src/main/daemon/daemon-pty-adapter.ts
- src/main/daemon/daemon-pty-adapter.test.ts
- src/main/daemon/pty-session-id.ts
- src/main/daemon/pty-session-id.test.ts
- src/main/window/attach-main-window-services.ts
- src/main/memory/hydrate-local-pty-registry.ts

### Frontend/UI
- src/renderer/src/components/status-bar/ResourceUsageStatusSegment.tsx
- src/renderer/src/components/status-bar/mergeSnapshotAndSessions.ts
- src/renderer/src/components/status-bar/mergeSnapshotAndSessions.test.ts

### Utility/Common
- src/shared/pty-session-id-format.ts

## Skipped Issues (Do Not Re-validate)

- [src/renderer/src/components/status-bar/mergeSnapshotAndSessions.ts:370-374] | Low | Cosmetic redundancy; author kept explicit write for callsite-stability per comment. | "Redundant repo.hasRemoteChildren write in Step 2"
- [src/shared/pty-session-id-format.ts:28-38] | Low | Theoretical edge cases for inputs no production caller mints. | "Empty suffix and degenerate :: accepted by parser"
- [src/main/memory/hydrate-local-pty-registry.ts:95-100] | Low | Defensive check is dead under current data flow but cheap and self-documenting. | "Dead-defensive check"
- [src/main/memory/hydrate-local-pty-registry.ts:98] | Low | Truthy check matches the spawn-time gate; changing diverges from documented mirror. | "Use !== null instead of truthy"
- [src/main/daemon/pty-session-id.ts:9] | Low | Re-export documents intent per file comment; pattern is intentional. | "Re-export creates dual import paths"
- [src/shared/pty-session-id-format.ts:28] | Low | Object wrapper return type is deliberate forward-extensibility. | "Object wrapper around single nullable field"
- [src/renderer/src/components/status-bar/mergeSnapshotAndSessions.ts:53,64] | Low | hasLocalSamples field is asserted in tests, useful for debugging. | "hasLocalSamples now only set, never read"
- [docs/resource-usage-merge-spec.md] | Low | Out of scope per docs/resource-usage-remote-mislabel.md "Related issues (out of scope)". | "Spec doc still describes old predicate"
- [Other call sites of lastIndexOf('@@')] | Medium | Doc enumerated three sites for migration; broader cleanup is out of scope. Other sites use the parse for different purposes. | "Other open-coded parsers"
- [src/main/daemon/daemon-pty-adapter.ts:333] | Low | Comment-only suggestion. | "Tighten comment / add console.warn"
- [src/main/memory/hydrate-local-pty-registry.ts] | Low | Adding unit tests is enhancement out of scope for review-fix loop. | "Missing unit tests"

## Iteration State

Current iteration: 1
Last completed phase: Validation
Files fixed this iteration: []
Validated for fixing:
1. mergeSnapshotAndSessions.ts:109 — replace ORCA_WORKTREE_ID_SEPARATOR with shared WORKTREE_ID_SEPARATOR
2. hydrate-local-pty-registry.ts + attach-main-window-services.ts — add idempotency one-shot gate
3. daemon-pty-adapter.test.ts:415-426 — make test pin strict-format change with non-empty validWorktreeIds
4. mergeSnapshotAndSessions.test.ts — add eslint-disable max-lines directive (file is 332 lines, oxlint cap 300)
