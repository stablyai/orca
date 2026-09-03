# OCI Worktree tmux Agent Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every local OCI Git worktree recoverable after an OCI/tmux restart by having the setup hook create one deterministic four-window tmux session (`codex`, `claude`, `omp`, `bash`) and having the coordinator resume each provider exactly once from provider-native session locators persisted in a path-bound manifest.

**Architecture:** Keep raw tmux as a host recovery surface, not an Orca-managed worker. The setup hook remains the sole owner of session naming, session path, window layout, session environment, and OMP hook installation. Provider hooks record native `SessionStart` identifiers through a host-local atomic manifest writer. The coordinator observes sessions created by the current setup invocation, validates the exact provider command and approval flags, and sends at most one provider resume command to each newly created pane; existing sessions, missing locators, failed preflights, and failed resumes remain shell-only with `RECOVERY_REQUIRED` and never fall back to a fresh or recent-session launch.

**Tech Stack:** Bash, tmux, jq, `realpath`, `sha256sum`, `flock`, TypeScript-generated POSIX hook scripts, Bun OMP hooks, the existing `/srv/script/orca-coordinator.sh` JSON CLI integration, Vitest, ShellCheck.

**Review basis:** The approved design is recorded in `docs/superpowers/specs/2026-09-03-oci-worktree-tmux-agent-recovery-design.md`. The final standalone web GPT contract review returned `APPROVE` / `NONE` from the revised summary; it was a contract review, not independent repository inspection. The implementation must therefore retain the local source facts below, especially Codex's redirected `CODEX_HOME`, OMP's native `sessionManager` APIs, and the existing setup-hook source-of-truth boundary.

---

## Scope and non-goals

- Modify the OCI host recovery scripts and their focused shell tests:
  - `/srv/script/orca-tmux-hook.sh`
  - `/srv/script/orca-tmux-hook.test.sh`
  - `/srv/script/orca-worktree-session-manifest.sh` (new)
  - `/srv/script/orca-worktree-session-manifest.test.sh` (new)
  - `/srv/script/orca-omp-worktree-session-hook.ts` (new)
  - `/srv/script/orca-omp-worktree-session-hook.test.sh` (new)
  - `/srv/script/orca-coordinator.sh`
  - `/srv/script/orca-coordinator.test.sh`
  - `/srv/script/projects/orca.md`
- Modify Orca's POSIX provider hook generators so raw tmux provider processes use the same native event adapters as Orca-managed providers:
  - `src/main/agent-hooks/oci-worktree-session-event.ts` (new shared generator)
  - `src/main/agent-hooks/oci-worktree-session-event.test.ts` (new)
  - `src/main/claude/hook-service.ts`
  - `src/main/claude/hook-service.test.ts`
  - `src/main/codex/codex-hook-script.ts`
  - `src/main/codex/hook-service-managed-install.test.ts`
- Keep the approved design specification unchanged unless implementation evidence exposes a real contract error; update the plan or spec before coding if that happens.
- Do not change Dashboard, AgentMap, managed-worker registration, terminal ownership, IPC, RPC, stream frames, or remote wire contracts. A raw tmux pane is never an Orca-managed worker.
- Do not auto-migrate an existing one-window or otherwise legacy session. Existing sessions are left untouched; the documented operator action is archive and recreate once.
- Do not infer provider locators from terminal text, pane order, mtimes, recent-session pickers, `--last`, `--continue`, or a fresh provider launch.
- Do not make hpv2 or Windows part of this recovery path. The coordinator must continue filtering non-local paths and must not destroy OCI sessions when hpv2 is unavailable.
- Do not run project pnpm tests, typechecks, lint, builds, packaging, or Electron on OCI. Run those through the hpv2 coordinator after the OCI commit is pushed and the exact SHA is synchronized.
- Do not touch `/srv/workspace/scouter` or the unrelated untracked files `ISSUE-archive-hook-cli-remote.md` and `ORPHAN-PTY-FINDINGS.md`.

## Host and ownership contract

- OCI source/control plane: `/srv/workspace/orca`, selector `cd90eb16-48b5-4735-aeb5-74a0a15e511c`, current contribution session `orca-wt-main`.
- hpv2 validation plane: selector `bdf5ef9b-3d40-45b1-9b84-3ce9e3630cd4`, canonical path `C:/Users/ljhlj/workspace/orca`, environment `hp_v2`.
- `/srv/script` is the coordinator host's operational directory, not a Git worktree. Before changing any `/srv/script` file, create a dated backup and `SHA256SUMS.before`; after verification write `SHA256SUMS.after`. Never run `git add` or `git commit` in `/srv/script`.
- The Orca UI's local project hook setting remains the live setup/archive source of truth. `/srv/script/orca-tmux-hook.sh` is the focused test/deployment copy. After changing the copy, update the existing live OCI setup hook body with the identical layout, environment, OMP installation, and partial-cleanup logic through the normal Orca UI operation; the CLI cannot edit this setting. Do not claim deployment until the live hook has been manually updated and probed.
- The current coordinator unit and live sessions are not to be restarted, killed, archived, or recreated during implementation. Use throwaway tmux sockets for tests. A real OCI reboot/recovery trial is a separate coordinator/host-owner operation after all static and focused checks pass.
- The coordinator process itself continues to own only the `coordinator` keeper session. Its existing single-pane startup behavior and `ORCA_COORDINATOR_AGENT_RESUME_CMD`/`ORCA_COORDINATOR_AGENT_START_CMD` test overrides remain isolated from per-worktree provider recovery.

## File structure and responsibilities

### Create

