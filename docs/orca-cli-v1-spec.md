# Orca CLI V1 Spec

## Goal

Define the first strict `orca` CLI contract for agents.

This spec focuses on:

- exact commands
- exact selector grammar
- exact handle semantics
- exact JSON contract
- what is in v1 now
- what is explicitly deferred because the current runtime does not yet support it cleanly

This document is intended to be implementation-facing.

## Scope

The CLI connects to a running Orca editor.

The v1 contract is split into two buckets:

- `v1-now`: can be grounded in current Orca persistence and IPC behavior with limited new plumbing
- `v1-runtime-layer`: desirable v1 public contract, but requires a shared runtime/orchestration layer before it is safe to ship

## Global Rules

### Output modes

All agent-facing commands must support `--json`.

When `--json` is used:

- stdout contains exactly one JSON object
- stdout contains no progress text, logs, or prose
- stderr is reserved for failures and unexpected diagnostics
- non-zero exit code indicates command failure

Human-readable output may exist without `--json`, but `--json` is the normative contract for agents.

### Metadata

All `--json` responses include:

```json
{
  "_meta": {
    "orcaVersion": "1.0.0",
    "requestId": "req_123"
  }
}
```

Commands that depend on the live runtime layer also include:

```json
{
  "_meta": {
    "runtimeId": "runtime_abc123"
  }
}
```

### Errors

All failures in `--json` mode must return:

```json
{
  "_meta": {
    "requestId": "req_123"
  },
  "error": {
    "code": "selector_not_found",
    "message": "No worktree matched selector \"branch:feature/foo\".",
    "retryable": false
  }
}
```

Minimum standard error codes:

- `orca_not_running`
- `runtime_unavailable`
- `selector_not_found`
- `selector_ambiguous`
- `terminal_handle_stale`
- `terminal_not_found`
- `repo_not_found`
- `worktree_not_found`
- `not_supported_in_v1`
- `invalid_argument`

## Selectors

Selectors are command-time identifiers.

### Repo selector grammar

Explicit forms:

- `id:<repo-id>`
- `path:<absolute-path>`
- `name:<display-name>`

Bare fallback order:

1. exact repo id match
2. exact absolute path match
3. exact display name match

If more than one repo matches a bare selector, fail with `selector_ambiguous`.

### Worktree selector grammar

Explicit forms:

- `id:<worktree-id>`
- `path:<absolute-path>`
- `branch:<branch-name>`
- `issue:<number>`

Bare fallback order:

1. exact worktree id match
2. exact absolute path match
3. exact branch name match

If more than one worktree matches a bare selector, fail with `selector_ambiguous`.

`issue:<number>` must fail with `selector_ambiguous` if multiple worktrees share the same linked issue.

### Terminal selector grammar

There is no durable selector for repeated live interaction in v1.

Discovery returns runtime handles. Follow-up commands use:

- `--terminal <handle>`

Human-friendly targeting like `title:<name>` may be useful later, but it is not part of the strict repeated-interaction contract.

## Runtime Handles

Handles identify live terminal targets.

Rules:

- handles are opaque
- handles are scoped to a specific `runtimeId`
- handles are ephemeral by default
- runtime restart or renderer reload may invalidate all existing handles
- callers must reacquire handles after reconnect/reload unless the runtime explicitly guarantees continuity
- stale handles must fail with `terminal_handle_stale`

Example stale-handle error:

```json
{
  "_meta": {
    "runtimeId": "runtime_new456",
    "requestId": "req_123"
  },
  "error": {
    "code": "terminal_handle_stale",
    "message": "The terminal handle is no longer valid for the current Orca runtime.",
    "retryable": true
  }
}
```

## Commands

## `orca status`

Purpose:

- confirm Orca is running
- return current runtime identity

Status:

- `v1-runtime-layer`

Example:

```bash
orca status --json
```

Response:

```json
{
  "_meta": {
    "orcaVersion": "1.0.0",
    "runtimeId": "runtime_abc123",
    "requestId": "req_123"
  },
  "status": {
    "running": true,
    "runtimeAvailable": true,
    "capabilities": {
      "repo": true,
      "worktree": true,
      "file": true,
      "search": true,
      "git": true,
      "gh": true,
      "terminal": false,
      "worktreePs": false
    }
  }
}
```

Implementation note:

- a minimal “is Orca running” probe may be possible earlier
- the strict `status` contract in this spec assumes the runtime layer exists and can issue a real `runtimeId`

## `orca repo list`

Status:

- `v1-now`

```bash
orca repo list --json
```

Response:

