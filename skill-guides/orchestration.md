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

Orchestration records who owns supervised work, which attempt is authoritative,
and when that work has settled.

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
| The current prompt contains a live injected preamble with Task and Dispatch IDs                                                                | Dispatched worker       | Follow the preamble and worker obligations                                     |
| The user asks for an unsupervised handoff                                                                                                      | Handoff owner           | Use `orca-cli`; create no Run, Task, or Dispatch and do not monitor completion |
| A message carries a legacy authority label                                                                                                     | Compatibility operator  | Load the legacy reference before mutation                                      |
| No live preamble and no explicit supervision                                                                                                   | Ordinary terminal agent | Do not emit lifecycle messages                                                 |

Model or effort selection does not make a handoff supervised. Never substitute a
non-Orca subagent tool when Orca orchestration provenance was requested.

## Authority and safety floor

- A Run is a durable namespace and coordinator inbox; it does not schedule or
  place workers. A Task is work. A Dispatch is one authoritative Task attempt.
- Lifecycle authority comes from the active Dispatch, never a title, copied ID,
  old row, transcript, or visible pane. Use the exact live preamble arguments.
- After remote start, address the worker by Dispatch ID. The execution host owns
  process, filesystem, transcript, stop, and cleanup facts. Preserve `live` /
  `unverifiable` / `exited`; contact loss is not process death.
- Liveness is layered: `worker-list`'s `projection.liveness` is the fleet verdict
  for the agent; `worker-show`'s `observation.status` is PTY liveness only. A live
  terminal can hold a dead or stuck agent.
- Folder workspaces are valid; never require Git or assume a worktree.
- Clients and servers update independently. Treat unknown optional fields as
  absent. A new stream operation requires advertised capability because old
  decoders may drop it. Never fall back to local execution when remote authority
  or capability is unproven.
- Use the executable that ran `skills get` for the entire Run. Replace `ORCA` in
  examples with it; never run `ORCA` literally or switch after an error.
- A successful `orchestration send` proves durable enqueue; its wake or nudge is
  best-effort attention only and does not prove the recipient read or accepted it.

## Worker obligations

The injected preamble is authoritative. A dispatched worker must:

1. Do only the Task and use its `ask` command for a blocking coordinator question.
2. Send heartbeats only at the requested cadence; they prove liveness, not completion.
3. Read coordinator follow-ups at each natural checkpoint and once more immediately
   before `worker_done`: `ORCA orchestration check --terminal <your_handle> --json`.
4. Send `worker_done` exactly once from the dispatched terminal with a three-sentence executive summary
   and both lifecycle IDs. Use `--outcome succeeded` or `--outcome failed`; never encode failure only in prose.
5. After `worker_done`, end the dispatched turn and idle; do not poll or start work.

A direct user instruction after completion starts new user-owned work and overrides
the idle rule. Do not reuse the settled lifecycle IDs.

## Canonical supervised loop

Confirm the runtime, bind one Run, and start the full independent wave before waiting.
`worker-start --spec` creates the Task and its attempt in one call:

```text
ORCA status --json
ORCA orchestration run-create --objective "<objective>" --json
ORCA orchestration worker-start --spec "<worker A task>" --worktree current --agent codex --json
ORCA orchestration worker-start --spec "<worker B task>" --worktree current --agent claude --json
ORCA orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

If `worker-start` exits non-zero, do not relaunch. Read the receipt's `failedStage`
and `residualResources`, then load `references/recovery-and-cleanup.md`.
Use `task-create` plus `worker-start --task <task_id>` for planned fan-out with
dependencies or retry of a known Task.

A consuming `check` names its caller with `--terminal <handle>`, never `--from`;
omit it in the coordinator terminal. It returns the bound Run's oldest FIFO Delivery
and replays that batch until acknowledged. Process every message, validate each
completion against the active Dispatch, and decide each settled terminal's next owner
before the ack:

```text
ORCA orchestration reply --id <message_id> --body "<answer>" --json
ORCA orchestration worker-release --dispatch <dispatch_id> --json
ORCA orchestration check --ack <delivery_id> --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