- `/srv/script/orca-worktree-session-manifest.sh` — host-local `record` command. Validates canonical worktree/root identity and exact manifest path, extracts native Claude/Codex JSON identifiers or accepts OMP's native identifier arguments, serializes concurrent updates with `flock`, and publishes mode-0600 JSON through temp-file plus atomic rename.
- `/srv/script/orca-worktree-session-manifest.test.sh` — isolated manifest writer, path-binding, permissions, concurrency, malformed-input, and moved-worktree tests.
- `/srv/script/orca-omp-worktree-session-hook.ts` — OMP auto-discovered `session_start` hook. Reads `ctx.sessionManager.getSessionId()` and optional `ctx.sessionManager.getSessionFile()`, then invokes the manifest writer with the tmux session's exact environment context.
- `/srv/script/orca-omp-worktree-session-hook.test.sh` — Bun harness that registers the hook with a fake HookAPI and verifies the native OMP callback arguments sent to a fake writer.
- `src/main/agent-hooks/oci-worktree-session-event.ts` — shared POSIX shell-line generator for guarded raw-tmux native `SessionStart` recording; no endpoint, pane key, or UI relay dependency.
- `src/main/agent-hooks/oci-worktree-session-event.test.ts` — exact generated-line contract and platform guard tests.

### Modify

- `/srv/script/orca-tmux-hook.sh` — create and validate the four-window layout, install the OMP hook, set session-scoped raw recovery environment, and remove partially created sessions on layout failure.
- `/srv/script/orca-tmux-hook.test.sh` — assert exact ordered windows, session/pane paths, env values, idempotency, mismatch fail-closed behavior, and partial-layout cleanup.
- `/srv/script/orca-coordinator.sh` — preserve current coordinator/hpv2 behavior while replacing worktree's old single Codex `--last` bootstrap with observed-new-session provider recovery and exact preflighted commands.
- `/srv/script/orca-coordinator.test.sh` — add fake provider binaries, manifests, flag preflight, one-shot, failure, and `RESUME_AGENTS=0` cases without weakening current liveness checks.
- `/srv/script/projects/orca.md` — document the OCI recovery contract, operational backup/hashes, manifest location, provider flags, `RECOVERY_REQUIRED`, and archive/recreate procedure.
- `src/main/claude/hook-service.ts` — add the shared raw-tmux recorder to the generated POSIX script while preserving the neutral JSON output, Devin guard, endpoint refresh, and normal Orca spool/post path.
- `src/main/claude/hook-service.test.ts` — verify the installed POSIX managed script contains and executes the raw native SessionStart branch without changing existing user settings behavior.
- `src/main/codex/codex-hook-script.ts` — add the same shared raw-tmux recorder to the generated POSIX script while preserving endpoint refresh, WSL curl fallback, and normal spool/post behavior.
- `src/main/codex/hook-service-managed-install.test.ts` — verify the managed script installed under the redirected runtime `CODEX_HOME` records raw native SessionStart payloads and still posts ordinary events.

### Do not modify

- `src/shared/agent-session-resume.ts` and `src/shared/tui-agent-resume-startup.ts`; their already verified provider argv mapping is the command contract this feature consumes.
- `src/main/agent-hooks/managed-agent-hook-registry.ts`; raw OMP installation is host-local auto-discovery, not a managed Orca worker hook.
- `src/renderer/src/**`; there is no UI change.
- `/srv/script/AGENTS.md` and `/home/ai/.codex/AGENTS.md`; they remain host/project policy.

## Operational backup before `/srv/script` edits

Run this once immediately before the first operational edit, on OCI:

```bash
stamp="$(date +%Y%m%dT%H%M%S)"
backup="/srv/script/.backup/$stamp"
mkdir -p "$backup"
cp /srv/script/orca-tmux-hook.sh \
  /srv/script/orca-tmux-hook.test.sh \
  /srv/script/orca-coordinator.sh \
  /srv/script/orca-coordinator.test.sh \
  /srv/script/projects/orca.md \
  "$backup/"
sha256sum \
  /srv/script/orca-tmux-hook.sh \
  /srv/script/orca-tmux-hook.test.sh \
  /srv/script/orca-coordinator.sh \
  /srv/script/orca-coordinator.test.sh \
  /srv/script/projects/orca.md \
  >"$backup/SHA256SUMS.before"
printf '%s\n' "$backup"
```

Record the new files separately after creation and write the matching `SHA256SUMS.after` only after focused checks pass:

```bash
sha256sum \
  /srv/script/orca-tmux-hook.sh \
  /srv/script/orca-tmux-hook.test.sh \
  /srv/script/orca-worktree-session-manifest.sh \
  /srv/script/orca-worktree-session-manifest.test.sh \
  /srv/script/orca-omp-worktree-session-hook.ts \
  /srv/script/orca-omp-worktree-session-hook.test.sh \
  /srv/script/orca-coordinator.sh \
  /srv/script/orca-coordinator.test.sh \
  /srv/script/projects/orca.md \
  >"$backup/SHA256SUMS.after"
```

## Contract constants

Use these exact values in production; only the explicitly named test environment overrides may vary them:

```text
session name       repo-root-basename-wt-worktree-basename
root worktree slug main
window 0           codex
window 1           claude
window 2           omp
window 3           bash
manifest root      ${XDG_STATE_HOME:-$HOME/.local/state}/orca/oci-worktree-sessions
manifest file      sha256(realpath(worktree)).json
manifest mode      0600; parent directories 0700
writer             /srv/script/orca-worktree-session-manifest.sh
OMP hook source    /srv/script/orca-omp-worktree-session-hook.ts
```

