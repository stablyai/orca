# Design

## Context

See `proposal.md` for motivation. The supplied session transcript shows that the agent loaded the normal version-matched CLI guide, read Orca folder/group environment context, then scanned child directories for `.git`. Its later read-only rerun returned exactly two registered repositories, both carrying the same `projectGroupId` as `ORCA_PROJECT_GROUP_ID`. `worktree current` returned `selector_not_found` for the enclosing folder.

Relevant implementation:

- `skill-guides/orca-cli.md` already documents folder selectors and parent inference, but starts the worktree recipe with a global repository list and has no membership-resolution section.
- `src/main/runtime/orca-runtime-resolve-browser-network-execution-host-for-worktree.ts` supplies folder terminals with `ORCA_WORKTREE_ID`, `ORCA_WORKSPACE_ID`, `ORCA_PROJECT_GROUP_ID`, and `ORCA_WORKSPACE_ROOT`.
- `src/cli/handlers/worktree.ts` implements `worktree current` using `worktree.show` after Git-worktree selector resolution; folder context does not need that command to succeed to retain its parent identity.
- `repo list` returns registered records, including project-group association, through the selected runtime. That association can resolve direct membership when combined with known current group context; the list alone is not workspace membership.
- `findFolderWorkspaceCandidateRepos` in `src/shared/folder-workspace-execution-host.ts` deliberately combines group and path candidates to classify host ownership. It must not be repurposed as selected-membership authority.
- `config/scripts/generate-bundled-skill-guides.mjs` embeds canonical guides into `src/cli/bundled-skill-guides.ts`; its existing test suite already checks guide-content contracts and generation fidelity.

## Goals / Non-Goals

**Goals:**

- Fix the observed direct-group case using existing Orca context and read-only repository records.
- Give agents one short, actionable scope recipe before any worktree creation examples.
- Fail closed on scope uncertainty while preserving explicit repository requests and existing host validation.

**Non-Goals:**

- Add a CLI/RPC scope endpoint, membership cache, bulk-create helper, or runtime creation restriction.
- Change folder import discovery, group/subgroup semantics, host classification, or attachment/sidebar behavior from PR #18199.
- Claim that direct `projectGroupId` equality enumerates descendant groups, or silently narrow a request that requires unresolved descendant membership.
- Edit installed user skill copies or hand-edit generated guide constants.

## Decisions

### 1. Add a concrete scope section to the canonical normal guide

Place `Resolve workspace scope before filesystem discovery` immediately before the Worktrees common-command examples. Include the user's requested definition and safety rule, followed by a compact recipe:

1. Keep the executable resolved by the discovery stub. Read Orca-provided `ORCA_WORKSPACE_ID`/`ORCA_WORKTREE_ID` and `ORCA_PROJECT_GROUP_ID`; folder identity must be `folder:<id>`. Conflicting or absent identity/group information requires clarification.
2. Use `ORCA repo list --json` through the session's existing runtime routing. Match direct members by exact `projectGroupId`, using repository IDs and host ownership from Orca records rather than paths. Successful, complete records and unambiguous host scope are prerequisites; errors or unavailable fields are not an empty verified membership set.
3. Create only those selected repositories with the existing `folder:<id>` parent, using documented `--repo id:<repoId>` and `--parent-worktree folder:<folderId>` forms. Retain the execution host. Scope resolution itself must not register or create anything.
4. If no eligible members are resolved, or context, host ownership, or descendant membership is unresolved, ask before mutations. A failed `worktree current` lookup does not justify scanning the directory.

Do not add `jq`, a shell-specific environment parser, or a new helper merely to express record matching. The guide names exact fields and commands; agents inspect their JSON with tools they already have. Paths can locate files after scope is established but never define selected repository membership.

Alternative: add a broad warning without a recipe. Rejected because the original guide already emphasized Orca authority, yet the agent still lacked a usable membership step.

### 2. Keep this fix guide-first, not API-first

The reported session has sufficient native context and direct-group repository records. A new endpoint would expand the fix beyond the evidenced gap. Missing information on another version or execution path must cause clarification instead of reconstructing membership from filesystem shape.

Alternative: expose a new `workspace current` or scoped-repositories endpoint now. Deferred; it becomes a separate change when a concrete unresolved native-scope use case needs automation rather than clarification. This proposal does not invent unsupported commands.

### 3. Preserve remote boundaries without changing transport

Use the runtime and host already selected for the agent session. Never join a remote folder ID to a local catalog or scan local equivalents of remote paths. Runtime-local aliases and SSH target ownership remain governed by existing Orca semantics, not a new string-equality rule in the guide. Missing folder/group context in older or remote sessions is an explicit clarification case; this change does not forward additional environment variables or change the wire contract.

### 4. Separate guide contract checks from agent behavior evidence

Extend the existing generator test file with a focused contract check that the normal and full `orca-cli` guide contain the scope section, context fields, matching recipe, parent preservation, and ask-before-mutation fallback before creation examples. Reuse existing generation-fidelity tests. These assertions prove the recipe ships; they do not prove an LLM follows it.

Validate actual behavior with a fresh agent session in a disposable folder containing fourteen Git repositories and only two direct group members. Use the exact original prompt. Capture discovery queries and create calls; success is exactly two child creations under the existing folder and no scope-expanding registration or filesystem discovery. Include missing-context and failed-`worktree current` checks. Run rendered UI checks only with hidden Electron/CDP if needed; this guide fix does not require UI changes. Visual nesting is a separate PR #18199 prerequisite, so lack of its renderer changes must not be mislabeled as a scope failure.

## Risks / Trade-offs

- [Agent ignores correct guidance] → Put the recipe in the normal guide before creation examples and repeat the original prompt in a fresh session; do not equate content assertions with behavioral proof.
- [Stale or conflicting session context] → Ask before mutation when identity/group information conflicts or cannot be resolved; do not treat environment fields as a new authorization boundary.
- [Nested project groups require additional scope information] → State that equality selects direct members only; ask when descendant scope is requested or cannot be verified. Do not substitute path containment.
- [Remote or older sessions lack required metadata] → Use existing read-only host-correct routing when available; otherwise report the gap and ask. Never switch executable or runtime to obtain a convenient catalog.
- [New guide is not served by an old binary/session] → Regenerate and rebuild the intended CLI, verify `skills get orca-cli --json`, and retest in a fresh session.

## Migration Plan

No data migration. Update the canonical guide, generate tracked outputs, run focused tests and generation verification, then rebuild the intended CLI for acceptance testing. Rollback reverts the guide, focused test, and generated output together. Do not remove unrelated worktrees already created by the faulty session; cleanup needs separate user authorization.