Keep waiting until every expected Dispatch settles. A timeout or empty result is a
checkpoint, not a failure. Do not stop, retry, release, or launch a duplicate editor
without the positive proof `## Outcome` requires.

After three consecutive empty waits, enumerate with
`ORCA orchestration worker-list --include-remote --json` (defaults to the bound Run;
`--run <run_id>` overrides). Act on each row's `projection.attention` categories,
`projection.attention.requiresAction`, and literal `projection.nextAction` argv.
An `inspect` `nextAction` on a `live` row with `attention.requiresAction` false is
informational, not a command to re-run: keep waiting with `check --wait`.

Leave the wait only on positive proof the agent stopped: `exited` liveness, the
worker's own observation of process exit, or a transcript whose final agent turn sent
no `worker_done`. Then load `references/recovery-and-cleanup.md` and choose
`worker-stop` or `worker-abandon`. `unverifiable` is absence, including when
`worker-show` reports `agentWait` null. Absence never authorizes stop, abandon,
retry, or release; keep waiting or inspect.

`worker-start` is the normal path; `dispatch --inject` leaves an
operator-created process unsupervised and is only for an expressiveness gap.

## Task-spec contract

Every self-contained Task spec names:

- **Target:** files, component, or environment.
- **Change:** concrete result.
- **Constraints:** invariants and boundaries.
- **Ownership:** allowed edits and coordination boundary.
- **Observable acceptance:** evidence that proves completion.

## Completion accounting

After an accepted success or failure report, immediately do exactly one: reuse the
same proven terminal for a follow-up Dispatch, record user-requested retention with
`worker-retain`, or run `worker-release`.

Release is post-settlement cleanup, not cancellation. Only an accepted settlement
authorizes it; no other observation does. If release is uncertain, follow its exact
recovery receipt and never substitute `terminal close`.

A valid `worker_done` settles the Task and Dispatch automatically; do not follow it
with `task-update --status completed`. Do not end the coordinator turn until
`worker-list --run <run_id> --terminal-state reclaimable --json` returns none.

After required deliverable Tasks are completed, the current coordinator generation
must explicitly complete the Run with a summary and at least one evidence item:

```text
ORCA orchestration run-complete --id <run_id> --summary "<result>" --evidence "<observed proof>" --json
```

Run completion and resource health are independent. An `unverifiable` terminal or
remote resource remains a warning and never becomes `exited`, but it does not by
itself block `run-complete`. A pending, blocked, or failed deliverable Task does
block completion. Waive only genuinely deferred required work, with its exact Task
ID and a reason: `--waive-task "<task_id>=<reason>"`. The waiver preserves the Task
and Attempt history. Repeat the identical command safely after a lost response;
changing the completion after it is recorded is rejected. Use `run-settle`
separately for owned child-worktree cleanup.

## Conditional references

At an action gate, run `ORCA skills get orchestration --reference references/<file>.md`.
If the CLI rejects `--reference`, run `ORCA skills get orchestration --full` once
instead and read only the named reference. If an older CLI rejects `--full`, keep
this safety floor, use the command's `--help`, and never guess flags.

| Action gate                                                    | Bundled reference                         |
| -------------------------------------------------------------- | ----------------------------------------- |
| Expanded waves, launch preferences, reuse, or review ownership | `references/coordinator-loop.md`          |
| Dispatched-worker questions or errors                          | `references/worker-contract.md`           |
| Worktree, folder, SSH, WSL, or connected-server placement      | `references/placement-and-remote.md`      |
| Inbox replay, follow-ups, groups, or decision gates            | `references/messaging-and-gates.md`       |
| Failed or unknown attempts, retry, stop, retain, or release    | `references/recovery-and-cleanup.md`      |
| Custom argv or topology `worker-start` cannot express          | `references/low-level-topology.md`        |
| Legacy labels, adopted Runs, receipts, or takeover             | `references/legacy-contract-migration.md` |

Retired scheduler commands are not Run aliases. Recovery commands must provide
their exact next action; follow it with the same selected executable.