The setup hook passes these per-session variables, exactly as named:

```text
ORCA_OCI_SESSION_MANIFEST=canonical manifest path
ORCA_OCI_WORKTREE_PATH=canonical worktree path
ORCA_OCI_REPO_ROOT=canonical repository root
ORCA_OCI_PROVIDER_EVENT_WRITER=/srv/script/orca-worktree-session-manifest.sh
```

The setup hook also sets `CODEX_HOME` and `ORCA_CODEX_HOME` to the Orca-managed runtime home `${XDG_CONFIG_HOME:-$HOME/.config}/orca/codex-runtime-home/home` unless the coordinator's test-only `ORCA_COORDINATOR_CODEX_HOME` override is present. This closes the existing Codex split where Orca installs hooks in its redirected runtime home while a raw shell would otherwise invoke the user's `~/.codex`.

The persisted schema is exactly:

```json
{
  "version": 1,
  "worktreePath": "/canonical/worktree",
  "repoRoot": "/canonical/repository",
  "providers": {
    "codex": { "key": "session_id", "id": "codex-session-id" },
    "claude": { "key": "session_id", "id": "claude-session-id" },
    "omp": { "key": "session_id", "id": "omp-session-id", "resumeFilePath": "/canonical/omp-session.jsonl" }
  }
}
```

Provider resume commands are fixed and must not be generalized through an environment override:

```bash
codex resume "$CODEX_SESSION_ID" --dangerously-bypass-approvals-and-sandbox
claude --resume "$CLAUDE_SESSION_ID" --dangerously-skip-permissions
omp --resume "$OMP_RESUME_TARGET" --auto-approve --approval-mode=yolo
```

The coordinator may override provider binary paths, writer, OMP source, and Codex home only for isolated tests. Tests set `XDG_STATE_HOME` to a temporary directory instead of overriding the manifest-root formula. The coordinator must not override provider argv or approval flags in production.

## Implementation tasks

### Task 1: Add the native raw-tmux event adapter generator

**Files:**

- Create `src/main/agent-hooks/oci-worktree-session-event.ts`.
- Create `src/main/agent-hooks/oci-worktree-session-event.test.ts`.
- Modify `src/main/claude/hook-service.ts`.
- Modify `src/main/codex/codex-hook-script.ts`.

- [ ] **Step 1: Define the shared generator contract**

Export one concrete function:

```ts
export type OciWorktreeProvider = 'claude' | 'codex'

export function buildPosixOciWorktreeSessionRecordLines(
  provider: OciWorktreeProvider
): string[]
```

The returned shell lines must:

1. Require all four `ORCA_OCI_*` variables before doing anything.
2. Pipe the already captured native `payload` variable to the configured writer's `record` command.
3. Pass `--manifest`, `--provider`, `--worktree`, `--repo-root`, and `--payload-stdin` as separate shell arguments.
4. Redirect writer output and errors away from the provider hook protocol and fail open for the provider process (`|| :`).
5. Never inspect terminal output, `PWD`, mtimes, endpoint variables, pane keys, or UI relay state.

Generated line shape:

```sh
if [ -n "${ORCA_OCI_SESSION_MANIFEST:-}" ] && \
   [ -n "${ORCA_OCI_WORKTREE_PATH:-}" ] && \
   [ -n "${ORCA_OCI_REPO_ROOT:-}" ] && \
   [ -x "${ORCA_OCI_PROVIDER_EVENT_WRITER:-}" ]; then
  printf '%s' "$payload" | "$ORCA_OCI_PROVIDER_EVENT_WRITER" record \
    --manifest "$ORCA_OCI_SESSION_MANIFEST" \
    --provider claude \
    --worktree "$ORCA_OCI_WORKTREE_PATH" \
    --repo-root "$ORCA_OCI_REPO_ROOT" \
    --payload-stdin >/dev/null 2>&1 || :
fi
```

The Claude generator emits `--provider claude`; the Codex generator emits the same line with the compile-time literal `--provider codex`. No generated script accepts a provider value from payload text.

- [ ] **Step 2: Add the adapter before normal spool/post code**

In Claude's POSIX `getManagedScript()` return array, place the generated lines immediately after `buildPosixHookPayloadCapture()` and before `buildPosixHookSpoolLines('claude')`. Preserve the existing initial `printf "{}\\n"`, Devin skip, `CLAUDE_JOB_DIR` exit, endpoint refresh, and neutral exit paths. Do not add this branch to the Windows `.cmd` output; this recovery surface is Linux POSIX tmux.

In Codex's POSIX `getManagedScript()` return array, place the generated lines immediately after `buildPosixHookPayloadCapture()` and before `buildPosixHookSpoolLines('codex')`. Preserve the existing endpoint loader and WSL curl fallback. Do not make the raw branch depend on a successfully loaded `ORCA_AGENT_HOOK_ENDPOINT`.

- [ ] **Step 3: Test generated contract and normal-path isolation**

Add tests that assert:

```ts
expect(buildPosixOciWorktreeSessionRecordLines('claude').join('\n')).toContain(
  '--provider claude'
)
expect(buildPosixOciWorktreeSessionRecordLines('codex').join('\n')).toContain(
  '--provider codex'
)
expect(lines.join('\n')).toContain('ORCA_OCI_SESSION_MANIFEST')
expect(lines.join('\n')).not.toContain('ORCA_AGENT_HOOK_ENDPOINT')
expect(lines.join('\n')).not.toContain('ORCA_PANE_KEY')
```

