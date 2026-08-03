# PR #11369 Reproduction Final Verifier Report

## Decision

Reject candidate `f92db196a1d4c6cdefeb1d938b2f54b3a6a85e3e`.

## Finding

After save quiescence, restored-editor owner migration can return `{ ok: true }` when the sibling worktree disappears or a folder root changes. The migration must re-resolve after quiescence and fail closed unless the workspace ID, root-derived relative path, execution host, runtime owner, and SSH/pairing generation exactly match the pre-quiescence route.

## Required regression

Hold the source save queue open, change or remove the destination route, release quiescence, and require migration to refuse every stale route without mutating editor or workspace state.