```json
{
  "_meta": {
    "orcaVersion": "1.0.0",
    "requestId": "req_123"
  },
  "repos": [
    {
      "id": "repo_1",
      "path": "/abs/repo",
      "displayName": "orca",
      "worktreeBaseRef": "origin/main"
    }
  ]
}
```

## `orca repo add`

Status:

- `v1-now`

```bash
orca repo add --path /abs/repo --json
```

## `orca repo show`

Status:

- `v1-now`

```bash
orca repo show --repo path:/abs/repo --json
```

## `orca repo set-base-ref`

Status:

- `v1-now`

```bash
orca repo set-base-ref --repo id:repo_1 --ref origin/main --json
```

## `orca repo search-refs`

Renamed from `search-base-refs` for better verb consistency.

Status:

- `v1-now`

```bash
orca repo search-refs --repo id:repo_1 --query main --json
```

## `orca worktree list`

Full listing command.

Status:

- `v1-now`

```bash
orca worktree list --repo id:repo_1 --json
```

Response:

```json
{
  "_meta": {
    "orcaVersion": "1.0.0",
    "requestId": "req_123"
  },
  "worktrees": [
    {
      "id": "repo_1::/abs/wt",
      "repoId": "repo_1",
      "path": "/abs/wt",
      "branch": "refs/heads/feature/foo",
      "displayName": "Feature Foo",
      "linkedIssue": 123,
      "comment": "parser work"
    }
  ]
}
```

## `orca worktree ps`

Compact orchestration summary command.

Status:

- `v1-runtime-layer`

Rationale:

- desirable public contract
- requires a shared live-runtime summary service, not just persisted state

```bash
orca worktree ps --json
```

Response:

```json
{
  "_meta": {
    "orcaVersion": "1.0.0",
    "runtimeId": "runtime_abc123",
    "requestId": "req_123"
  },
  "worktrees": [
    {
      "id": "repo_1::/abs/wt",
      "repo": "orca",
      "branch": "feature/foo",
      "linkedIssue": 123,
      "unread": false,
      "liveTerminals": 2,
      "status": "active"
    }
  ]
}
```

## `orca worktree show`

Status:

- `v1-now`

```bash
orca worktree show --worktree branch:feature/foo --json
```

Focused v1 also accepts `active` / `current` as CLI-only shortcuts for worktree
selectors. The CLI resolves them from the caller's current directory and sends a
`path:` selector to the runtime.

## `orca worktree current`

Status:

- `v1-now`

```bash
orca worktree current --json
```

## `orca worktree create`

Status:

- `v1-now`

This must preserve current editor behavior:

- sanitize name
- compute branch name from settings
- reject branch conflicts
- best-effort reject historical PR head-name reuse
- compute path under workspace root
- use chosen/default base ref
- create worktree
- best-effort apply linked issue/comment metadata

```bash
orca worktree create --repo path:/abs/repo --name feature-foo --issue 123 --comment "parser work" --json
```

## `orca worktree set`

Status:

- `v1-now`

```bash
orca worktree set --worktree branch:feature/foo --display-name "Parser" --issue 123 --comment "parser work" --json
orca worktree set --worktree active --comment "parser work" --json
```

## `orca worktree rm`

Status:

- `v1-now`

```bash
orca worktree rm --worktree path:/abs/wt --force --json
```

## `orca terminal list`

Purpose:

- discover live terminal handles for a worktree

Status:

- `v1-runtime-layer`

Rationale:

- requires shared orchestration service over renderer-owned layout plus main-owned PTYs

```bash
orca terminal list --worktree id:repo_1::/repo/.worktrees/feature-foo --json
```

Response:

```json
{
  "_meta": {
    "orcaVersion": "1.0.0",
    "runtimeId": "runtime_abc123",
    "requestId": "req_123"
  },
  "terminals": [
    {
      "handle": "term_a2",
      "title": "claude",
      "status": "running",
      "worktree": "branch:feature/foo",
      "tabId": "tab_1",
      "tabTitle": "Claude Code",
      "leafId": "leaf_2",
      "preview": "I updated the parser. Do you want me to run the full suite?"
    }
  ]
}
```

Optional:

- `--layout` may include secondary tab/layout context when the caller needs it

## `orca terminal show`

Metadata-only.

Status:

- `v1-runtime-layer`

```bash
orca terminal show --terminal term_a2 --json
```

Response:

```json
{
  "_meta": {
    "orcaVersion": "1.0.0",
    "runtimeId": "runtime_abc123",
    "requestId": "req_123"
  },
  "terminal": {
    "handle": "term_a2",
    "title": "claude",
    "status": "running",
    "cwd": "/abs/wt",
    "tabId": "tab_1",
    "tabTitle": "Claude Code",
    "leafId": "leaf_2",
    "lastOutputAt": 1712345678,
    "lastInputAt": 1712345600,
    "preview": "I updated the parser. Do you want me to run the full suite?"
  }
}
```

## `orca terminal read`

Content-only, bounded.

Status:

- `v1-runtime-layer`

```bash
orca terminal read --terminal term_a2 --json
```

Response:

```json
{
  "_meta": {
    "orcaVersion": "1.0.0",
    "runtimeId": "runtime_abc123",
    "requestId": "req_123",
    "truncated": false
  },
  "terminal": {
    "handle": "term_a2",
    "status": "running",
    "tail": [
      "Running targeted tests...",
      "3 passed",
      "I updated the parser and fixed the failing snapshot."
    ],
    "nextCursor": null
  }
}
```

## `orca terminal send`

Status:

- `v1-runtime-layer`

Supported forms:

- `--text <text>`
- `--enter`
- `--interrupt`

```bash
orca terminal send --terminal term_a2 --text "continue" --json
```

## `orca terminal wait`

Status:

- `exit`: `v1-runtime-layer`
- `input`: deferred
- `idle`: deferred
- `output`: deferred

Rationale:

- `exit` can be grounded in PTY exit events
- the others require new runtime instrumentation and/or heuristics

```bash
orca terminal wait --terminal term_a2 --for exit --json
```

For unsupported wait modes in initial v1:

```json
{
  "_meta": {
    "requestId": "req_123"
  },
  "error": {
    "code": "not_supported_in_v1",
    "message": "terminal wait --for input requires runtime instrumentation that is not available in v1.",
    "retryable": false
  }
}
```

## `orca terminal stop`

Stop live terminals for a worktree.

Status:

- `v1-runtime-layer`

This replaces `worktree shutdown` in the primary surface because the action is terminal-oriented.

Initial supported target:

- `--worktree <selector>`

Later extension:

- `--terminal <handle>`

## `orca file ls`

Status:

- `v1-now`

```bash
orca file ls --worktree id:repo_1::/repo/.worktrees/feature-foo --path src --json
```

## `orca file read`

Status:

- `v1-now`

```bash
orca file read --worktree id:repo_1::/repo/.worktrees/feature-foo --path src/main.ts --json
```

## `orca file write`

Status:

- `v1-now`

```bash
orca file write --worktree id:repo_1::/repo/.worktrees/feature-foo --path src/main.ts --stdin --json
```

## `orca file create`

Status:

- `v1-now`

## `orca file mkdir`

Status:

- `v1-now`

## `orca file rename`

Status:

- `v1-now`

## `orca file rm`

Status:

- `v1-now`

## `orca file stat`

Status:

- `v1-now`

## `orca search text`

Status:

- `v1-now`

```bash
orca search text --worktree id:repo_1::/repo/.worktrees/feature-foo --query worktree --json
```

## `orca search files`

Status:

- `v1-now`

Keep separate from `file ls --query` in v1.

Rationale:

- clearer distinction between tree listing and search behavior
- aligns with existing product/search mental model

## `orca git status`

Status:

- `v1-now`

## `orca git diff`

Status:

- `v1-now`

## `orca git stage`

Status:

- `v1-now`

## `orca git unstage`

Status:

- `v1-now`

## `orca git discard`

Status:

- `v1-now`

## `orca git branch-compare`

Status:

- `v1-now`

## `orca gh pr`

Status:

- `v1-now`

## `orca gh issue`

Status:

- `v1-now`

## `orca gh issues`

Status:

- `v1-now`

## `orca gh checks`

Status:

- `v1-now`

## Explicitly Deferred From V1

Deferred:

- tab creation and closure
- pane split and close
- tab reordering
- tab colors
- unread/read metadata commands in the core surface
- terminal wait modes other than `exit`

Rationale:

- either too UI-shaped
- or not grounded in current backend ownership

## Recommended Implementation Order

1. repo/worktree/file/search/git/gh `v1-now` commands
2. shared runtime/orchestration layer with `runtimeId`
3. `status`
4. terminal handle issuance and validation
5. `terminal list/show/read/send`
6. `worktree ps`
7. `terminal wait --for exit`

## Recommendation

This spec is the contract to review next.

It is intentionally strict and narrower than the broader design docs:

- selectors are formal
- handles are ephemeral by default
- JSON is contractual
- terminal features are split between `v1-now` and `v1-runtime-layer`

That should let us optimize for both agent clarity and implementation honesty.