Use the existing provider install tests to read the actual installed scripts and run each script on a temporary POSIX host with a fake executable writer. Send a native `SessionStart` JSON payload containing a provider `session_id`; assert the writer receives the exact payload on stdin and the provider script exits zero. Send an ordinary event and assert the raw writer is not invoked. Leave the existing ordinary Orca endpoint/post assertions intact.

- [ ] **Step 4: Run the focused source tests through hpv2**

Do not run pnpm on OCI. After the source edits are made, use the hpv2 routing procedure in Task 8 for:

```bash
pnpm test src/main/agent-hooks/oci-worktree-session-event.test.ts \
  src/main/claude/hook-service.test.ts \
  src/main/codex/hook-service-managed-install.test.ts
```

### Task 2: Implement the atomic, path-bound manifest writer

**Files:**

- Create `/srv/script/orca-worktree-session-manifest.sh`.
- Create `/srv/script/orca-worktree-session-manifest.test.sh`.

- [ ] **Step 1: Implement strict argument parsing and canonical identity checks**

Use `set -euo pipefail`, `umask 077`, and a single `record` subcommand. Require these arguments:

```text
--manifest PATH
--provider codex|claude|omp
--worktree PATH
--repo-root PATH
```

Require exactly one locator source:

```text
--payload-stdin                  # only codex/claude
--session-id ID                  # only omp
--resume-file PATH               # optional omp field, only with --session-id
```

Reject unknown flags, missing values, duplicate flags, empty IDs, control characters, and provider/locator combinations that do not match the table above. Do not echo the native payload or locator into diagnostics.

Resolve `worktree` and `repo-root` with `realpath -e`. Verify:

```bash
git -C "$worktree" rev-parse --show-toplevel
```

resolves to exactly `repo-root`. Compute the expected manifest path from the canonical worktree:

```bash
state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
expected="$(realpath -m "$state_home/orca/oci-worktree-sessions")/$(
  printf '%s' "$worktree" | sha256sum | cut -d' ' -f1
).json"
```

Reject if the supplied `--manifest` is not exactly `expected`. This prevents a stale pane or a caller with another worktree's path from writing that worktree's file.

- [ ] **Step 2: Extract only native provider locators**

For Claude and Codex, read all stdin once and use `jq -er` to require the native event and identifier:

```bash
event_name="$(printf '%s' "$payload" | jq -er '.hook_event_name // empty')"
[ "$event_name" = SessionStart ] || exit 0
session_id="$(printf '%s' "$payload" | jq -er '.session_id | strings | select(length > 0)')"
```

Do not accept an event with a missing/empty `session_id`; return non-zero without changing the manifest. Do not parse a transcript filename, terminal output, or current directory from the payload.

For OMP, accept the exact `--session-id` from `ctx.sessionManager.getSessionId()` and preserve a non-empty `--resume-file` from `ctx.sessionManager.getSessionFile()` as `resumeFilePath`. Do not derive either value from a path basename, mtime, or recent picker.

- [ ] **Step 3: Publish one provider field atomically and serialize writers**

Create the parent directory with mode 0700, open a stable `manifest.lock` file with mode 0600, and acquire an exclusive `flock` before reading or writing. A stale lock file is harmless because `flock` is released by process exit.

If the manifest exists, reject it unless it is valid JSON with:

```jq
.version == 1
and .worktreePath == $worktree
and .repoRoot == $repo_root
and (.providers | type == "object")
```

For a missing manifest, start with the exact version/path/root/provider object. Replace only the selected provider field. Preserve the other provider fields and preserve all existing `omp.resumeFilePath` data when the incoming OMP event has no resume file.

Write JSON to `mktemp "$manifest.tmp.XXXXXX"`, `chmod 600` the temp file, then `mv -f` it over the manifest. Remove the temp file on every failure. Never write directly to the final path and never leave a mode-0644 intermediate file.

- [ ] **Step 4: Test writer behavior and security boundaries**

The shell test must create a temporary Git root and worktree and verify:

```text
Claude SessionStart JSON -> providers.claude.key=session_id and exact id
Codex SessionStart JSON  -> providers.codex.key=session_id and exact id
OMP session-id + file    -> providers.omp.id and resumeFilePath
second provider record   -> previous provider fields preserved
concurrent codex/claude records -> both fields survive
manifest mode            -> 600; parent directory -> 700
wrong manifest hash      -> non-zero and no write
wrong repo root          -> non-zero and no write
moved/missing worktree   -> non-zero and no write
malformed existing JSON  -> non-zero and file unchanged
ordinary provider event  -> zero and no provider field
missing native id        -> non-zero and no provider field
```

Also assert the writer has no code path reading `tmux capture-pane`, `pane_current_path`, file mtimes, or recent session listings. Run the actual script; do not make a source-text-only test the sole proof.

### Task 3: Add the native OMP `session_start` adapter and installation

**Files:**

- Create `/srv/script/orca-omp-worktree-session-hook.ts`.
- Create `/srv/script/orca-omp-worktree-session-hook.test.sh`.
- Modify `/srv/script/orca-tmux-hook.sh` and its test.

- [ ] **Step 1: Implement the OMP hook against the installed API**

Export a default function that subscribes only to `session_start`:

```ts
import { spawnSync } from 'node:child_process'

type OmpHookContext = {
  cwd: string
  sessionManager: {
    getSessionId(): string
    getSessionFile(): string | null
  }
}

export default function registerOciWorktreeHook(pi: {
  on(
    event: 'session_start',
    handler: (event: unknown, ctx: OmpHookContext) => unknown
  ): void
}): void {
  pi.on('session_start', async (_event, ctx) => {
    const manifest = process.env.ORCA_OCI_SESSION_MANIFEST?.trim()
    const worktree = process.env.ORCA_OCI_WORKTREE_PATH?.trim()
    const repoRoot = process.env.ORCA_OCI_REPO_ROOT?.trim()
    const writer = process.env.ORCA_OCI_PROVIDER_EVENT_WRITER?.trim()
    const sessionId = ctx.sessionManager.getSessionId().trim()
    const resumeFilePath = ctx.sessionManager.getSessionFile()?.trim() ?? ''
    if (!manifest || !worktree || !repoRoot || !writer || !sessionId) return

    const args = [
      'record',
      '--manifest',
      manifest,
      '--provider',
      'omp',
      '--worktree',
      worktree,
      '--repo-root',
      repoRoot,
      '--session-id',
      sessionId
    ]
    if (resumeFilePath) args.push('--resume-file', resumeFilePath)
    try {
      spawnSync(writer, args, { stdio: 'ignore' })
    } catch {
      // A missing writer must not make the OMP session unusable.
    }
  })
}
```

Use the actual `HookContext` shape verified in the installed OMP package: `cwd`, readonly `sessionManager`, `getSessionId()`, and `getSessionFile()`. Catch spawn errors so the OMP session itself remains usable; the coordinator's missing manifest/provider field is the recovery signal. Do not subscribe to session switch/branch events.

The runtime script must not hardcode a different writer path; the setup hook's environment is authoritative. The test may set `ORCA_OCI_PROVIDER_EVENT_WRITER` to a temporary fake executable.

- [ ] **Step 2: Install the hook idempotently from the setup hook**

Before creating a new tmux session, the setup hook must:

```bash
omp_hook_dir="$HOME/.omp/agent/hooks"
mkdir -p "$omp_hook_dir"
tmp_hook="$(mktemp "$omp_hook_dir/orca-oci-worktree-session-hook.ts.XXXXXX")"
cp "$omp_hook_source" "$tmp_hook"
chmod 600 "$tmp_hook"
mv -f "$tmp_hook" "$omp_hook_dir/orca-oci-worktree-session-hook.ts"
```

Use `/srv/script/orca-omp-worktree-session-hook.ts` by default and `ORCA_OCI_OMP_HOOK_SOURCE` only as an isolated test override. If the source is absent or cannot be copied, fail before creating a session. Do not overwrite any other user hook.

The live hook body must carry this same installation logic. Re-running setup for an existing session must return after session path validation without changing the OMP hook or any session environment.

- [ ] **Step 3: Test the OMP adapter through a real callback**

The shell test must generate a Bun harness that imports the new `.ts` file, captures the `session_start` handler, supplies:

```text
getSessionId()  -> omp-native-id
getSessionFile() -> /tmp/omp-native-session.jsonl
cwd -> /srv/worktree
```

Set the four `ORCA_OCI_*` environment variables and invoke the handler. The fake writer must log argv and assert:

```text
record --manifest /tmp/oci-manifest.json --provider omp --worktree /srv/worktree
      --repo-root /srv/repository --session-id omp-native-id
      --resume-file /tmp/omp-native-session.jsonl
```

Repeat with `getSessionFile() -> null` and assert no `--resume-file` argument. Repeat with missing context and assert no writer invocation.

### Task 4: Make the setup hook own the deterministic four-window layout

**Files:**

- Modify `/srv/script/orca-tmux-hook.sh`.
- Modify `/srv/script/orca-tmux-hook.test.sh`.
- Update the live OCI setup hook setting with the same body after the copy passes.

- [ ] **Step 1: Preserve current identity and archive behavior**

Keep the existing `setup|archive` interface, `ORCA_TMUX_SOCKET`, `ORCA_TMUX_UNIT`, and `ORCA_TMUX_KEEPER` test overrides, realpath-based root/worktree validation, slugification, root-to-`main` naming, exact session path check, keeper/server check, and exact archive target. Do not replace `session_path` validation with `pane_current_path`; a pane may `cd` away while session ownership remains correct.

Keep these invariants:

```bash
root="$(realpath -e "${ORCA_ROOT_PATH:?ORCA_ROOT_PATH missing}")"
worktree="$(realpath -e "${ORCA_WORKTREE_PATH:?ORCA_WORKTREE_PATH missing}")"
toplevel="$(git -C "$worktree" rev-parse --show-toplevel)"
[ "$(realpath -e "$toplevel")" = "$root" ]
```

A missing worktree is an error for setup and remains archive-tolerated when the directory has already been removed.

- [ ] **Step 2: Compute exact session metadata and dependencies**

Compute:

```bash
manifest_dir="$(realpath -m "${XDG_STATE_HOME:-$HOME/.local/state}/orca/oci-worktree-sessions")"
manifest="${manifest_dir}/$(printf '%s' "$worktree" | sha256sum | cut -d' ' -f1).json"
writer="${ORCA_OCI_PROVIDER_EVENT_WRITER:-/srv/script/orca-worktree-session-manifest.sh}"
omp_hook_source="${ORCA_OCI_OMP_HOOK_SOURCE:-/srv/script/orca-omp-worktree-session-hook.ts}"
codex_home="${ORCA_COORDINATOR_CODEX_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/orca/codex-runtime-home/home}"
```

Require `tmux`, `git`, `realpath`, `sha256sum`, `jq`, and the writer. Require the OMP source for a new session. These checks are setup dependencies, not a reason to modify an existing session.

- [ ] **Step 3: Leave existing sessions untouched**

