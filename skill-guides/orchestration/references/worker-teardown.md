# Worker teardown

A worker has three distinct endings. Keep them apart, and act only on proof:
silence, a timeout, or `unverifiable` liveness is still "in progress", never an
ending.

## Settled: the Task has a verdict

- `worker_done` settles the Dispatch and its Task: `succeeded` completes both,
  `failed` fails both. A reported failure is a conclusion; never mark it
  completed.
- If a terminal worker exits without reporting, Orca fails the Dispatch and
  mails the coordinator. A remote worker's stop relay carries the report home.
  `exited` means Orca observed the process exit. A person closing the pane can
  produce `lost`. Restart recovery also reports `lost` when it cannot confirm
  exit or continuation of an interrupted turn. The agent may still be running.
  Inspect `worker-show` before recovery: sending mail could start a second agent.
- Three failed starts in one `--retry-of` chain circuit-break the Dispatch and
  fail the Task; see [Recovery and cleanup](recovery-and-cleanup.md).

## Ended: the session is dormant, not destroyed

A finished worker auto-closes only while its agent rests; a working or
needs-you worker keeps its terminal. `--keep-open` (or `worker-keep-open`)
holds one for the user. A closed session is not a destroyed one: the records
persist, and `send` reopens a closed local worker through its stored resume
session. On a paired server a finished worker refuses `send`; start new work
there with `worker-start --on <server>`. Auto-close and keep-open never change
the Task's verdict.

## Destroyed: the process is proven gone

- `worker-stop` stops an unsettled worker and settles only on a confirmed
  kill; otherwise the receipt is `stop_unknown`. A later observed exit settles
  it, and restart recovery reconciles pending stops. Inspect `worker-show`
  before acting again. An already-failed start can still own a live terminal
  that stop does not close; reclaim it with `worker-release`.
- `worker-release` archives the output and closes the exact owned terminal.
  `release_pending` means the terminal is not rediscovered yet or its host is
  briefly unreachable; recovery retries after the next inventory. On
  `release_unknown`, inspect `worker-show` and retry `worker-release` with a
  fresh request ID; never substitute a broad `terminal close`.
- `worker-abandon` fences and settles the assignment while retaining
  possibly-live resources. It is not a kill and proves no exit.
- The settled-worker sweep releases only on a proven process exit; a live or
  unverifiable process keeps its terminal.

`ORCA orchestration worker-list --run <run_id> --include-remote` gives each
worker's liveness (`live`, `exited`, `unverifiable`) and `next`; follow it.
