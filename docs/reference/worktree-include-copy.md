# `.worktreeinclude` — harness-level copy of gitignored local setup files

## Problem

Setup scripts are the only mechanism for materializing gitignored local files
(`.env.local`, `.claude/settings.local.json`, `.entire/settings.local.json`, …)
into a new worktree, and they have structural gaps:

- A repo may have no setup script configured at all.
- Setup can be skipped per-creation (`setupDecision: 'skip'`) or by repo policy.
- Setup can fail partway through.
- With `setupAgentStartupPolicy: 'start-immediately'`, an agent can start
  before the script has copied local files.

Real incident: a worktree was created for a repo before its setup script
existed, so `.entire/settings.local.json` (which disables Entire) was never
copied in. Entire ran enabled in the worktree and its hooks wedged
`git commit` for 10+ minutes.

## Contract (mirrors Codex)

A repo-root `.worktreeinclude` file lists exact relative paths of gitignored
local setup files, one per line; `#` starts a comment:

```
# local setup files
.claude/settings.local.json
.entire/settings.local.json
apps/nugget/.env.local
```

During worktree creation the harness itself copies each listed file from the
project's main checkout into the new worktree — after `git worktree add`,
before the setup script is prepared and before any agent starts. It does not
depend on a setup script being configured, launched, or succeeding.

Rules:

- Exact relative paths only — no globs, no directories. Malformed lines
  (absolute paths, `..` traversal, `*?[]`) are warned about and skipped.
- Only files that are gitignored in the source repo are copied. Tracked,
  missing, or untracked-but-not-ignored entries are skipped and recorded.
- Symlinks are refused, not followed: an entry whose source is a symlink, or
  whose source/destination path crosses a symlinked directory, is skipped as
  `not-a-file`. This stops a repo-committed symlink (e.g. `foo -> ~/.ssh`) from
  exfiltrating host files into the worktree the agent then runs in. (Remote
  hosts reject a symlinked source leaf via `lstat`; destination-parent
  containment on the remote path is a follow-up — see below.)
- An existing destination file is never overwritten.
- Parent directories are created; file modes are preserved.
- Absent or empty `.worktreeinclude` is a no-op. No failure in this step can
  abort worktree creation — everything degrades to logs.

## Implementation

- `src/main/ipc/worktree-include-copy.ts` — parsing, validation, and the copy
  orchestration; `src/main/ipc/worktree-include-host-ops.ts` — the local and
  remote host implementations behind the shared host-ops interface.
- Wired into all three creation flows, always ahead of setup preparation:
  - desktop local: `createLocalWorktree` (`src/main/ipc/worktree-remote.ts`),
    timed as the `copy_worktree_include` phase
  - desktop/runtime SSH: `createRemoteWorktree` (same file)
  - runtime/CLI local: `OrcaRuntimeService` create flow
    (`src/main/runtime/orca-runtime.ts`)
- Remote hosts: the source checkout and the new worktree live on the same
  remote machine, so the copy runs host-side via the relay's no-clobber
  `fs.copy` — file contents (which can hold secrets) never transit to the
  local machine. Tracked/ignored checks go through the relay's allowlisted
  `git ls-files` / `check-ignore`.
- The outcome (`copied` / `skipped` with per-entry reasons) is logged with the
  `[worktree-include]` prefix and returned to callers as
  `CreateWorktreeResult.includeCopy`.
