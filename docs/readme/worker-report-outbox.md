# Local terminal worker completion recovery

A terminal worker can finish while its local Orca runtime is restarting. The CLI
now saves its exact `worker_done` command before connecting, with one mutation
request ID and the caller evidence captured from its own environment. When the
execution host's runtime recovers, it retries through the normal authenticated
RPC dispatcher. This does not start Orca, open a window, stop a worker, or infer
completion from a missing process.

## Scope and acknowledgment

This covers terminal commands with an explicit sender, Task, Dispatch, and
success/failure outcome, using the local profile runtime. Paired clients and
structured-session callers keep their existing delivery path. Federated worker
reports are retained for inspection rather than automatically replayed without
authoritative target proof. A direct SSH relay shim can fail before the real CLI
starts; that earlier failure remains outside this fix. Folder workspaces need
no Git metadata.

Saved means pending, not settled. After a transport failure, the CLI reports
`worker_report_pending` and its original mutation ID. If recovery storage could
not be saved, healthy delivery still proceeds; an unconfirmed failure says
`worker_report_not_saved` and directs an exact-command retry with that same ID.
Reusing a saved ID with changed content is refused. Files may contain launch
credentials and private report text; never attach them to issues or log them.

Automatic recovery requires either the existing completed mutation receipt, or
the original unsettled Dispatch with the same live pane and process incarnation.
The dispatcher still validates the original request and caller. Missing startup
identity, a replaced worker, a finished Dispatch without its old receipt, and
unknown replies retain the original report. The existing receipt ledger may
prune old completed entries; recovery does not blindly recreate their completion
messages. If a report stays pending, inspect its original Task and Dispatch.
Never substitute another pane or generate a new completion to clear it.

An authoritative lifecycle settlement removes the report. An explicit permanent
refusal replaces it with a small, secret-free rejection record. Cleanup failure
cannot turn a confirmed successful send into an error. Pending, rejection,
quarantine and crash-left temporary records do not expire automatically.

## Storage and lifecycle

The outbox belongs to the CLI's execution host and user profile. POSIX paths use
0700 directories and 0600 files, current-owner checks, and no-follow reads.
Windows reuses Orca's current-user ACL hardener before writing credential bytes.
Writes use an exclusive temporary file, file flush, and atomic replacement;
directory flush is used where supported. Reads and filesystem operations are
asynchronous and size bounded.

At most 256 entries and 256 KiB per report can be saved; existing unsettled records
are not evicted. A full or unavailable outbox does not block healthy sends.
Recovery sends one request at a time, at most 16 due records per pass. It checks
every thirty seconds, without creating a directory in unused profiles, and
persisted retries back off from thirty seconds to five minutes. Shutdown waits
at most two seconds; stopped recovery cannot begin another delivery or remove
a record after a late reply. A malformed record is retained in quarantine; an
unreadable record is retained in place. Other readable records can recover.

Downgrading leaves records in place; an older runtime does not drain them.
Do not copy records across hosts/profiles or replace their captured identity.

## Evidence

The integration suite bundles and runs the real CLI in a child process, with an
isolated RPC server and on-disk orchestration database. It kills the CLI before
send and after durable acceptance, restarts the runtime, and checks one
completion. It also covers missing startup identity, a replacement process,
and receipt pruning. Host identity is a deterministic fixture rehydrated from
the original Dispatch, rather than a launched agent/PTY. Platform storage tests
cover claims, bounds, malformed siblings and permission checks. These tests run
in the background and never control user sessions.
