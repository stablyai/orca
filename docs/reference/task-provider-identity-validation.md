# Task provider identity RPC validation

The automation RPC identity schema follows `src/shared/task-provider-identity.ts`,
re-exported by `src/shared/task-source-context.ts`. Only GitHub requires fields beyond
`provider`: `owner` and `repo` are strings, and `host` is optional. GitLab, Linear,
and Jira fields are optional nullable strings. Requiring a GitLab project or a
Linear workspace/Jira site would contradict the domain type and account-wide scopes.

The discriminated union validates these existing field types without trimming,
coercing, or stripping identity fields. Unknown fields pass through as they did under
`z.custom`, including fields from newer clients. Absent and explicit-null identities
remain distinct. The schema does not infer providers from owner/repo or require a
git worktree, repository slug, or local execution host for a source context.

## Producer census

Paths below are relative to the repository root. Searches covered production
`providerIdentity`, `TaskProviderIdentity`, `sourceContext`, and
`linkedTaskSourceContext` uses across desktop, shared code, mobile, and CLI.

| Producer or forwarding path                                                                | Populated verdict                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/project-host-setup-projection.ts`: `getProjectProviderIdentity`                | GitHub owner/repo populated together, or no identity. Supplies project identities consumed by desktop and migration.                                                                                                         |
| `src/renderer/src/components/task-page-source-context.tsx`: `getTaskPageRepoSourceContext` | GitHub fields populated through projection, or null. GitLab uses explicit provider and `buildGitLabProviderIdentity`; projectId/project/webUrl populated, namespace can be null.                                             |
| Same file: `buildGitLabProviderIdentity`                                                   | GitLab fields come from project path/host; missing path components become null. No required GitLab field is invented.                                                                                                        |
| `src/renderer/src/hooks/composer-state/source-context-state.ts`                            | Derived GitHub context carries a complete project identity or null. Jira folder/project-group context explicitly has null identity. Draft/linked contexts are forwarded.                                                     |
| `src/renderer/src/components/use-task-page-source-availability.ts`                         | Linear workspaceId/name and Jira siteId/URL can be null for account-wide selections; team/project fields are not populated. Valid under the existing optional-field contract.                                                |
| `src/renderer/src/components/task-page-jira-item-source-context.ts`                        | Bound issue context populates siteId, siteUrl, projectKey.                                                                                                                                                                   |
| `src/renderer/src/components/new-workspace/use-jira-url-source.ts`                         | Bound URL issue context populates siteId, siteUrl, projectKey.                                                                                                                                                               |
| `src/renderer/src/components/worktree-jump-palette-create-worktree.ts`                     | Linear teamId/key populated; workspaceId/name may be null.                                                                                                                                                                   |
| `src/shared/task-source-context.ts`: normalize/build functions                             | GitHub missing owner/repo becomes null identity; other providers' missing fields become null. Provider mismatch becomes null, never an inferred provider.                                                                    |
| `src/cli/handlers/automation-handler-flags.ts`, `src/cli/handlers/automations.ts`          | Explicit JSON source-context input is normalized before create/update. GitHub fields populated or null identity; other fields nullable. Omitted/null context preserved by flag handling.                                     |
| `src/main/persistence/scheduling-automations/automation-context-migration.ts`              | Builds source context from projected complete GitHub identity, or null context.                                                                                                                                              |
| Desktop automation save/scoped-list/host clients and web transport                         | Forward existing source contexts, not new identity constructors. `automation-orca-save.ts` forwards the current automation context or null. Legacy arbitrary malformed RPC input is deliberately rejected by the new schema. |
| Mobile                                                                                     | No task-provider identity/source-context constructor or sender found. `mobile/src/components/new-workspace-project-targets.ts` uses project identity solely for display.                                                     |

## Compatibility evidence and limits

Read `docs/reference/remote-wire-compatibility.md` before changing validation.
A source search against release tag `v1.4.199` also finds no mobile
`sourceContext`/`linkedTaskSourceContext` sender; its sole `providerIdentity` use
is the display-only project target above. The released CLI flag reader also calls
`normalizeTaskSourceContext`. This is source-level evidence for the checked release,
not a claim to have executed every historical mobile binary.

No shipped mobile producer with a newly rejected payload was found. No new required
field was added to the domain contract. GitLab, Linear, and Jira discriminant-only
identities remain valid. Folder-workspace null/absent identities remain valid on
both local and SSH hosts. No execution/status logic or client-side parsing changed.

## Regression evidence

`src/main/runtime/rpc/methods/task-provider-identity.test.ts` checks unchanged valid
identities for all four providers, required GitHub fields, every declared field's
type, optional/null non-GitHub fields, unknown-field preservation, explicit GitLab
discrimination with owner/repo present, local/SSH folder contexts, and update patches.

The focused run passed 74 tests. Temporarily replacing GitHub's field validators
with optional `z.unknown()` validators (discriminant-only acceptance) caused 16
failures and 58 passes. The mutation was restored before running the gates.

## Gate results

All commands ran with `ORCA_BACKGROUND_LAUNCH=1`.

- `pnpm tc`: exit 0; completed the repository typecheck runner.
- `pnpm exec vitest run src/main/runtime/rpc`: exit 1; 277 files passed,
  one failed; 2,462 tests passed, one failed, one skipped. The only failure was
  the unrelated `structured-agent-session-adoption-replay.test.ts` hitting its
  5,000 ms timeout. All identity tests passed.
- `pnpm --dir mobile typecheck`: exit 0; `tsc --noEmit` passed.
- `pnpm run check:code-quality:changed`: exit 0; zero new code-quality,
  type-aware, or React Doctor findings across the two changed code files.
- Isolated retry of `structured-agent-session-adoption-replay.test.ts`: exit 0;
  one test passed, with the test body completing in 358 ms.
- Full RPC retry with `pnpm exec vitest run src/main/runtime/rpc --maxWorkers=4`:
  exit 0; all 278 files passed, 2,463 tests passed, one skipped (97.24 seconds).
  The bounded-concurrency rerun resolved the timeout without changing test code.
