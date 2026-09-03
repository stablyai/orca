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
ORCA_OMP_STATUS_EXTENSION=<installed OMP extension path>
```

The writer path is host-local and may be overridden only by focused tests.


The provider-native raw event adapters then have one explicit path:

- Claude and Codex use the generated managed hook scripts in
  `src/main/claude/hook-service.ts#getManagedScript` and
  `src/main/codex/codex-hook-script.ts#getManagedScript`. When
  `ORCA_OCI_SESSION_MANIFEST`, `ORCA_OCI_WORKTREE_PATH`,
  `ORCA_OCI_REPO_ROOT`, and `ORCA_OCI_PROVIDER_EVENT_WRITER` are set,
  their raw recorder passes the captured native JSON payload to:

  ```text
  "$ORCA_OCI_PROVIDER_EVENT_WRITER" record \
    --manifest "$ORCA_OCI_SESSION_MANIFEST" \
    --provider <provider> \
    --worktree "$ORCA_OCI_WORKTREE_PATH" \
    --repo-root "$ORCA_OCI_REPO_ROOT" \
    --payload-stdin
  ```

  The Claude recorder is emitted after the existing Devin and
  `CLAUDE_JOB_DIR` exclusion guards and before endpoint-dependent logic.
  The Codex recorder is emitted after payload capture and the spool helper
  definition but before endpoint loading. Neither recorder depends on an
  `ORCA_AGENT_HOOK_*` endpoint or adds a Windows `.cmd` branch.
  The generated recorder may invoke the writer for ordinary provider events;
  the writer alone parses `hook_event_name` and mutates the manifest only for
  `SessionStart`. Ordinary events must leave the manifest unchanged.
  The adapter extracts only the provider's native `session_id`; it never
  parses terminal output. The normal Orca status-hook path remains separate.
- OMP uses `/srv/script/orca-omp-worktree-session-hook.ts`, installed under the
  selected OMP agent directory's `extensions` child (normally
  `~/.omp/agent/extensions/`). The setup hook sets
  `ORCA_OMP_STATUS_EXTENSION` to that exact file. The existing
  `src/main/pty/omp-shell-wrapper.ts` is the source-backed proof that OMP's
  supported explicit invocation is `omp --extension <path>`; raw recovery
  passes that argument directly and does not depend on an arbitrary tmux pane
  having Orca's shell-startup wrapper. `~/.omp/agent/hooks/` is not an
  auto-discovery contract.
  The extension registers the context-bearing lifecycle callbacks
  `before_agent_start`, `agent_start`, `tool_call`, `tool_execution_start`,
  `tool_execution_end`, `tool_approval_requested`,
  `tool_approval_resolved`, `message_end`, `agent_settled`, and `agent_end`.
  The current OMP status source intentionally has no `session_start` handler.
  Each callback rereads `ctx.sessionManager.getSessionId()` and
  `getSessionFile()`, uses a non-empty session file only as the persistence
  gate, and invokes the same writer with only the normalized native session ID.
  OMP can switch sessions in-process, so the callback set must refresh the ID
  rather than rely on a single initial callback. It is a provider hook event,
  never terminal-output parsing.

