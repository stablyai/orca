# Codex account removal durability

Removing an account changes both saved account settings and the credit-reset attempt ledger. These changes must commit together before Orca deletes the account's managed home, which contains its credentials. A failed write must preserve the account and its reset guards.

The profile writer can also report an indeterminate result: storage may have committed even though its acknowledgement was lost. Orca must not delete the managed home on that result, but it must retain enough information to retry after a restart.

The removal sequence is:

1. Reconcile the runtime selection using the proposed account settings without publishing or saving that preview. Reconcile the host, the removed account's runtime, and every runtime whose selection changes. Selection-only self-healing stays inside the preview and becomes part of the removal commit; unrelated settings writes and preview flushes are rejected. Reconcile any additional selections changed by self-healing until the selection stabilizes.
2. Persist the target in `codexAccountRemovalRecovery`, while leaving the account and reset guards intact. This record contains account metadata and the managed-home location, never credentials.
3. Commit the account removal and matching reset-guard removal in one durable profile write.
4. Delete the managed home after that write is acknowledged. Its ownership checks remain mandatory.
5. Clear the recovery record only after the home is removed or a local ownership check confirms that it is already absent.

A known write failure rolls back the account and ledger changes. An indeterminate result keeps the writer fenced; restarting reloads the committed state instead of guessing whether the write succeeded. If the account was removed from settings, its recovery record remains in the account snapshot with `removalPending: true`, so removal can be retried. It cannot be selected or reauthenticated as a normal account.

On failure, restore every runtime touched by the preview, attempting the remaining runtimes even if one restoration fails. On success, the host lifecycle follows the committed selection, including self-healing to the system default. Host-account removal still invokes that lifecycle when the host was already on the system default. Remote removal uses the execution host's store and ownership checks; the client does not infer deletion from a disconnect.

An unavailable or untrusted home, including a WSL home whose absence cannot be verified, keeps its recovery record. Failure to clear a recovery record after deleting the home is also recoverable: the next attempt confirms the local home is absent and clears the record. Recovery never treats loss of access as proof of deletion.

The regression tests cover actual SQLite reloads, a committed write whose acknowledgement is lost, a failed recovery-record write, and a removal retry after service reconstruction. These tests validate persistence and service behavior; they do not substitute for native Windows or WSL file-handle testing.
