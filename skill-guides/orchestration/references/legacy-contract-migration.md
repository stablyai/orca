# Legacy contract migration

Load this reference only for an authority label, adopted Run, compatibility or
recovery receipt, or explicit legacy takeover. A newly created attempt always
uses the current grammar.

## Authority labels

- `[LEGACY COMPATIBILITY]` is live and attested. Run only the exact supported
  command printed with the message, using the same selected executable and
  arguments supplied by the original prompt.
- `[LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]` is one bounded,
  at-least-once cutover replay. Process it idempotently and acknowledge only
  through the exact displayed guidance.
- `[LEGACY READ-ONLY]` is inspection-only. It has no reply, acknowledgment, or
  lifecycle mutation.
- An unlabeled current message uses the current guide and grammar.

An explicitly selected current Run, attested current binding, current Dispatch,
or federated attachment takes precedence over legacy fallback. A retained
adoption record alone does not grant mutation authority. If liveness, principal
ownership, capability, or the exact legacy contract is unproven, degrade to
read-only inspection and never fall back to local execution.

Adoption preserves the live agent process, PTY/session, terminal handle,
tab/pane, worktree or folder workspace, Task, and Dispatch. It never restarts or
replaces the worker and never revives the retired scheduler. Loss of lifecycle
authority does not invalidate the existing process, assignment, or filesystem
work. Exact recovery may restore the same PTY once in its original inactive
background tab; it must not spawn, write, signal, stop, switch, focus, split, or
inject a terminal.

## Compatibility recovery

When a compatibility response returns structured next-step arguments, execute
those exact arguments with the same selected CLI executable. Do not translate
from memory, broaden the recipient, or retry as a current mutation unless the
receipt explicitly authorizes it.

A pending ask, reply, final Dispatch settlement, and consuming check have
durable recovery identities. Heartbeat and escalation remain at-least-once
across a manual contract-boundary retry. If an ask may already have been
answered, run the exact non-consuming recovery check printed by Orca before
creating any new question. Never guess among identical question threads.

On packaged Windows, a legacy ask uses a two-step commit/resume protocol. The
initial command commits the question, prints its exact
`ask --resume <message_id>` command, and exits with launcher status `75`. Run
that exact resume after the launcher or update boundary. For an attested WSL
launch, preserve the printed `orca-ide` executable and distro route. Older WSL
workers without launch proof remain lifecycle read-only even while their
terminal and filesystem work continue.

## Read-only inspection and takeover

Read-only inspection does not consume mail:

```text
ORCA orchestration run-list --json
ORCA orchestration run-show --id run_legacy_local --json
ORCA orchestration run-show --id <adopted_run_id> --json
ORCA orchestration task-list --run <adopted_run_id> --json
ORCA orchestration inbox --full --json
ORCA orchestration check --terminal <legacy_handle> --peek --format --json
ORCA terminal read --terminal <legacy_handle> --json
ORCA terminal wait --terminal <legacy_handle> --for tui-idle --timeout-ms 60000 --json
```

`run_legacy_local` is an empty audit tombstone after adoption. Find the ordinary
Run whose objective is `Recovered orchestration work from a contract update`.

Only when the original coordinator is unavailable or cannot prove retained
authority may a new live coordinator take over from its own terminal:

```text
ORCA orchestration run-use --id <adopted_run_id> --takeover-legacy --json
ORCA orchestration check --run <adopted_run_id> --json
```

Takeover binds the authenticated invoking terminal; `--from` cannot nominate
another coordinator. It fences only the old coordinator and moves pending mail
into current Run delivery. It preserves live workers, Tasks, Dispatches, processes, and files.
Never take over while the original coordinator is actively coordinating.

Do not launch a replacement editor merely because Orca updated or authority is
unclear. Keep the original worker as the only editor until a stable handoff
point, then use a fresh current Dispatch in a conflict-free placement.