After exact-name `has-session`, compare `#{session_path}` to the canonical worktree. If it matches, print the existing ready message and exit successfully before installing hooks, setting env, adding windows, or touching any file. If it differs, fail closed. Do not inspect or mutate the existing window count; this is what makes old one-window sessions an explicit archive/recreate operation.

- [ ] **Step 4: Create the session with four ordered windows and session-scoped env**

For a new session, create window 0 with the exact name and environment, then create windows 1–3 with the exact names and `-c "$worktree"`:

```bash
tmux -L "$socket" new-session -d -s "$session" -n codex -c "$worktree" \
  -e "ORCA_OCI_SESSION_MANIFEST=$manifest" \
  -e "ORCA_OCI_WORKTREE_PATH=$worktree" \
  -e "ORCA_OCI_REPO_ROOT=$root" \
  -e "ORCA_OCI_PROVIDER_EVENT_WRITER=$writer" \
  -e "CODEX_HOME=$codex_home" \
  -e "ORCA_CODEX_HOME=$codex_home"
tmux -L "$socket" new-window -d -t "$session:1" -n claude -c "$worktree"
tmux -L "$socket" new-window -d -t "$session:2" -n omp -c "$worktree"
tmux -L "$socket" new-window -d -t "$session:3" -n bash -c "$worktree"
tmux -L "$socket" select-window -t "$session:0"
```

Use the test socket and shell's arguments exactly as existing code does; do not start a provider from the hook. Validate after creation:

```text
#{session_path} == canonical worktree
0:codex
1:claude
2:omp
3:bash
all four #{pane_current_path} == canonical worktree
show-environment contains all four ORCA_OCI_* values and CODEX_HOME/ORCA_CODEX_HOME
```

- [ ] **Step 5: Remove partial new sessions on any layout failure**

Set a `created_session=1` flag immediately after `new-session` succeeds and install an `EXIT` trap that kills only `=$session` when `layout_ready` is still false. Clear the trap only after all windows, environment, path, and ordered-layout checks pass. Never kill the keeper or any pre-existing session. The test must force a delegated `tmux new-window` failure through a temporary PATH wrapper and assert no session remains.

- [ ] **Step 6: Test setup idempotency and non-mutation**

Extend the existing throwaway-socket test to assert:

```text
root name -> repoa-wt-main
feature name -> repoa-wt-feature
exactly four ordered windows
all four pane cwds == worktree
session_path == worktree even after a pane cd /tmp
all four ORCA_OCI_* env values exact
CODEX_HOME and ORCA_CODEX_HOME exact
second setup -> no extra window/no env rewrite/no hook rewrite
same-name wrong path -> non-zero
missing worktree -> non-zero
non-git directory -> non-zero
partial new layout -> session removed
archive -> exact session only; missing/deleted path archive is zero
```

Run the live UI setup hook manually against a disposable local worktree only after this test passes. Observe the newly created session, four windows, session path, pane paths, and env; archive that disposable session through the existing archive hook. Do not use a real project worktree for the probe.

### Task 5: Replace worktree `--last` bootstrap with one-shot provider recovery

**Files:**

- Modify `/srv/script/orca-coordinator.sh`.
- Modify `/srv/script/orca-coordinator.test.sh`.

- [ ] **Step 1: Keep coordinator startup separate and add recovery configuration**

Do not change `ensure_session()`'s coordinator keeper logic. Add these configuration values for the worktree path only:

```bash
manifest_root="${XDG_STATE_HOME:-$HOME/.local/state}/orca/oci-worktree-sessions"
provider_event_writer="${ORCA_COORDINATOR_PROVIDER_EVENT_WRITER:-/srv/script/orca-worktree-session-manifest.sh}"
omp_hook_source="${ORCA_COORDINATOR_OMP_HOOK_SOURCE:-/srv/script/orca-omp-worktree-session-hook.ts}"
codex_home="${ORCA_COORDINATOR_CODEX_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/orca/codex-runtime-home/home}"
```

Retain `ORCA_COORDINATOR_RESUME_AGENTS` as the sole switch for whether provider commands are sent to newly created sessions. It must not cause commands to be sent to existing worktree sessions.

- [ ] **Step 2: Keep observed-new-session ownership**

In `restore_worktree_sessions()` retain the current local inventory pairing and Windows-path filter. For each local worktree:

```bash
before="$(session_names)"
run_setup_hook_with_oci_context
if setup succeeds; then
  after="$(session_names)"
  created="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after"))"
  while IFS= read -r session; do
    [ -n "$session" ] || continue
    recover_new_worktree_session "$session" "$root" "$path"
  done <<<"$created"
fi
```

Use the observed `created` name as the only target. Do not calculate a session name in the coordinator, do not use a prefix target, and do not recover any session absent from the before/after delta. If the hook fails, log it and continue; do not remove sessions or fail the coordinator keeper.

- [ ] **Step 3: Add exact manifest and layout reads**

For a newly created session, read `ORCA_OCI_SESSION_MANIFEST`, `ORCA_OCI_WORKTREE_PATH`, and `ORCA_OCI_REPO_ROOT` from the session environment and compare the latter two values to the canonical `$path` and `$root` arguments from the inventory loop. Reject the session for provider recovery if any is missing, if the manifest path is not the exact sha256 path under `manifest_root`, or if manifest `worktreePath`/`repoRoot` do not exactly match the setup context. Log `RECOVERY_REQUIRED` and leave all panes as shells when the binding fails.
Read provider fields only through `jq -er` selectors equivalent to:

```jq
.providers.codex.key == "session_id" and (.providers.codex.id | strings | length > 0)
.providers.claude.key == "session_id" and (.providers.claude.id | strings | length > 0)
.providers.omp.key == "session_id" and (.providers.omp.id | strings | length > 0)
```

