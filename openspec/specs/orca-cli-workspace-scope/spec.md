# Orca CLI Workspace Scope Specification

## Purpose

Guide Orca agents to resolve the native folder workspace's selected repositories before creating worktrees, without expanding scope to unrelated repositories beneath its directory.

## Requirements

### Requirement: Resolve native workspace scope before repository discovery

The version-matched Orca CLI guide SHALL instruct agents that a folder workspace is a native Orca context, not all Git repositories beneath a filesystem directory. Before creating worktrees for an implicit request such as “each repository in this folder workspace,” agents MUST resolve the current folder identity and project-group context supplied by Orca and use registered repository records from the selected runtime to identify direct group members. A global repository list alone MUST NOT establish workspace membership. Filesystem scanning MUST NOT establish or expand membership.

#### Scenario: Two selected repositories beneath a directory containing fourteen

- **WHEN** the current folder workspace has two direct project-group members and its directory contains fourteen Git repositories
- **THEN** the guidance selects only the two records matching the current project-group ID within the correct execution-host scope
- **AND** the remaining twelve directories are not registered, mutated, or selected through filesystem discovery

#### Scenario: Other registered groups share the directory

- **WHEN** registered repositories beneath the directory belong to a different project group
- **THEN** those repositories are excluded from the implicit current-folder request even though they appear in the global repository list

### Requirement: Preserve existing folder parent and execution context

The guide SHALL instruct agents to keep the resolved existing folder workspace as parent of every child worktree created for the scoped request and to use the selected runtime and execution host. It MUST NOT direct agents to create a replacement folder, register additional repositories, change group membership, or reroute to a different host to satisfy that request.

#### Scenario: Create children for resolved group members

- **WHEN** folder identity, direct group members, and host ownership are resolved
- **THEN** each create targets one selected repository and uses the existing folder identity as parent
- **AND** no operation alters repository membership or creates another parent workspace

#### Scenario: Remote workspace scope is unavailable locally

- **WHEN** the request runs in an SSH or paired-runtime context and only a different runtime's repository catalog is available
- **THEN** the agent does not combine local repository records with remote folder identity or inspect local paths as a substitute
- **AND** it asks for clarification before mutation if existing read-only routing cannot resolve the scope

### Requirement: Ask before mutation when scope cannot be resolved

The guide SHALL require agents to ask for clarification before creating or registering anything when required folder identity, group context, repository membership, requested descendant-group scope, or host ownership is missing or ambiguous. A failed `worktree current` lookup in a folder context MUST NOT be interpreted as permission to discover repositories from disk. An empty matched set MUST NOT trigger directory-wide fallback.

#### Scenario: Folder context has no Git worktree match

- **WHEN** `worktree current --json` returns `selector_not_found` while Orca supplies a folder workspace identity
- **THEN** the guidance retains the folder context and resolves membership from available Orca group context and repository records
- **AND** the lookup failure does not trigger filesystem repository discovery

#### Scenario: Required group context is absent

- **WHEN** the current folder identity is known but its project-group context cannot be resolved using existing read-only information
- **THEN** the agent reports the missing scope information and asks before any creation or registration

#### Scenario: No matching repository records

- **WHEN** the resolved group has no matching repository records in the selected runtime and host scope
- **THEN** the agent reports that no eligible members were resolved and asks how to proceed
- **AND** it does not substitute repositories found beneath the folder directory

#### Scenario: Descendant group membership cannot be verified

- **WHEN** satisfying the request requires descendant project-group membership that existing read-only information does not establish
- **THEN** the agent asks the user to identify or confirm the intended repository set before mutation
- **AND** it does not infer descendants from directory nesting or claim direct-group filtering resolves them

### Requirement: Deliver scope guidance through the version-matched guide

The normal Orca CLI guide returned by `skills get orca-cli` SHALL include the scope-resolution rule, concrete context fields, repository-record matching recipe, parent preservation, and clarification fallback before the scoped worktree creation examples. The full guide SHALL retain the same rule. Explicit requests to operate on other repositories SHALL remain supported and SHALL NOT be prohibited by this implicit-scope guidance.

#### Scenario: Agent loads the normal guide

- **WHEN** the agent loads the version-matched normal Orca CLI guide
- **THEN** it receives the scope-resolution recipe without needing a conditional reference or full-guide request

#### Scenario: User explicitly selects another repository

- **WHEN** the user explicitly requests a worktree for a repository outside the current group
- **THEN** the guidance does not prohibit that request solely because the repository is outside the group
- **AND** existing creation, parenting, and host-validation rules still apply
