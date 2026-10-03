# Durable worker completion reports

Capability-bearing `orchestration send --type worker_done` writes the complete
request into `<userDataPath>/worker-report-outbox` before checking runtime status
or opening a transport. This applies to success and failure outcomes, with an
explicit sender, Task ID, Dispatch ID and capability. Other mutations and legacy
reports without a capability keep their existing behavior.

## Custody and acknowledgment

The CLI generates one mutation request ID before persistence, or preserves the
explicit `--retry-request`. Its exact params, capability and resolved remote
pairing are immutable. Reusing an ID with changed input fails before sending.
Records contain credentials: never attach them to an issue or log them.

A saved report is **pending**, not settled. A failed initial delivery exits
nonzero with `worker_report_pending`, the mutation ID, and an automatic-recovery
explanation. It never tells the worker to invent another completion. The runtime
uses the existing transactional mutation receipt and federation machinery;
the spool is not another Task/Dispatch database or routing authority.

Only an explicit lifecycle settlement removes the record. Federation enqueue
alone does not remove it: the existing federation queue owns network delivery,
and repeating the same mutation joins or observes its receipt until settlement.
A permanent refusal becomes a small rejection record with Task/Dispatch/request
IDs and a code, with the capability, pairing and body removed. Unknown response
shapes and transport failures retain custody. Missing status, idle output and
network loss never manufacture a completion or authorize stopping a terminal.

## Automatic recovery

The profile's RPC runtime starts the drain on startup and checks again five
seconds after each pass. This continues after the original CLI exits. It does
not launch Orca or open a window. Local replay enters the normal authenticated
RPC dispatcher with the original capability. Startup waits for the original
terminal identity to be available; a completed mutation receipt can be replayed
even if the original terminal is gone. A different process incarnation or a
revoked/superseded Dispatch remains subject to the existing authority checks.
If that original identity never returns and no completed receipt exists, the
report remains pending until the seven-day explicit expiry; replay never borrows
another pane or incarnation. Expiry does not settle the Task or release capacity.

Remote replay uses the saved pairing endpoint, pinned public key and device
credential, with a compatibility preflight. It never consults the current
environment, active pane, default pairing or another profile. Re-pairing does
not silently grant an old record a new identity. Destination selection inside
the runtime is unchanged.
Remote hosts reporting an unavailable/reloading graph are deferred. An older host
that omits this signal can still return a permanent capability refusal for a
temporarily absent identity; that refusal is retained explicitly, not overridden.

Authentication/admission and runtime-version refusals retain the report for
retry until explicit expiry; they do not prove that the completion itself is
invalid. Replay keeps the original credentials and never bypasses authorization.
Explicit capability refusals remain permanent. Shutdown waits at most two seconds
for an active drain. A claim finishing after stop cannot start delivery, and a late
reply cannot settle its report after recovery stops. The persisted claim becomes
eligible again after its retry delay, using the same mutation ID for deduplication.

## Bounds and storage safety

- At most 256 directory entries, with each report limited to 256 KiB. Full or
  oversized storage fails before sending; existing pending work is not evicted.
- One delivery at a time, up to 16 eligible records per pass. Due time is sorted
  before applying the batch limit, so backed-off targets cannot starve new work.
- Retry delay starts at 30 seconds and caps at five minutes. Claims are persisted
  before delivery, so interrupted attempts become eligible after that delay.
- After seven days, the record becomes an explicit `report_retry_expired`
  rejection. Rejection records are pruned after 30 days on the next enqueue.
- File reads, writes, flushes and directory scans are asynchronous. Writes use
  exclusive temporary files, file fsync, atomic rename and directory fsync where
  supported. Windows uses file flush plus atomic replacement; directory fsync
  is not available there.
- POSIX directories/files are restricted to 0700/0600 and checked for current
  ownership. Windows reuses the verified current-user ACL hardener, before
  credential bytes are written. Symlinks are refused, and reads are size-bounded.
- A malformed or inaccessible record is moved to `.quarantined`, with a generic
  diagnostic that contains no credentials. Other reports continue. Quarantined
  files count toward the storage bound and are retained for operator inspection
  for 30 days. Crash-left temporary files have the same bound and retention;
  no automatic repair converts their bytes into a report.

## Scope, recovery and rollback

The storage belongs to the machine/profile where the real CLI executes, including
a peer runtime on an execution host. Folder workspaces need no Git metadata.
A direct SSH relay shim that cannot reach its owning desktop fails **before the
real CLI starts**; that earlier boundary is not covered by this outbox. Likewise,
a standalone remote client with no running local profile runtime retains the
record until that runtime next starts. Neither case falls back to a different host.

Revocation, unsupported runtimes, unavailable identities and retry expiry require
inspection of the exact Task/Dispatch and the rejection or quarantined record;
they are not proof of process exit. Do not copy records between profiles or
replace their capabilities. Downgrading leaves the spool in place but an older
runtime will not drain it; restoring a supporting build resumes eligible records.

`worker-report-recovery.integration.test.ts` uses the real CLI entry point in an
isolated child process, an isolated RPC server and on-disk orchestration DB.
It kills the CLI before send and after commit/before response, restarts recovery,
and verifies a single completion and reclaimable terminal capacity. The host
identity is a deterministic fixture rehydrated from the persisted original
Dispatch, rather than a launched agent/PTY. A separate case proves completed
receipt recovery with no remaining host identity. Storage
tests cover concurrent claims, retries, malformed siblings, permissions, bounds,
and explicit rejection. These are headless tests and never control user sessions.
