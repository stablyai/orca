---
name: orchestration
description: >-
  Coordinate supervised Orca workers: threaded messages, blocking ask/reply,
  task dispatch, worker_done/escalation waits, task DAGs, decision gates,
  coordinator loops, and decomposing work across agents. Use `orca-cli` for full
  ownership handoffs — "hand off", "handoff", "handover", "give this to another
  agent", "another worktree" — unless asked to supervise, monitor, or coordinate
  a DAG, and for terminal control, lightweight terminal prompts, shell commands,
  Orca worktree management, and reading or waiting on terminals. Use Computer
  Use for external browser windows, webviews, Orca app UI, or desktop UI outside
  Orca's embedded browser only when the task requires OS/window-level control
  such as focus, menus, dialogs, coordinates, or screenshots. Use `orca-cli` for
  Orca's embedded pages and a page-automation tool such as Playwright or CDP for
  external pages.
---

# Orca orchestration

Orchestration is Orca's structured coordination layer. It records who owns work,
which attempt is authoritative, and when supervised work has settled.

## Outcome

**Result:** every in-scope Task has one explicit outcome and every settled worker
terminal has a next owner or cleanup decision. **Next consumer:** the user who
requested supervision. **Done:** all expected Dispatches have settled, every
delivered message was processed before acknowledgment, each settled worker was
reused, explicitly retained, or released, and the turn ends only when the report
to that user names, per Task, its outcome, the evidence behind it, and any
unresolved blocker.

**Safe failure:** preserve work and authority and report the state as unknown or
`unverifiable`. Only positive proof of exit authorizes stop, abandon, or retry,
and only an accepted settlement authorizes release. Every other observation,
absence included, is a checkpoint.

## Classify the role

| Current context                                                                                                                                | Role                    | Route                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| The user explicitly asks to supervise, monitor, wait for results, track completion, coordinate a DAG, use a decision gate, or manage ask/reply | Coordinator             | Use the supervised loop below                                                  |
| The current prompt contains a live injected preamble with Task and Dispatch IDs                                                                | Dispatched worker       | Follow the preamble and the worker obligations below                           |
| The user asks to hand off ownership or start another agent/worktree without supervision                                                        | Handoff owner           | Use `orca-cli`; create no Run, Task, or Dispatch and do not monitor completion |
| A message carries a legacy authority label                                                                                                     | Compatibility operator  | Load the legacy contract reference before any lifecycle mutation               |
| No live preamble and no explicit supervision                                                                                                   | Ordinary terminal agent | Do not emit lifecycle messages; use `orca-cli` for terminal/worktree work      |

Model or effort selection does not make a handoff supervised. Never substitute a
non-Orca subagent tool when Orca orchestration provenance was requested.

## Authority and safety floor

- A Run is a durable namespace and coordinator inbox; it does not schedule or
  place workers. A Task is work. A Dispatch is one authoritative Task attempt.
- Lifecycle authority comes from the active Dispatch, not a terminal title,
  copied ID, old database row, provider transcript, or visible pane.
- Workers use the exact executable, handle, capability, Task ID, and Dispatch ID
  in the live preamble. Never reconstruct, translate, or broaden those arguments.
- After remote start, address the worker by Dispatch ID. The execution host owns
  process, filesystem, transcript, stop, and cleanup facts. Preserve the verdicts
  `live` / `unverifiable` / `exited`; contact loss is not process death.
- Liveness is layered: `worker-list`'s `projection.liveness` is the fleet verdict
  for the agent; `worker-show`'s `observation.status` is PTY liveness only. A live
  terminal can still hold a dead or stuck agent.
- Folder workspaces are valid; never require Git or assume a worktree.
- Clients and remote servers update independently. Treat unknown optional fields
  as absent. A new stream operation requires advertised capability because old
  decoders may silently drop unknown opcodes. Never fall back to local execution
  when remote authority or capability is unproven.
- Use the executable you used to run `skills get` for the entire run. In the
  examples below, replace `ORCA` with it; do not create a shell variable or run
  `ORCA` literally. If it fails, report that exact error instead of switching.
- A successful `orchestration send` proves durable enqueue; its wake or nudge is
  best-effort attention only and does not prove the recipient read or accepted it.

## Worker obligations

The injected preamble is authoritative. A dispatched worker must:

1. Do only the current Task and use the preamble's `ask` command for a blocking
   coordinator question. Never open a local question TUI the coordinator cannot
   answer. Resume the same message ID after an ask timeout.
2. Send heartbeats only at the cadence in the preamble. A heartbeat proves
   liveness, not completion.
3. Read coordinator follow-ups at each natural checkpoint — before starting a
   new file, after a test run — and once more immediately before `worker_done`:
   `ORCA orchestration check --terminal <your_handle> --json`.
4. Send `worker_done` exactly once, from the dispatched terminal, with a
   three-sentence executive summary, both lifecycle IDs, and explicit
   `--outcome succeeded` or `--outcome failed`. Never encode failure only in prose.
5. Append `--files-modified` and `--report-path` only with real values when
   applicable. After `worker_done`, end the dispatched turn and idle; do not poll
   or start new work.

A direct user instruction after completion starts new user-owned work and takes
precedence over the idle rule. Do not reuse the settled lifecycle IDs.

