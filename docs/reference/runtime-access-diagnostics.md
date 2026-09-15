# CLI runtime access diagnostics

A local CLI caller can read runtime metadata while its sandbox denies connecting
to the Unix socket or named pipe. A denied PID probe does not establish that the
runtime exited. Restarting the app cannot grant the caller access.

The CLI reports access failures through its existing error envelope (`ok: false`),
rather than a successful status response claiming `stale_bootstrap` or `starting`:

| Condition                                                               | Error code                  | Diagnostic data             |
| ----------------------------------------------------------------------- | --------------------------- | --------------------------- |
| Metadata read, connection, or PID probe returns `EPERM` / `EACCES`      | `runtime_permission_denied` | `reason: permission_denied` |
| PID probe fails with an error other than `ESRCH` or a permission denial | `runtime_unverifiable`      | `reason: probe_failed`      |

Both include `operation` (`read_metadata`, `connect`, or `probe_process`) and
`processState: unverifiable`. `systemCode` is included when available. `pid`, when
present, comes from metadata and is not a verified owner identity. Error messages
do not copy endpoint paths, authentication tokens, or raw OS error messages.

`orca open` stops on an initial access error before launching an app or polling.
No permission, transport, runtime-state enum, or remote wire format is changed.
Ordinary missing metadata and refused connections retain their existing behavior;
after a non-permission connection failure, `ESRCH` retains the stale-PID result.

An access error requires checking the caller's authorized sandbox/OS access path.
It does not authorize restarting Orca, disabling a sandbox, or bypassing the
single-instance lock. In particular, this diagnostic does not restore a sandboxed
worker's heartbeat or completion-message delivery. Coordinators must retain that
distinction and verify settlement through their authorized runtime connection.
