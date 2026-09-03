# OCI Worktree tmux Provider Recovery

## Problem

OCI worktree sessions are created by the Orca setup hook and are independent of
the hp_v2 host. A full OCI reboot destroys the tmux server, its worktree
sessions, and the provider processes inside them. The existing recovery path can
recreate missing worktree sessions and has a Codex-only resume bootstrap, but it
does not define a stable four-window layout or provider-specific recovery for
Claude and OMP.

A raw provider process inside an OCI tmux window is also not an Orca managed
worker. Creating a process with `tmux send-keys` does not create a managed
terminal identity, parent lineage, or AgentMap orchestration edge.

## Goal

For every local OCI Git worktree, maintain a deterministic detached tmux session
with four windows:

1. `codex`
2. `claude`
3. `omp`
4. `bash`

When OCI recovery creates a new session, load each provider's exact saved
session locator from the worktree's host-local provider-session manifest and
resume windows 1–3 with provider-specific permission-bypass flags. Do not use
provider-wide "most recent" selection for recovery. Do not create a fresh
provider session when the manifest locator is absent or resume fails. Keep OCI
session recovery independent from hp_v2 availability and keep UI-visible
managed workers outside these tmux sessions.

## Non-goals

- No nested Orca managed worker inside an existing tmux window.
- No conversion of raw tmux processes into synthetic managed identities.
- No automatic Claude/OMP task dispatch after resume.
- No shared cross-provider writer-lock implementation in this first version;
  manual operation is single-provider-at-a-time.
- No hp_v2 worker tmux sessions. hp_v2 remains a pinned remote shell terminal.
- No restoration of reboot-time child processes, running commands, tests, or
  PTY scrollback.
- No change to Dashboard/AgentMap data contracts or UI rendering.
- No automatic fresh provider startup after a failed or missing resume session.

## Chosen approach

The setup hook owns normal worktree session creation. Existing archive-hook
cleanup behavior is outside this design and is not changed here. The OCI
systemd-owned tmux server owns server persistence. The coordinator owns only
boot-time reconciliation of missing OCI worktree sessions and remote hp_v2
routing; it does not continuously supervise healthy OCI sessions.
The setup hook is the single owner of the four-window layout. The live Orca
inline hook remains authoritative; `/srv/script/orca-tmux-hook.sh` must be kept
compatible with its session-name and layout behavior for local recovery tests.
The coordinator never independently creates or orders provider windows; its
restore path calls the setup hook and only starts providers in a session that
the hook created during that invocation.
Raw tmux provider events do not use the Orca provider-session relay as their
manifest source. On newly created sessions, the setup hook sets these
session-scoped tmux environment values before any provider is started:

```text
ORCA_OCI_SESSION_MANIFEST=<manifest path>
ORCA_OCI_WORKTREE_PATH=<canonical worktree path>
ORCA_OCI_REPO_ROOT=<canonical repository root>
ORCA_OCI_PROVIDER_EVENT_WRITER=/srv/script/orca-worktree-session-manifest.sh
```

The writer path is host-local and may be overridden only by focused tests.


The provider-native SessionStart adapters then have one explicit path:

- Claude and Codex use the generated managed hook scripts in
  `src/main/claude/hook-service.ts#getManagedScript` and
  `src/main/codex/codex-hook-script.ts#getManagedScript`. When
  `ORCA_OCI_SESSION_MANIFEST` and `ORCA_OCI_PROVIDER_EVENT_WRITER` are set,
  their guarded `SessionStart` branch sends the native JSON hook payload to:

  ```text
  "$ORCA_OCI_PROVIDER_EVENT_WRITER" record \
    --manifest "$ORCA_OCI_SESSION_MANIFEST" \
    --provider <provider> \
    --worktree "$ORCA_OCI_WORKTREE_PATH" \
    --repo-root "$ORCA_OCI_REPO_ROOT" \
    --payload-stdin
  ```

  The adapter extracts only the provider's native `session_id`; it never
  parses terminal output. The normal Orca status-hook path remains separate.
