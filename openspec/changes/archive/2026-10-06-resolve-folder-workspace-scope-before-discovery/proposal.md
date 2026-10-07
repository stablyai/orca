# Proposal

## Why

An agent asked to create one worktree per repository in a folder workspace scanned 14 Git directories instead of using the two repositories selected in Orca's project group. The version-matched CLI guide explains folder parenting but does not explain how to resolve repository membership before discovery or mutation.

## What Changes

- Add “Resolve workspace scope before filesystem discovery” to the version-matched Orca CLI guide before worktree creation examples.
- Define a folder workspace as an Orca context, not a directory-wide repository search. Use Orca-provided folder identity and project-group context with host-correct `repo list --json` records; select direct members by matching `projectGroupId`.
- Preserve the existing folder as parent when creating children; do not register repositories, create a replacement folder, or expand membership through filesystem scanning.
- Require clarification before mutations when identity, group membership, host ownership, or requested descendant-group scope cannot be resolved with existing read-only information.
- Regenerate the bundled guide and add a focused guide contract check plus a manual 14-directory/two-member regression.

## Capabilities

### New Capabilities

- `orca-cli-workspace-scope`: Agent guidance for resolving folder-workspace repository scope, preserving parent identity, and refusing discovery-based scope expansion.

### Modified Capabilities

None. `folder-group-import-explanations` concerns explicit import discovery and remains unchanged.

## Impact

- Canonical guidance: `skill-guides/orca-cli.md`.
- Generated CLI guide: `src/cli/bundled-skill-guides.ts`, updated only through `pnpm run generate:bundled-skill-guides` and any associated generator outputs.
- Existing contract tests: `config/scripts/generate-bundled-skill-guides.test.mjs`.
- No new CLI command, RPC method, dependencies, filesystem discovery policy, membership model, or creation restriction. Explicit user requests for other repositories remain supported.
- Local, SSH, and paired-runtime sessions use their existing executable and routing. Missing context on older builds or remote sessions causes clarification, not local discovery fallback.