## Canonical supervised loop

Confirm the runtime, bind one Run, and start the full independent wave before
waiting. `worker-start --spec` creates the Task and its attempt in one call:

```text
ORCA status --json
ORCA orchestration run-create --objective "<objective>" --json
ORCA orchestration worker-start --spec "<worker A task>" --worktree current --agent codex --json
ORCA orchestration worker-start --spec "<worker B task>" --worktree current --agent claude --json
ORCA orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

If `worker-start` exits non-zero, do not relaunch. Read the receipt's
`failedStage` and `residualResources`, then load
`references/recovery-and-cleanup.md`.

Use `task-create` plus `worker-start --task <task_id>` for planned fan-out with
dependencies or a retry of a known Task. Use dependencies only for real ordering
and prefer parallel waves over chains deeper than three or four steps; nested
workers obey the depth limit, and a new Run does not reset the caller's depth.

A consuming `check` names its caller with `--terminal <handle>`, never `--from`;
omit it inside the coordinator's own Orca terminal. It returns the bound Run's
oldest FIFO Delivery and replays that batch until acknowledged. Process every
message: reply to questions, validate each `worker_done` against the expected
active Dispatch, and decide each settled terminal's next owner before the ack:

```text
ORCA orchestration reply --id <message_id> --body "<answer>" --json
ORCA orchestration worker-release --dispatch <dispatch_id> --json
ORCA orchestration check --ack <delivery_id> --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

Keep waiting until every expected Dispatch settles. A timeout or empty result is
a checkpoint, not a failure. Do not stop, retry, release, or launch a duplicate
editor without the positive proof `## Outcome` requires.

After three consecutive empty waits, stop waiting blindly and enumerate with
`ORCA orchestration worker-list --include-remote --json` (defaults to the bound
Run; `--run <run_id>` overrides; the receipt's `scope` names which), acting on
each row's `projection.attention` categories, `projection.attention.requiresAction`, and literal `projection.nextAction` argv.
An `inspect` `nextAction` on a `live` row with `attention.requiresAction` false
is informational, not a command to re-run: keep waiting with `check --wait`.
Leave the wait only on positive proof the agent stopped: `exited` liveness, the
worker's own observation of process exit, or a transcript whose final agent turn
sent no `worker_done`. Then load `references/recovery-and-cleanup.md` and choose
`worker-stop` or `worker-abandon` explicitly. `unverifiable` is absence,
including when `worker-show` reports `agentWait` null. Absence never authorizes
stop, abandon, retry, or release; keep waiting or inspect.

`worker-start` is the normal path, composing placement, terminal readiness,
prompt injection, and supervised resource ownership. `dispatch --inject` leaves
an operator-created process unsupervised and is only for an expressiveness gap.

## Task-spec contract

Every Task spec must be self-contained and name:

- **Target:** the files, component, or environment in scope.
- **Change:** the concrete result to produce.
- **Constraints:** invariants, compatibility rules, and do-not-touch boundaries.
- **Ownership:** what this worker may edit and any coordination boundary.
- **Observable acceptance:** the test, output, or evidence that proves completion.

## Completion accounting

After an accepted success or failure report, immediately do exactly one:

1. Reuse the same proven agent terminal for an immediate follow-up Dispatch.
2. Record user-requested retention with `worker-retain`.
3. Run `worker-release`.

Release is post-settlement cleanup, not cancellation. Only an accepted
settlement authorizes it; no other observation does. If release is uncertain,
follow its exact recovery receipt and never substitute `terminal close`.

A valid `worker_done` settles the Task and Dispatch automatically; do not follow
it with `task-update --status completed`. Enumerate the terminals still owing a
decision with `worker-list --run <run_id> --terminal-state reclaimable --json`,
and do not end the coordinator turn until it returns none.

## Conditional references

This compact guide is sufficient for the normal local loop. At an action gate
below, run `ORCA skills get orchestration --reference references/<file>.md` and
read only that document; `--references` lists the names. If the CLI rejects
`--reference`, run `ORCA skills get orchestration --full` once instead: it
returns this exact kernel and every reference, so read only the named one. If an
older CLI rejects `--full`, keep this kernel's safety floor, use that command's
`--help`, and never guess newer flags.

| Action gate                                                                                                   | Bundled reference                         |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Expanded DAG waves, launch model/effort, same-terminal reuse, or review ownership                             | `references/coordinator-loop.md`          |
| You are a dispatched worker and the live preamble does not answer your question, or `check` returned an error | `references/worker-contract.md`           |
| New worktree, exact workspace, SSH, WSL, or connected-server placement                                        | `references/placement-and-remote.md`      |
| Inbox replay, follow-up messages, group addresses, or decision gates                                          | `references/messaging-and-gates.md`       |
| Failed/stopped/unknown attempts, retry, stop, abandon, retain, or uncertain release                           | `references/recovery-and-cleanup.md`      |
| Custom argv or terminal topology that `worker-start` cannot express                                           | `references/low-level-topology.md`        |
| Any legacy label, adopted Run, compatibility receipt, or takeover                                             | `references/legacy-contract-migration.md` |

Retired scheduler commands are not aliases for Run creation. Recovery commands
must provide their exact next action; follow it with the same selected executable.
