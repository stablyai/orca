# When a worker ends

| What ended     | Evidence                                                     | What you can rely on                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The assignment | A `worker_done` verdict, or an observed exit before a report | A successful report completes the Task and Dispatch. A failed report fails them. An unreported exit escalates to the coordinator with `exited`, or `lost` when the pane was deliberately closed. Read that escalation before deciding on a retry. |
| The session    | The worker tab has closed                                    | The Task and Dispatch records persist. An eligible finished worker auto-closes after the agent comes to rest. A user-kept worker stays open. A local Dispatch follow-up can reopen a resumable session.                                           |
| The process    | Confirmed termination of the recorded process incarnation    | A stop needs positive exit evidence. Release addresses the exact owned terminal, preserves its output reference when available and returns a receipt. A reused or user-kept terminal can be retained.                                             |

Read `ORCA orchestration worker-show --dispatch <dispatch_id> --json` and follow its `next` or recovery instruction.

- `unverifiable` means the host cannot establish liveness. Treat the process as possibly live.
- `stop_unknown` means the stop lacks confirmation. Later exit evidence or host reconciliation can settle it. A timeout or a missing tab supplies no exit evidence.
- `release_pending` means cleanup is waiting for recovery, such as rediscovery of the terminal. `release_unknown` means Orca could not verify the outcome. Inspect the current receipt before retrying. When it calls for a new release attempt, omit `--retry-request` to start a new attempt.
- `worker-abandon` fences the assignment. Its process and resources may still be live. Use the recovery guide for user-directed cancellation or reassignment.

## A short follow-up after a report

For a quick question to a worker on this Orca while its agent is running in the original terminal, address its exact handle.

```text
ORCA orchestration send --to <worker_terminal_handle> --type question --subject "One detail" --body "Which browser did you use?"
```

This sends ordinary mailbox mail without launching a new Task or injecting the assignment preamble. A send receipt records the message. The worker’s reply confirms it received the question. Closing the terminal can strand its unread mail.

If the agent exited, an open terminal can still accept mail. A delivery-hold warning means the message is queued. Check the terminal and worker state before sending it again.

When the agent is gone, the terminal has closed, or you need another supervised result, send to the local settled Dispatch. The message types `status` (the default), `dispatch`, and `handoff` can start a follow-up Task and reopen the saved session. Put a question in the body of one of these messages if you need the worker to start again. A message of type `question` alone does not start a follow-up Task.