For OMP, use `.resumeFilePath` when it is a non-empty string; otherwise use the exact `.id`. Missing/malformed fields are provider-local `RECOVERY_REQUIRED`, not a fresh start and not a reason to touch another provider.

- [ ] **Step 4: Add provider command/flag preflight**

Before sending a provider command, verify the binary exists and its help output contains the exact selector and approval options:

```text
codex: CODEX_HOME=$codex_home codex --help contains --dangerously-bypass-approvals-and-sandbox;
       CODEX_HOME=$codex_home codex resume --help is callable
claude: claude --help contains --resume and --dangerously-skip-permissions
omp:    omp --help contains --resume, --auto-approve, --approval-mode, and yolo
```


```text
codex: $codex_home/hooks.json exists and contains the managed SessionStart adapter
claude: the installed managed Claude hook script exists and contains the raw adapter
omp: $HOME/.omp/agent/hooks/orca-oci-worktree-session-hook.ts exists and is readable
writer: provider_event_writer is executable
```

If any check fails, print `RECOVERY_REQUIRED` in that provider's pane and log the precise preflight reason. Never silently remove a flag, substitute a different resume selector, or use a provider's recent-session option.

- [ ] **Step 5: Send one exact command per provider window**

Use fixed window names/indexes from the hook's new-session contract and shell-quote every manifest-derived locator with Bash `printf '%q'`. Send only these commands:

```bash
codex resume "$codex_id" --dangerously-bypass-approvals-and-sandbox
claude --resume "$claude_id" --dangerously-skip-permissions
omp --resume "$omp_resume_target" --auto-approve --approval-mode=yolo
```

Wrap each command so a non-zero provider exit leaves the shell alive and prints a literal sentinel:

```bash
if codex resume "$codex_id" --dangerously-bypass-approvals-and-sandbox; then :; else printf '%s\n' RECOVERY_REQUIRED; fi
```

Send no provider command and no sentinel when `ORCA_COORDINATOR_RESUME_AGENTS=0`; the four-window shell layout is still created. Do not add a second command on a later reconcile: only the current setup invocation's `created` set can enter this function.

- [ ] **Step 6: Test recovery, idempotency, and failure behavior**

Extend the coordinator shell test with temporary fake `codex`, `claude`, and `omp` binaries plus a fake writer/source. Cover:

```text
new session + complete manifest + valid help -> exactly three exact invocations
new session + ORCA_COORDINATOR_RESUME_AGENTS=0 -> zero provider invocations
second ensure with existing four-window sessions -> zero duplicate invocations
missing manifest -> shells + RECOVERY_REQUIRED; zero provider invocations
wrong manifest binding -> shells + RECOVERY_REQUIRED; zero provider invocations
missing provider field -> only that provider RECOVERY_REQUIRED
missing help flag -> provider RECOVERY_REQUIRED; no downgraded invocation
provider exits non-zero -> shell remains and RECOVERY_REQUIRED is visible
second ensure after provider failure -> no retry/invocation
pre-existing legacy one-window session -> untouched, no auto-migration
Windows inventory path -> no local session
runtime CLI failure -> coordinator keeper and existing OCI sessions survive
```

Keep all current coordinator tests for coordinator reuse, bare coordinator startup, exact worktree path, and hpv2 terminal liveness. Ensure the existing fake `ORCA_COORDINATOR_AGENT_RESUME_CMD` test remains scoped to the coordinator keeper and does not accidentally become the provider command source.

### Task 6: Document operator recovery and live-hook deployment

**Files:**

- Modify `/srv/script/projects/orca.md`.
- Update the live OCI project setup hook setting through the UI; no source file in this repository owns that setting.

- [ ] **Step 1: Add the operational contract**

Document this exact flow:

```text
1. Coordinator enumerates local OCI Git worktrees only.
2. Setup hook creates/reuses the deterministic session and, for a new session, four windows.
3. Coordinator observes before/after session names.
4. Only newly created sessions are eligible for provider resume.
5. Provider-native SessionStart hooks populate the path-bound manifest.
6. Missing/malformed/mismatched locator or unsupported flags produce RECOVERY_REQUIRED.
7. Existing sessions are never restarted or migrated.
8. Archive the exact old session and rerun setup once to migrate a legacy layout.
```

Include the manifest path/schema, exact provider commands, Codex managed-home requirement, OMP hook path, `ORCA_OCI_*` variables, `ORCA_COORDINATOR_RESUME_AGENTS=0` meaning, and the warning that `RECOVERY_REQUIRED` is not evidence that a provider has no upstream session; it means this recovery path is intentionally fail-closed.

- [ ] **Step 2: Record live-hook deployment evidence**

After the `/srv/script` copy and focused test pass, update the live hook setting and probe a disposable worktree. Record:

```text
observed new session name
session_path
0:codex, 1:claude, 2:omp, 3:bash
all pane_current_path values
ORCA_OCI_* values and CODEX_HOME
OMP hook installation path
archive result for the disposable session
```

Do not restart `orca-tmux.service`, kill the tmux server, or touch a real project session for this probe.

### Task 7: Run focused OCI verification and preserve operational evidence

**Files:** all changed files from Tasks 1–6.

- [ ] **Step 1: Run the four OCI shell suites**

Run on OCI:

```bash
bash /srv/script/orca-worktree-session-manifest.test.sh
bash /srv/script/orca-omp-worktree-session-hook.test.sh
bash /srv/script/orca-tmux-hook.test.sh
bash /srv/script/orca-coordinator.test.sh
```