- OMP loads `/srv/script/orca-omp-worktree-session-hook.ts`, installed as the
  host-local auto-discovered hook extension under `~/.omp/agent/hooks/`. Its
  `session_start` handler reads `ctx.sessionManager.getSessionId()` and
  `ctx.sessionManager.getSessionFile()`, then invokes the same writer with the
  exact ID and optional resume file path. It is a provider hook event, never
  terminal-output parsing.

The writer realpaths and validates `ORCA_OCI_WORKTREE_PATH`, verifies that
`git -C` reports the same `ORCA_OCI_REPO_ROOT`, rejects a mismatched manifest
argument, and atomically updates only that provider's field. Missing provider
hook configuration means no locator is published; recovery remains
`RECOVERY_REQUIRED`. Managed Orca panes do not set `ORCA_OCI_*` and therefore
do not write this manifest.

The setup implementation must treat provider-hook adapter installation and the
writer's executable path as a preflight dependency. It may not silently rely
on a running Orca UI, a stale `ORCA_AGENT_HOOK_*` endpoint, or an implicit
relay association.

The setup hook must remove a partially created session if four-window creation
fails. Existing sessions remain untouched.

Initial rollout does not mutate legacy sessions that predate the four-window
layout. The operator must archive and recreate each such session once; only
new sessions receive the layout automatically.

Provider command dispatch is additionally gated by a non-mutating binary/flag
preflight on the new session's target host. The preflight checks the exact
resume subcommand/selector and permission flags for that provider. An
unsupported binary or flag records `RECOVERY_REQUIRED` and sends no provider
command; it never substitutes another flag or selector.

Recovery is deliberately one-shot per created tmux session. If a provider
start or preflight partially fails, the coordinator leaves the session and
window as shell plus `RECOVERY_REQUIRED`; a later reconciliation sees the
existing session and sends no second provider command. Manual archive and
recreate is required after correcting the failure, preventing duplicate
provider processes or concurrent writers.

The setup hook's single-owner contract is the only layout definition. The
coordinator must not duplicate or reinterpret it.


`restore_worktree_sessions()` continues to enumerate Orca's worktree inventory,
skip non-local paths, call the setup hook, observe which session name was newly
created, load the matching host-local provider-session manifest, and start
provider recovery only for that newly created session. An existing session is
never modified or sent a resume command.

## Session layout

Session names retain the existing derivation:

```text
<repository-root-basename>-wt-<worktree-basename>
```

The root worktree uses `main` as its worktree slug. Every new session is created
with the exact worktree as its session path and each window's initial pane CWD.
The four windows are ordered as follows:

| 0 | `codex` | Codex exact-locator resume command |
| 1 | `claude` | Claude exact-locator resume command |
| 2 | `omp` | OMP exact-locator resume command |
| 3 | `bash` | idle shell |

If the session already exists, setup validates its session path and returns
without adding, deleting, or respawning windows.

Provider commands are sent only after the session was created during the
current recovery invocation, its pane CWD matches the exact worktree, and the
provider manifest entry matches that same worktree.

| window | command |
| --- | --- |
| `codex` | `codex resume <session-id> --dangerously-bypass-approvals-and-sandbox` |
| `claude` | `claude --resume <session-id> --dangerously-skip-permissions` |
| `omp` | `omp --resume <resume-file-or-session-id> --auto-approve --approval-mode=yolo` |

The provider locator is not selected by tmux session name or a global recent
session picker. The Codex locator is the recorded `session_id`; the Claude
locator is its recorded `session_id`; the OMP locator is its recorded
`resumeFilePath` when present, otherwise its recorded `session_id`. This
matches the provider-specific mapping in
`src/shared/agent-session-resume.ts:getAgentResumeArgv()` and the startup plan
in `src/shared/tui-agent-resume-startup.ts:buildAgentResumeStartupPlan()`.

The permission-bypass flags are an explicit OCI-only policy. They are not sent
to hp_v2. OMP has no `dangerously-skip-permissions` flag; `--auto-approve` plus
`--approval-mode=yolo` is its installed CLI approval policy and must remain a
provider-specific command contract.
The command rows above are the recovery argv after the provider preflight. The
preflight must verify the installed provider help output exposes every
selector and permission flag used by that row. A preflight failure is a
provider-local `RECOVERY_REQUIRED`, not a downgrade to another approval mode.


