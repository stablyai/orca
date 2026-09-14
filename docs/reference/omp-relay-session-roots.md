# OMP relay history roots

The relay's history sidecar now resolves OMP storage on the execution host using
`resolveOmpSessionsDir`, the same resolver as the native reader and local history
scanner. Its environment allowlist carries only OMP root/profile inputs alongside
the existing runtime variables. Node loader flags and unrelated credentials remain
excluded.

The selected root replaces the legacy OMP source; it does not add a second scan.
An invalid profile/root disables that source rather than selecting another store.
The same bounded discovery, cancellation, child partition and parse cache remain.
There are no new subprocesses, polls, recursive scan roots or wire fields.

The optional scanner input is in-process only. A client performing the existing
filesystem fallback against an older relay still uses that host's legacy root,
without consulting the client's environment or disk. A new relay publishes the
same session schema to old and new clients; relocated conversations become visible.
No capability is needed to interpret those ordinary existing session rows.

This covers the relay process's inherited environment. A profile or root set only
inside an individual terminal is not automatically part of that environment. It
does not prove resolution of the original iOS timing report #18663.

Run the actual persistence-to-sidecar proof with a read-only OMP checkout:

```sh
ORCA_BACKGROUND_LAUNCH=1 bun tests/tools/omp-relay-root-smoke.mjs /path/to/oh-my-pi
```

It bundles the production service entry, launches it under native Node using the
production environment filter, and sends the real init/list IPC messages. OMP's
actual SessionManager writes default and named-profile XDG conversations in
isolated home/config/data directories while a legacy directory coexists. Both are
found by exact UUID and path. An invalid profile yields no OMP sessions. No model
calls or visible app windows are used. This local sidecar proof is not a live SSH
connection or Windows/Linux runtime validation.
