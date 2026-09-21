# Recovery and cleanup

Load this reference only after a failed/stopped/unknown attempt, explicit retry
decision, stop/abandon request, retention request, or uncertain release.

| Proven state            | Safe action                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `ready` or active       | Keep waiting; optionally read bounded output                       |
| `failed` or `stopped`   | Start a replacement with `--retry-of`; repeat placement explicitly |
| `outcome_unknown`       | Inspect, then choose `worker-stop` or explicit `worker-abandon`    |
| Accepted `worker_done`  | Reuse, retain, or release                                          |
| Remote contact lost     | Preserve `unverifiable`; do not stop or retry from absence alone   |
| `unverifiable` liveness | Keep waiting or inspect; never stop, abandon, retry, or release    |
| Proven `exited` agent   | Enumerate with `worker-list`; follow its `nextAction`              |

## Inspect before acting

```text
ORCA orchestration worker-list --run <run_id> --json
ORCA orchestration worker-list --run <run_id> --include-remote --json
ORCA orchestration worker-show --dispatch <dispatch_id> --json
ORCA orchestration worker-read --dispatch <dispatch_id> --limit 50 --json
```

`worker-list` is the enumerating command and the authority on agent liveness:
each row carries `projection.liveness`, `projection.attention.categories`,
`projection.attention.requiresAction`, and a literal `projection.nextAction`
argv to run. Always scope it with `--run <run_id>`; an unscoped list reports
every Dispatch this runtime has ever recorded and buries the live ones.
`worker-show`'s `observation.status` is PTY liveness only, so a `live` terminal
whose agent died at a trust prompt still reads `live` there.

When the two disagree, the fleet verdict decides — unless the fleet row is
`unverifiable` for a reason that names a gap on this client rather than a fact
about the worker. `missing_status`, `host_unavailable`, and
`capability_unsupported` are such gaps: the first means this runtime holds no
status row, the second that it could not ask the execution host at all, and the
third that a stale peer answered but lacks the fleet-snapshot capability.
Against any of them, a `worker-show` verdict sourced from the execution host is
the better evidence and outranks the row. Only `host_unavailable` is contact
loss; the other two mean the host was never asked or answered without the
capability.

This never promotes absence. `unverifiable` from either command still authorizes
nothing — only a positive `live` or `exited` verdict does.

A worker started with `--on <environment>` reads `unverifiable` until you
enumerate with `--include-remote`, which asks its execution host for the
verdict. Past 100 rows the response pages, so follow `page.nextCursor` with
`--cursor <value>` until `page.hasMore` is false.

## Stall needs positive evidence

Leave the wait only on positive proof the agent stopped: `exited` liveness, the
worker's own observation of process exit, or a transcript whose final agent turn
sent no `worker_done`. Only then choose `worker-stop` or `worker-abandon`.

`unverifiable` is always absence — `missing_status`, `stale_status`,
`restored_unconfirmed`, or a remote worker with no connection — and a null
`agentWait` or an unchanged `worker-read` tail is that same absence seen again.
Absence never authorizes stop, abandon, retry, or release: keep waiting, or
inspect until you hold one of the positive signals above. A `nextAction` that
names an inspecting command is asking for evidence, not for cleanup.

`worker-read --source auto` uses a proven provider transcript when available and
otherwise returns bounded terminal output with a typed `fallbackReason`.
Continue with its top-level cursor, which is pinned to that source. If Orca
reports `source_changed`, restart without the old cursor. A bounded initial
transcript tail can return an EOF cursor that follows only newly appended records;
read `contentComplete`, `clipping`, and `warnings` before assuming omitted older
records are pageable. Never guess a provider session ID, transcript path, or
remote terminal handle.

## Was the mutation applied?

When a mutation's response was lost and named no Dispatch, do not replay blind.
Every orchestration mutation accepts `--retry-request <id>`, which reuses one
operation identity so Orca can replay, join, or recover it instead of starting a
duplicate. Ask what happened first:

```text
ORCA orchestration request-show --request <request_id> --json
```

`completed` means the mutation already took effect; read its recorded receipt
instead of rerunning. `pending` means the original mutation is still running or
Orca restarted before recording its outcome; replay the original command with
`--retry-request <request_id>`. `absent` means this runtime holds no receipt
under your caller identity — that is not proof nothing happened, so inspect the
affected Task, Dispatch, and terminal before deciding whether to retry.

When a worker's terminal accepted input but the submit is unconfirmed, use
`terminal send --wait-submit <seconds>`: it observes the accepted prompt for that
long and, on timeout, returns the input-accepted receipt without resending.

## Refused starts

`dispatch` and `worker-start` refuse the following preflight cases with a stable
`error.code`; read it before choosing a recovery, and treat `error.data.nextSteps`
as the exact recovery text. Older hosts may omit `data`, so treat every field as
optional.

| Code                 | Meaning                                                                                                               | Recovery                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `task_not_found`     | No Task with that id, or not in the bound Run (`data.taskId`, `data.runId`)                                           | Check `task-list --json`; create the Task with `task-create` if it does not exist                                              |
| `task_not_startable` | Task cannot start now: not `ready`, or invalid `--retry-of` (`data.status`, `data.unmetDependencies`, `data.retryOf`) | Wait for running dependencies with `check --wait`; retry or unblock failed ones; inspect `dispatch-show` if already dispatched |
| `inject_rejected`    | `--inject` refused because no recognized agent runs in the target (`data.terminal`, `data.reason`)                    | Start a recognized agent there or pick another terminal; or dispatch without `--inject` and use `terminal send`                |
| `runtime_error`      | Any other failure, including a target terminal that already owns an active Dispatch                                   | Read the message, inspect state, and do not retry unchanged                                                                    |

## Retry, stop, and abandon

Retry only a positively proven failed or stopped attempt. Name the failed Task
with `--task`, since `--spec` creates a new one. Placement is never silently
inherited:

```text
ORCA orchestration worker-start --task <task_id> --retry-of <dispatch_id> --worktree <explicit_placement> --agent <agent> --json
```

After three consecutive failures for one Task, its dispatch context
circuit-breaks and the Task is failed. Do not route around that boundary with a
new Run or an unrelated Dispatch.

For `outcome_unknown`, inspect first, then make an explicit choice:

```text
ORCA orchestration worker-stop --dispatch <dispatch_id> --json
ORCA orchestration worker-abandon --dispatch <dispatch_id> --json
```

`worker-stop` closes only the exact proven supervised agent terminal. It never
deletes the worktree, setup terminal, configured tabs, or unrelated processes.
`worker-abandon` fences orchestration while accepting that resources may remain
live; it performs no remote, process, or filesystem action.

## Retain and release

```text
ORCA orchestration worker-retain --dispatch <dispatch_id> --json
ORCA orchestration worker-release --dispatch <dispatch_id> --json
```

Retain only when the user explicitly wants the settled terminal kept live.
Release works after succeeded and failed reports, archives readable output, and
closes only the exact terminal owned by that settled Dispatch. Replays may call
release again safely. Reused, pre-existing, setup, coordinator, active,
user-taken-over, and unproven terminals are retained.

A `worker-start` that failed before its agent was ready still owns the terminal
it created. Its receipt names `worker-release`, and `worker-list` reports that
row as `reclaimable`; release it there rather than closing the terminal by hand.

Never release because of timeout, TUI idle, heartbeat, status, question,
escalation, or stale/rejected completion. If the receipt says `release_pending`
or `release_unknown`, follow its exact recovery action. Never substitute
`terminal close`.

`orchestration reset` is destructive recovery. Do not run it during active
coordination unless the user explicitly abandons that state.
