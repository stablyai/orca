# Recovery and cleanup

Act only on proof. `worker-list --run <run_id> --include-remote` gives
each worker's liveness and `next`; follow it.

When a retry is authorized, use the same Task for a failed or stopped attempt;
`--spec` would create a new one. User-cancelled work requires renewed user authority
before any retry or recreation. Placement is not inherited:

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
user-owned process. Claim physical cancellation only with execution-host proof
that the agent and its owned helpers exited; a stopped result alone can represent
assignment accounting without process action. On `stop_unknown`, inspect
`worker-show` and the receipt, then report the unresolved
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

## Cancel and discard one isolated lane

Generic cleanup protects Orca membership; the user's explicit cancellation **and
draft-discard request** can authorize targeted removal after these proofs:

1. Resolve the exact owning Run, Task, Dispatch, execution host, workspace identity,
   canonical path on that host, and branch. Use the saved host route and exact
   selectors, not names or local lookalike paths. Confirm this is the lane's
   exclusively created isolated checkout; preserve current, shared, reused,
   pre-existing, user-taken-over, and Keep open resources.
2. Request the guarded `worker-stop --dispatch <dispatch_id>` described above.
   Inspect its receipt and `worker-show` for actual process/session closure on the
   execution host, including every owned helper and successor session. Check
   `helpers` and `helperStopError`; starting, kept-open, or unconfirmed helpers block
   discard. Task status, `stopped`/abandoned accounting, `alreadySettled`, silence,
   missing rows, or exit code zero alone do not prove physical exit. A context-only
   stop can leave its unsupervised process running. Preserve resources and report
   any refusal, `stop_unknown`, unproven exit, or ownership uncertainty; abandonment
   cannot substitute for exit proof.
3. Verify exclusive use of both checkout and branch across owners and Runs, using
   host-specific workspace/process evidence and Git worktree branch use. Inspect
   `worker-list --include-remote --json` scope: omission of `--run` can still select
   the caller's bound Run. Check `scope.source`, follow `page.nextCursor` with
   `--cursor` while `page.hasMore`, and inspect other possible owning Runs/hosts.
   Partial host errors, warnings, or an unverified owner block discard; one Run's
   rows or visible worktree lists cannot prove exclusivity. Preserve peer workers,
   worktrees, and branches; never use Run-wide reset or bulk terminal closure.
4. After stopping or intentionally abandoning the assignment, record the user's
   cancellation with the supported Task accounting (there is no `cancelled` status):

   ```text
   ORCA orchestration task-update --id <task_id> --run <owning_run_id> --status failed --result cancelled
   ```

   This records intent, not exit proof. Recovery must not use `--retry-of`, promote
   it to `ready`, create a replacement Task/Run, or restart/recreate the lane without
   renewed user authorization; the runtime can reopen it on retry.

5. Immediately before removal, refresh membership, stop proof, and exclusive use;
   preserve the lane if any new owner appears. These checks are point-in-time, not
   atomic with deletion. Only after all proofs, consult the selected CLI's
   `worktree rm --help` and current branch-retention policy, then remove exactly the
   authorized lane's draft, isolated worktree, and exclusive branch. Verify their
   absence on the owning host and that peers remain intact. Do not infer branch
   deletion from `--force` or claim these instructions enforce runtime safety.