The writer realpaths both `ORCA_OCI_WORKTREE_PATH` and
`ORCA_OCI_REPO_ROOT`. It requires
`git -C "$worktree" rev-parse --show-toplevel` to resolve to the canonical
worktree itself and the corresponding command for `repo-root` to resolve to
that canonical root. It then canonicalizes `git -C "$worktree" rev-parse
--git-common-dir` and the corresponding value from `repo-root` (resolving
relative output against the command's path). Those common directories must
match. This supports a linked worktree whose path differs from the main
repository worktree while rejecting a different repository. The writer
rejects a mismatched manifest argument and atomically updates only that
provider's field. Missing provider hook configuration means no locator is
published; recovery remains `RECOVERY_REQUIRED`. Managed Orca panes do not set
`ORCA_OCI_*` and therefore do not write this manifest.

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
## Coordinator-only OCI OMP fallback

The existing `orca-coordinator.sh oci-omp-run` route is an explicit
coordinator-only fallback, not a second implementation of the four-window tmux
recovery surface:

```text
hp_v2 ready          -> existing Orca/hp_v2 orchestration remains preferred
explicit oci-omp-run -> direct OMP subprocess -> stdout relay to caller
```
This contract is carried by
`/srv/script/oci-omp-fallback.sh` and
`/srv/script/oci-omp-fallback.conf`, dispatched only by
`/srv/script/orca-coordinator.sh`, with focused coverage in
`/srv/script/oci-omp-fallback.test.sh`. `/srv/script/worker-preamble.md`
continues to prohibit worker-side direct invocation.


The fallback creates no child tmux session and no PTY. It never passes
`--no-session`; it invokes OMP with a stable `--profile`, origin-scoped
`--session-dir`, `--cwd`, `--no-pty`, and `-p`. The first request omits
`--resume`. A later request for the same stable origin validates its state and
passes the saved native `sessionId` with `--resume`.

Its origin-keyed state is separate from the per-worktree manifest and contains
the stable origin, opaque coordinator `workerId`, native `sessionId`,
`sessionFile` evidence path, profile, session directory, cwd, and update time.
Only `sessionId` reaches `--resume`; `sessionFile` is not a locator for the
tmux manifest and does not create an OMP `resumeFilePath` field. The fallback's
session ID uses the same trim/empty/512-character/leading-dash/control-character
boundary before state persistence and before `--resume`; invalid state fails
closed without invoking OMP.

The worker preamble forbids direct fallback invocation and direct child-agent
launch. The fallback is a control-plane relay only and never creates an Orca
managed-worker identity or AgentMap edge.

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
| `omp` | `omp --extension <extension-path> --resume <session-id> --auto-approve --approval-mode=yolo` |

The provider locator is not selected by tmux session name or a global recent
session picker. The Codex locator is the recorded `session_id`; the Claude
locator is its recorded `session_id`; the OMP locator is its recorded
`session_id` only. The OMP command also receives the exact extension path from
`ORCA_OMP_STATUS_EXTENSION`; this is extension selection, not a session
locator. The OCI recovery command in the table above is a literal bash
argument list built directly by `orca-coordinator.sh`; it never calls
`src/shared/agent-session-resume.ts:getAgentResumeArgv()`. That shared
function's OMP case is `['omp', '--resume', ompResumeFilePath?.trim() || id]`
(confirmed at `agent-session-resume.ts:282-285`) and is reachable only through
Orca's own managed-worker resume flow, which supplies its own
`ompResumeFilePath` argument from a different code path than this OCI
manifest. Because this raw path never constructs or passes an
`ompResumeFilePath` value, the file-priority branch of that function is
structurally unreachable here, not merely untested; this OCI path's own
`--resume "$OMP_SESSION_ID"` argument is always the manifest's normalized
`session_id`.

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
    "omp": { "key": "session_id", "id": "..." }
  }
}
```

Entries are updated only by the explicit provider-native raw-event adapter
path defined in the chosen approach. The generated Claude/Codex recorder may
pass each captured payload to the writer, but the writer accepts only a
`SessionStart` payload for a manifest mutation. An ordinary provider event
therefore may invoke the writer but must produce no manifest change. The
For the tmux manifest, the implementation must not infer an ID from terminal
text, file mtime, a global recent-session picker, or a relay event that lacks
the raw session's `ORCA_OCI_*` context. The separate coordinator-only fallback
may scan its stable origin-keyed session directory only to identify the
persistent session record produced by its own direct subprocess; that state
never feeds this manifest. The writer receives a normalized provider locator
from the adapter, realpaths and validates the worktree/root pair, then
atomically updates the matching manifest. OMP's `getSessionFile()` is a
persistence gate only; it is never serialized as `resumeFilePath` or used as
the OCI resume target.

All Claude, Codex, and OMP IDs use the same trust boundary as
`normalizeAgentProviderSession` in `src/shared/agent-session-resume.ts`: trim
surrounding whitespace, reject empty values, reject values over the shared
512 string-length limit, reject a leading `-`, and reject control characters
with code `<= 0x1f` or `0x7f`. Rejected values cannot mutate a manifest or reach
resume argv.


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
coordinator/control-plane dispatch path owns the lifecycle. The explicit
coordinator-only `oci-omp-run` fallback is allowed only on that control-plane
path and remains outside managed-worker lifecycle.

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
| explicit coordinator `oci-omp-run` fallback | run direct persistent non-PTY OMP; relay stdout; save state and resume later requests by origin |

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
- the existing coordinator-only `oci-omp-run` fallback and its
  origin/profile/session state, which must remain separate from tmux recovery
  and inaccessible to worker panes;

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
- `ORCA_OMP_STATUS_EXTENSION` points to the installed extension under the
  agent directory's `extensions` child and the coordinator's recovery argv
  passes that exact path with `omp --extension`;
- an existing session is reused without window or extension mutation;
- path mismatch fails closed.

The manifest tests must assert:

- one manifest is selected only for the exact canonical worktree path and
  repository root;
- the worktree's canonical `git rev-parse --show-toplevel` equals the
  worktree path itself;
- the worktree and repository root resolve to the same canonical
  `--git-common-dir`, including a real linked-worktree fixture;
- Codex, Claude, and OMP locators are persisted with their provider-specific
  fields;
- surrounding whitespace is trimmed before persistence;
- empty, overlong, leading-dash, or control-character IDs from all three
  providers return non-zero, leave the prior manifest field unchanged, and
  never reach a resume command;
- manifest writes are private and atomic;
- a moved worktree, missing provider entry, malformed locator, or provider
  mismatch yields `RECOVERY_REQUIRED`;
- no provider ID is inferred from recent-session ordering or terminal text.

The event-path tests must assert:

- the Claude recorder appears after the Devin/`CLAUDE_JOB_DIR` exclusions and
  before endpoint-dependent code;
- Claude/Codex `SessionStart` payloads reach the writer with the native
  `session_id`;
- an ordinary Claude/Codex payload may reach the writer but leaves the
  manifest unchanged;
- the installed Claude POSIX script is the shared
  `~/.orca/agent-hooks/claude-hook.sh` path and contains the recorder;
- Codex's redirected runtime `CODEX_HOME/hooks.json` `SessionStart`
  registration points to the shared `~/.orca/agent-hooks/codex-hook.sh`
  launcher, and that launcher contains the recorder;
- OMP registers the confirmed lifecycle event set, rereads a mutable
  `ctx.sessionManager` ID after a session switch, and records both native IDs;
- OMP with a missing `getSessionFile()` does not invoke the writer, and no OMP
  event passes `--resume-file`;
- absent or mismatched `ORCA_OCI_*` context cannot write another worktree's
  manifest;
- no manifest update depends on terminal text, mtime, or recent-session order.

The coordinator test must assert:

- `ensure-session` restores missing local worktree sessions;
- Windows/hp_v2 paths are skipped;
- only sessions created during the current invocation receive provider
  commands;
- the exact provider-specific locator commands are sent to the matching
  windows, with OMP receiving only its recorded `session_id`;
- invalid provider IDs are rejected before `send-keys`;
- `ORCA_COORDINATOR_RESUME_AGENTS=0` restores sessions without provider starts;
- provider resume failure produces `RECOVERY_REQUIRED` and no fresh command;
- an existing session is not resumed again;
- an unreachable hp_v2 runtime does not destroy the OCI keeper or local session
  inventory.
The coordinator-only fallback test must assert:

- `oci-omp-run` is callable only through the coordinator wrapper;
- hp_v2 orchestration remains preferred when its runtime is ready;
- the helper uses direct `--no-pty -p` execution with stable `--profile`,
  `--session-dir`, and `--cwd`, without tmux/PTY/`--no-session` launchers;
- the first request has no `--resume`, a follow-up uses the same origin state
  and saved native `sessionId` with `--resume`, and stdout is relayed unchanged;
- the saved state preserves the same opaque `workerId` and origin while its
  `sessionFile` remains evidence rather than a resume locator;
- overlong, leading-dash, control-character, or malformed saved IDs fail
  closed before OMP invocation.


Run CLI help probes for the installed Codex, Claude, and OMP versions and keep
the exact-resume assertions aligned with
`getAgentResumeArgv()`/`buildAgentResumeStartupPlan()`. Claude capability
preflight must use a non-launching parser-acceptance invocation that includes
the exact `--resume` and `--dangerously-skip-permissions` arguments; it must
not require those strings to appear in `claude --help` output. Do not infer a
provider's resume syntax from another provider.

Provider preflight tests must cover the installed Codex, Claude, and OMP
selector/permission flags, with unsupported flags producing
`RECOVERY_REQUIRED` and no downgrade. The OMP preflight and recovery command
must use the manifest's ID, never a native session-file path.


Recovery idempotency tests must cover a second coordinator invocation after
each provider preflight/start failure: it must leave the existing session
untouched and send no duplicate provider command. A failed partial layout must
be removed by setup so a later setup can retry creation.

The UI-visible managed-worker acceptance remains a separate Orca UI/AgentMap
smoke check. It must verify a managed worker has its own terminal and managed
lineage; it must not expect a raw tmux window to become a card.

Read-only source inspection, ShellCheck, and focused shell tests run on OCI;
the focused set includes `/srv/script/oci-omp-fallback.test.sh` for the
coordinator-only persistent direct-OMP route. Project pnpm gates, builds,
packaging, and Electron validation remain hp_v2-only through the coordinator.
No hp_v2 reboot is required for normal OCI session recovery verification; a
controlled OCI tmux-service restart or host reboot scenario must be performed
only by the coordinator/host owner.

Before claiming recovery support, record the focused test output and verify
that provider resume is attempted only for newly created sessions. For live
managed-hook deployment, `src/main/ipc/settings.ts`'s `hookSettingChanged`
guard skips `applyAgentStatusHooksEnabled()`/`installManagedAgentHooks()`
whenever a reachable runtime already has the requested
`agentStatusHooksEnabled` value, so a single `agent hooks on` against an
already-enabled runtime falls through
`src/cli/handlers/agent-hooks.ts:setAgentHooksEnabled()` to the read-only
`getManagedAgentHookStatuses()` path and refreshes nothing. Use `agent hooks
off` immediately followed by `agent hooks on` to force the state transition
that runs `installManagedAgentHooks()`'s unconditional
`refreshExistingManagedScripts()`; the CLI's offline path calls
`applyAgentStatusHooksEnabled()` directly on every invocation and needs no
toggle. This refreshes the managed Claude/Codex artifacts; it does not
install the raw OMP recovery extension. The live setup hook installs that
extension under `~/.omp/agent/extensions/`, sets `ORCA_OMP_STATUS_EXTENSION`,
and the disposable-session probe verifies the explicit `omp --extension`
route. `agent hooks status` alone is not a refresh operation, and neither is
`agent hooks on` alone against an already-enabled reachable runtime. Record
the returned statuses and verify all artifacts before updating the live setup
hook. Keep the provider resume policy independent from hp_v2 terminal
handles, SHA gates, and remote wire fields.
