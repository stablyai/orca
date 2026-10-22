# Legacy relay bridge

`COMPAT(legacy-relay-bridge)` · revisit **2027-01-15**, decided by telemetry.

Orca 1.4.224 kept SSH terminals alive inside a `relay.js --detached` process on the host.
1.4.225 runs every SSH host on orcad and has no relay client, so this folder keeps those
terminals working in their old tabs until each one exits. New terminals open on orcad, and
nobody is prompted.

**How it works**

- The host converts to orcad even while relay terminals run. Converting stops nothing; the
  journal records those leases as `bridgedPtyIds`.
- The bridge runs each of this target's relays' own `relay.js --connect` (POSIX sockets and
  Windows pipes) and takes the terminal-owner role, never from a client still attached. It never
  deploys, starts, stops or deletes a relay.
- Leased panes the relay lists reattach in their old tabs through
  `renderer/.../legacy-relay-bridge-transport.ts`.
- A dropped connection, or a disconnect that hangs the bridge up, is `unverifiable` and reattaches
  later; removing the target is what empties its panes. A pane retires (lease `terminated`)
  only when its relay reports the exit, or every relay for the target answered without it.
- Closing a bridged tab, by any stop route, sends the relay's own `pty.shutdown`. A stop the relay
  can't take yet is kept on the lease as `pendingKill`, so it survives a restart; that lease is
  listed for the stop but never served as a pane again. A stop no later run could fence to the same
  process (a legacy `pty-N` id with no incarnation) gets one try, then the lease ends.
- Sleeping a bridged pane is refused (the pane stays live): its stop would be durable, so it would
  outlive the sleep. A stop-and-wait caller succeeds only on the relay's exit proof.

**Touches** `ipc/ssh.ts`, `ipc/ssh-connect-flow.ts`, `ipc/ssh-host-server-on-connect-wiring.ts`,
`ipc/ssh-session-teardown.ts`, the conversion gate's `bridged` verdict
(`orcad-migration-terminal-gate.ts`, `-source-fence.ts`, `-source-assertions.ts`,
`orcad-runtime-conversion.ts`, `shared/orcad-migration/orcad-migration-source-cutover.ts`), the preload
`legacy-relay-bridge-api.ts`, and the renderer's `pty-input-recovery.ts` and
`deferred-session-attach.ts`.

**Removal** Watch `ssh_host_server_legacy_relay_bridge` (`connected` with a `terminals` bucket,
and `terminal_exited`). Once `connected` rows stop, delete this folder, every
`COMPAT(legacy-relay-bridge)` seam and the `bridged` verdict.