These must use throwaway tmux sockets and temporary directories only. A passing test must demonstrate behavior, not only source-text matching.

- [ ] **Step 2: Run ShellCheck**

Run on OCI:

```bash
shellcheck \
  /srv/script/orca-worktree-session-manifest.sh \
  /srv/script/orca-worktree-session-manifest.test.sh \
  /srv/script/orca-omp-worktree-session-hook.test.sh \
  /srv/script/orca-tmux-hook.sh \
  /srv/script/orca-tmux-hook.test.sh \
  /srv/script/orca-coordinator.sh \
  /srv/script/orca-coordinator.test.sh
```

ShellCheck must be clean. Do not add a max-lines suppression or disable a reliability rule.

- [ ] **Step 3: Check repository source formatting and diff safety**

On OCI, run only the read-only Git check:

```bash
git diff --check
```

Run the formatter check through hpv2 with the same target-safe preflight used by Task 8:

```bash
pnpm exec oxfmt --check \
  src/main/agent-hooks/oci-worktree-session-event.ts \
  src/main/agent-hooks/oci-worktree-session-event.test.ts \
  src/main/claude/hook-service.ts \
  src/main/claude/hook-service.test.ts \
  src/main/codex/codex-hook-script.ts \
  src/main/codex/hook-service-managed-install.test.ts
```

Inspect the diff for accidental changes to UI, managed-worker, remote-wire, or unrelated user files.

- [ ] **Step 4: Write operational after-hashes**

After the tests pass, write `SHA256SUMS.after` in the backup directory from the exact command in the backup section. Report the before/after hash files and changed operational paths; do not commit `/srv/script`.

### Task 8: Validate the project source on hpv2 and commit only the Orca repository changes

**Files:** repository TypeScript files and tests from Task 1; operational files remain outside Git.

- [ ] **Step 1: Synchronize the OCI commit to hpv2**

Commit only tracked Orca repository changes after the source-focused review. Do not stage the unrelated untracked files. Push the OCI commit, then use `/srv/script/orca-coordinator.sh` to fetch/fast-forward hpv2 and verify the exact commit SHA before running any project command. If hpv2 is unavailable, stop project validation rather than running pnpm on OCI.

- [ ] **Step 2: Run focused source tests through hpv2**

After `hpv2-check`, exact worktree/terminal/shell/idle preflight, and SHA verification, run:

```bash
pnpm test src/main/agent-hooks/oci-worktree-session-event.test.ts \
  src/main/claude/hook-service.test.ts \
  src/main/codex/hook-service-managed-install.test.ts
```

The result must exercise the generated scripts and preserve existing provider hook installation behavior.

- [ ] **Step 3: Run node typecheck and changed-file quality checks through hpv2**

Run through the same target-safe coordinator flow:

```bash
pnpm exec oxfmt --check \
  src/main/agent-hooks/oci-worktree-session-event.ts \
  src/main/agent-hooks/oci-worktree-session-event.test.ts \
  src/main/claude/hook-service.ts \
  src/main/claude/hook-service.test.ts \
  src/main/codex/codex-hook-script.ts \
  src/main/codex/hook-service-managed-install.test.ts
pnpm tc:node
pnpm run check:code-quality:changed
```

Use the repository's required changed-file quality command; do not substitute a local lint run on OCI. If the typecheck or quality command exposes an implementation mismatch, fix the source on OCI, commit/push again, re-sync hpv2, and rerun the exact command.

- [ ] **Step 4: Run final source and operational verification**

Re-run the four OCI shell suites and `git diff --check` after any final source correction. Confirm the repository commit SHA and changed paths. Confirm the `/srv/script` after-hash file. Only then report the feature as implemented; a passing source test does not imply that the live UI hook setting was deployed or that a real reboot trial occurred.

## Acceptance checklist

- [ ] A new local OCI worktree setup creates exactly four ordered windows named `codex`, `claude`, `omp`, `bash`, all with the canonical worktree pane CWD and exact session path.
- [ ] The setup hook is idempotent for an existing exact-path session and fail-closed for a name/path mismatch; it does not auto-migrate old layouts.
- [ ] A partial new layout is removed without touching any pre-existing session or the coordinator keeper.
- [ ] Session environment contains the four exact `ORCA_OCI_*` variables and routes raw Codex to the same redirected `CODEX_HOME` where Orca installs its managed hook.
- [ ] Claude and Codex record native `SessionStart.session_id` through the shared generated POSIX adapter; OMP records `getSessionId()` and optional `getSessionFile()` through the auto-discovered hook.
- [ ] The manifest is keyed by canonical worktree path, validates canonical root/worktree identity, is mode 0600 under mode-0700 directories, serializes concurrent writers, and publishes atomically.
- [ ] The coordinator sends fixed provider resume commands with exact dangerous approval flags only to sessions observed as newly created in the current invocation.
- [ ] Missing/malformed/mismatched locators, missing hook dependencies, unsupported help flags, and failed provider launches leave shells plus `RECOVERY_REQUIRED`; no fallback starts.
- [ ] A second coordinator invocation sends no duplicate provider command to an existing session, including after a provider failure.
- [ ] `ORCA_COORDINATOR_RESUME_AGENTS=0` suppresses provider sends without suppressing the four-window layout.
- [ ] Windows/hpv2 inventory entries remain excluded and hpv2/runtime failures do not destroy OCI sessions.
- [ ] Raw tmux remains outside Orca's managed worker/UI contract.
- [ ] Focused shell tests, ShellCheck, hpv2 provider-hook tests, node typecheck, changed-file quality, exact SHA sync, and operational before/after hashes are recorded.
