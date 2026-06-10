---
name: tracker-test-suites
description: How issue-tracker providers (jira/linear/asana) structure their test suites and where coverage tends to be thin
metadata:
  type: project
---

Issue-tracker providers live under `src/main/<provider>/` (client.ts + issues.ts), `src/main/runtime/rpc/methods/<provider>.ts`, `src/renderer/src/runtime/runtime-<provider>-client.ts`, and `src/renderer/src/store/slices/<provider>.ts`.

**Test-depth baseline (for parity comparisons):**
- Linear is the deepest: separate test files for client, issues, projects, teams, mappers, plus store-slice + invalidation tests and several component tests.
- Jira is mid: `jira/issues.test.ts` only (no `client.test.ts`).
- Asana (PR #4881): `client.test.ts` + `issues.test.ts`, rpc methods test, runtime-client test, store-slice test. No `ipc/asana.test.ts` (Linear and Jira both have ipc tests).

**Recurring untested-but-risky path across providers:** the auth-error handler (`isAuthError` → `clearToken` → conditionally rethrow). Jira/Linear issues tests mock `isAuthError` to always return false, so the token-clearing branch is never exercised. Asana adds novel logic here: `shouldThrowAuthError(selection)` swallows auth errors only when selection === 'all' (multi-workspace fan-out), rethrows otherwise — this swallow-vs-throw split is the highest-value gap to flag.

**Why:** these are credential-lifecycle and multi-workspace aggregation paths; a regression silently drops a workspace's tasks or fails to clear a revoked token.
**How to apply:** when reviewing a new tracker provider's tests, check the auth-error branch, the safeStorage encrypt/decrypt fallback, and multi-workspace fan-out aggregation specifically — they are the parts that differ from the copy-paste baseline and are routinely under-tested.
