# Recovery and cleanup

Act only on proof. `worker-list --run <run_id> --include-remote` gives
each worker's liveness and `next`; follow it.

## Codex model-provider recovery

Native terminal automatic resume verifies the saved session ID and model provider before
launch. The effective rollout provider includes persisted `thread_settings_applied`
updates and must agree with an available SQLite thread index. Unreadable state or a
disagreement refuses resume; never repair that by editing SQLite or JSONL. An absent
index may use the rollout's explicit provider. Legacy history without a provider binding
in either source retains Codex's own default selection; absence does not imply `openai`.
Provider replay follows [Codex 0.166.0's state extractor](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/state/src/extract.rs):
canonical session metadata and persisted settings apply in order, including copied settings
snapshots that still name their original owner.

For a direct Codex invocation, the launcher checks that the executing CLI supports
`resume --config`, then pins the saved provider with a final per-invocation `-c
model_provider=<saved-provider>`. Existing provider configuration, base URLs and global
defaults stay unchanged. Unknown wrappers, conflicting OSS/remote selectors and failed
capability probes are refused. This native-terminal guard does not establish coverage
for WSL restores or structured app-server resumes.

A provider refusal never authorizes a replacement writer. Establish exact exit or fencing
using the recovery commands below before a compatible new session; retain the owning Run,
Task, checkpoint and correction counters. A successful fresh session is not evidence that
the saved session was recovered. Process identity changes, reused PIDs, timeout and quota
exhaustion do not relax these custody requirements.

Retry a failed or stopped attempt on the same Task; `--spec` would create a new
one. Placement is not inherited:

```text
ORCA orchestration worker-start --task <task_id> --retry-of <dispatch_id> --worktree <placement> --agent <agent>
```

`worker-stop` exits 1 with `stop_unknown` when it cannot prove the agent
stopped; check `worker-show` before acting again.

`orchestration reset` deletes coordination state; run it only when the user
gives that state up.

## User-directed recovery after the breaker

After three failed starts in one `--retry-of` chain, the Dispatch circuit-breaks
and the Task fails. A worker's own failed report does not advance that count.
Report the failure and stop automatic retries; never route around the breaker
with a new Run or Task, or reset its count, including on restart.

Only when the user explicitly asks to retry or reassign this Task may its Run's
current coordinator reopen the **same Task**. Use `worker-list` above to find
every retained attempt, then inspect each:

```text
ORCA orchestration worker-show --dispatch <dispatch_id>
ORCA orchestration worker-read --dispatch <dispatch_id>
```

Silence, a startup timeout, or `unverifiable` liveness alone never proves exit or
authorizes autonomous stop, abandon, retry, or release.

For explicit user cancellation of an unsettled attempt, including an unknown
start, request `ORCA orchestration worker-stop --dispatch <dispatch_id>`.
Prior exit is not required: guarded stop can attempt cancellation of an exact
owned live agent or one with exact identity but unverifiable liveness. Respect
identity, custody, and Keep open refusals; never close or reuse an unknown or
user-owned process. Claim cancellation only on a confirmed stopped result. On
`stop_unknown`, inspect `worker-show` and the receipt, then report the unresolved
blocker; do not blindly repeat stop, retry, or start fresh.

For explicit intentional abandonment, use
`ORCA orchestration worker-abandon --dispatch <dispatch_id>` to fence and
settle the assignment while retaining possibly-live resources. This does not
cancel physical work or prove exit; never silently substitute it for cancellation.
A same-runtime in-flight stop must finish first. Reopen only after the Dispatch
is settled; never reuse an unproven or still-busy predecessor.

An already-failed start can still own a live terminal; stop/abandon does not close
it. For reclaimable failed-start terminals you are replacing, use
`ORCA orchestration worker-release --dispatch <dispatch_id>`; follow the
receipt's exact recovery action for `release_pending` or `release_unknown`, never
`terminal close`. Preserve the selected proven reusable agent with
`worker-keep-open` by its Dispatch ID; preserve user-taken-over and unproven
terminals. A fresh start without `--retry-of` does not clean up its
predecessor's terminal.

Reopen and start the same Task in its owning Run:

```text
ORCA orchestration task-update --id <task_id> --status ready --run <owning_run_id>
ORCA orchestration worker-start --task <task_id> --run <owning_run_id> --worktree <placement> --agent <agent>
```

This fresh series starts at zero. The broken Dispatch and its failure count stay
in history; `--retry-of` that Dispatch is still refused after reopening.

To reuse a proven existing agent whose previous work is settled, replace the
start command with:

```text
ORCA orchestration worker-start --task <task_id> --run <owning_run_id> --worktree <exact_existing_workspace> --terminal <agent_terminal_handle>
```

Use that terminal's workspace; omit `--agent`, `--model`, `--effort`, and
new-worktree creation. Follow [Placement and remote execution](placement-and-remote.md)
for execution-host selection and Dispatch-addressed follow-ups. After starting
independent work, end your turn; Orca wakes you. Follow a receipt's `next` action.