A provider resume failure, including a missing or mismatched manifest locator,
returns the window to an ordinary shell and records `RECOVERY_REQUIRED`. It
must not be converted into a fresh provider launch. The recovery code must not
use an unconditional `resume || fresh` fallback that hides authentication,
lock, CWD, unsupported-flag, or corrupt-session errors.

## Provider session manifest

Each OCI worktree has one host-local manifest outside the worktree:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/orca/oci-worktree-sessions/<sha256(realpath(worktree))>.json
```

The manifest is mode `0600`, written through a temporary file and atomic rename,
and never committed to the worktree. Its minimum schema is:

```json
{
  "version": 1,
  "worktreePath": "/srv/workspace/project-feature",
  "repoRoot": "/srv/workspace/project",
  "providers": {
    "codex": { "key": "session_id", "id": "..." },
    "claude": { "key": "session_id", "id": "..." },
    "omp": { "key": "session_id", "id": "...", "resumeFilePath": "..." }
  }
}
```

Entries are updated only by the explicit provider-native SessionStart adapter
path defined in the chosen approach. The implementation must not infer an ID
from terminal text, file mtime, a global recent-session picker, or a relay
event that lacks the raw session's `ORCA_OCI_*` context. The writer receives a
normalized provider locator from the adapter, realpaths and validates the
worktree/root pair, then atomically updates the matching manifest. For OMP,
`resumeFilePath` is stored only when
`ctx.sessionManager.getSessionFile()` supplies the authoritative path;
otherwise the exact OMP session ID remains the locator.

A manifest is consumed only when its recorded `worktreePath` and `repoRoot`
match the canonical realpaths of the target session. A moved or renamed
worktree does not reuse the old manifest automatically. A missing adapter,
missing locator, malformed locator, or failed path/root validation leaves that
provider at `RECOVERY_REQUIRED` after reboot. The system does not downgrade to
`--last`, `--continue`, or a fresh session.


The manifest stores provider locators only; it stores no API credentials,
approval tokens, or conversation content.

## Writer and ownership policy

Codex, Claude, and OMP sessions are separate provider conversations, but their
windows share the same worktree filesystem. This version relies on the
operator's explicit invariant that only one provider is actively used for
write-capable work at a time.

The coordinator must not automatically dispatch work to more than one provider
in the same worktree. A future automated or UI-visible worker must use a
separate worktree; introducing automation is the trigger for a shared writer
lock or equivalent preflight, not normal tmux session recovery.

## Managed UI boundary

A UI-visible worker is created through Orca managed orchestration and receives
its own managed terminal/worktree identity. It is not placed into one of the
four existing tmux windows. The current `/srv/workspace/orca` OMP work session
must not directly start, stop, resume, or kill that worker; the permitted
coordinator/control-plane dispatch path owns the lifecycle.

Raw `tmux send-keys` provider startup is therefore intentionally invisible to
managed orchestration lineage. Dashboard cards and AgentMap edges are only
expected for the separate managed terminal path.

## Recovery behavior

| condition | expected behavior |
| --- | --- |
| hp_v2 reboot while OCI is running | OCI tmux sessions and provider processes are untouched; hp_v2 state is separate |
| OCI reboot | coordinator session is ensured; missing local worktree sessions are recreated with four windows |
| newly created worktree session | load the matching manifest and send one exact-locator resume command per provider window |
| no matching provider locator | leave that window as shell and record `RECOVERY_REQUIRED` |
| provider resume error | leave that window as shell and record `RECOVERY_REQUIRED`; no fresh launch |
| wrong session path or pane CWD | fail the recovery for that session; do not start a provider |
| non-local/Windows worktree path | skip it; do not create an OCI tmux session |
| managed worker request | create a separate Orca managed terminal/worktree, never a tmux child |

Recovery is deliberately one-shot per created tmux session. If a provider
start or preflight partially fails, the coordinator leaves the session and
window as shell plus `RECOVERY_REQUIRED`; a later reconciliation sees the
existing session and sends no second provider command. Manual archive and
recreate is required after correcting the failure, preventing duplicate
provider processes or concurrent writers.


A resume restores provider conversation context only. It does not claim that a
previous command, test, child process, or terminal output was restored.

The operational change is limited to:

- the authoritative Orca local setup hook and its `/srv/script` test copy, for
  creating the four-window layout;
- the provider-native raw-session event adapters and OMP hook extension that
  feed the manifest writer without using the Orca managed relay;

- a host-local provider-session manifest writer/reader and focused tests;
- `/srv/script/orca-coordinator.sh`, for provider-specific exact-locator
  recovery on newly created sessions and strict failure handling;
- focused shell tests for hook layout, manifest matching, and coordinator
  recovery behavior;
- operational project facts documenting the OCI session and provider policy.

The existing Codex invocation must use
`--dangerously-bypass-approvals-and-sandbox`, not Claude's
`--dangerously-skip-permissions`. Claude and OMP require their own exact
resume and approval contracts; provider flags must not be substituted across
tools.

## Tests

Extend the existing focused shell tests without creating a real reboot or
modifying the live `orca` tmux socket.

The setup-hook test must assert:

- root worktree name normalization to `*-wt-main`;
- branch worktree name derivation;
- exactly four windows in the documented order;
- every window's session path and initial pane CWD match the worktree;
- an existing session is reused without window mutation;
- path mismatch fails closed.

The manifest tests must assert:

- one manifest is selected only for the exact canonical worktree path and repo
  root;
- Codex, Claude, and OMP locators are persisted with their provider-specific
  fields;
- manifest writes are private and atomic;
- a moved worktree, missing provider entry, malformed locator, or provider
  mismatch yields `RECOVERY_REQUIRED`;
- no provider ID is inferred from recent-session ordering or terminal text.

The event-path tests must assert:

- Claude/Codex SessionStart payloads reach the writer with the native
  `session_id`;
- OMP `session_start` reaches the writer with
  `ctx.sessionManager.getSessionId()` and its optional session file;
- absent or mismatched `ORCA_OCI_*` context cannot write another worktree's
  manifest;
- no manifest update depends on terminal text, mtime, or recent-session order.


The coordinator test must assert:

- `ensure-session` restores missing local worktree sessions;
- Windows/hp_v2 paths are skipped;
- only sessions created during the current invocation receive provider commands;
- the exact provider-specific locator commands are sent to the matching
  windows;
- `ORCA_COORDINATOR_RESUME_AGENTS=0` restores sessions without provider starts;
- provider resume failure produces `RECOVERY_REQUIRED` and no fresh command;
- an existing session is not resumed again;
- an unreachable hp_v2 runtime does not destroy the OCI keeper or local session
  inventory.

Run CLI help probes for the installed Codex, Claude, and OMP versions and keep
the exact-resume assertions aligned with
`getAgentResumeArgv()`/`buildAgentResumeStartupPlan()`. Do not infer a
provider's resume syntax from another provider.

Provider preflight tests must cover the installed Codex, Claude, and OMP
selector/permission flags, with unsupported flags producing
`RECOVERY_REQUIRED` and no downgrade.

Recovery idempotency tests must cover a second coordinator invocation after
each provider preflight/start failure: it must leave the existing session
untouched and send no duplicate provider command. A failed partial layout must
be removed by setup so a later setup can retry creation.

The UI-visible managed-worker acceptance remains a separate Orca UI/AgentMap
smoke check. It must verify a managed worker has its own terminal and managed
lineage; it must not expect a raw tmux window to become a card.

## Verification and delivery

Read-only source inspection, ShellCheck, and focused shell tests run on OCI.
Project pnpm gates, builds, packaging, and Electron validation remain hp_v2-only
through the coordinator. No hp_v2 reboot is required for normal OCI session
recovery verification; a controlled OCI tmux-service restart or host reboot
scenario must be performed only by the coordinator/host owner.

Before claiming recovery support, record the focused test output and verify that
provider resume is attempted only for newly created sessions. Keep the provider
resume policy independent from hp_v2 terminal handles, SHA gates, and remote
wire fields.
