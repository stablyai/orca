# Running orcad

`orcad` is the Orca runtime served from plain Node. This is the contract between it and
whatever supervises it: what it binds, what it owns on disk, who restarts what, and what its
readiness payload actually proves.

## Two long-lived processes, not one

A deployment is **orcad** plus **the terminal daemon**.

|            | orcad                            | terminal daemon                       |
| ---------- | -------------------------------- | ------------------------------------- |
| Started by | the supervisor                   | orcad, detached                       |
| Owns       | RPC, git, worktrees, persistence | every local PTY                       |
| Lifetime   | one supervised run               | detached from orcad, not its service  |
| Endpoint   | `ws://<bind>:<port>`             | `<data-root>/daemon/daemon-v<N>.sock` |

orcad detaches the daemon and calls `disconnectDaemon()`, never `shutdownDaemon()`. The
built-in remote deployment path stops only the recorded orcad PID, so the daemon and its PTYs
survive. The successor adopts the current endpoint and routes supported previous protocol
versions through legacy adapters. This makes a PID-scoped update, rollback or restart
non-destructive to live work.

Process detachment is not service isolation. A daemon forked by orcad, and every PTY it owns,
remain in the same systemd service cgroup. `KillMode=mixed` does **not** preserve them: it
sends the graceful stop signal only to the main process, then sends `SIGKILL` to every process
remaining in the cgroup when the stop timeout expires. `KillMode=control-group` is destructive
too. `KillMode=process` leaves service-owned processes unmanaged and is not a supported
preservation mechanism. Service-restart survival requires separately supervised cgroups; the
current deployment does not provide them.

## Bind policy

`--bind <literal-ip>`, **default `127.0.0.1`**.

Only literal IPs are accepted; hostnames are refused because DNS would decide which
interface got bound. `localhost` maps to `127.0.0.1`. `0.0.0.0` / `::` are the explicit
opt-ins to network reach, and the startup log says so on every launch.

The bind is **pinned**, not defaulted. Two things widen the desktop's listener on their own —
`orca serve`'s wide default, and a startup where some device has connected before — and an
unattended host's exposure must be exactly what the operator asked for on every launch. A
mobile pairing offer, which normally rebinds to all interfaces, is refused while the bind is
pinned to loopback and reports `network_exposure_failed` rather than advertising an endpoint
nothing can reach.

Under the shipping design a client reaches a remote orcad over an SSH local port-forward, so
loopback is the correct default and the pairing credential travels over SSH.

## Data root and the instance lock

The data root is `$ORCA_USER_DATA`, else `$XDG_DATA_HOME/Orca`, else `~/.orca`.

Before the profile index or the store is touched, orcad takes `<data-root>/orcad.lock`.
It refuses to start when:

| Code                                   | Meaning                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| `orcad_data_root_wrong_owner`          | the root is owned by another uid (POSIX)                      |
| `orcad_data_root_shared`               | the root is group/world accessible and could not be tightened |
| `orcad_instance_lock_held`             | another live orcad owns this root                             |
| `orcad_instance_lock_foreign_identity` | the lock belongs to a different identity                      |
| `orcad_data_root_unusable`             | the root cannot be created, stat'd or written                 |

A root that is merely too permissive and that we own is tightened to `0700` rather than
refused — orcad stores credentials there unsealed (no OS keyring on this host), so the goal
is a private root, and refusing when we could just fix it helps nobody. We refuse when the
permissions are not ours to fix. Windows is exempt from the owner and mode checks: ACLs are
not expressible as a POSIX mode, and `statSync().mode` there reports a synthesized one.

A dead holder's record is reclaimed (PID plus process start time, so a recycled PID does not
read as alive). A record belonging to a different identity is never reclaimed.

**The lock scopes one role — who is the runtime.** It deliberately says nothing about the
daemon, which lives under `<data-root>/daemon` and fences its own endpoint with its own PID
record. A lock that asked "is any process using this root" would refuse exactly the restarts
a live daemon makes worthwhile.

## Supervision

### Process-scoped and cgroup-wide stops

The built-in remote updater performs a PID-scoped stop and keeps the daemon's install version
pinned while it owns sessions. A combined-unit systemd stop or restart is different: it reaps
the daemon and every live terminal after the graceful window.

Before a cgroup-wide stop, obtain a fresh `orca-ide terminal list --json` result using the same OS
account and home as the daemon. Invoke the installer's absolute launcher path so `sudo`'s
`secure_path` cannot hide a per-user registration (for example,
`sudo -Hu orca /home/orca/.local/bin/orca-ide terminal list --json`). Replace both `orca` and
`/home/orca` with the service account and home used by the unit; an extracted deployment may use
its absolute `resources/bin/orca-ide` launcher instead. A safe empty census is untruncated, has an explicit `hostScope`, covers every
execution host affected by the stop, and lists no terminals on those hosts. Every
`omittedHostIds` entry must be explicitly accounted for outside the target service's execution
boundary. A separately paired runtime is outside that boundary; local execution and SSH hosts
reached through this runtime are not. An affected or unknown omission, missing scope,
truncation, a failed request or lost contact makes the result `unverifiable`: defer the stop. Do
not admit new work after the census. Orca does not yet provide an atomic census-and-stop fence.

### Who supervises orcad

An external supervisor (systemd, launchd, a process manager). orcad conforms to it:

- **Readiness.** One JSON line on stdout (`--json`), `type: "orca_server_ready"`, published
  after the listener is bound and the daemon verdict is in. There is no separate readiness
  socket; the line is the signal. Set the supervisor's start timeout generously — the daemon
  launch has its own retries and can take tens of seconds on a cold host.
- **Shutdown.** `SIGTERM` or `SIGINT` starts a graceful stop. A **second** signal exits
  immediately with code 1 rather than being swallowed — a supervisor's second signal means
  its first deadline elapsed, and waiting silently is what turns a stop into a `SIGKILL`,
  the one teardown that skips the daemon handoff. orcad also imposes its own 15s deadline
  and exits 1, so the failure stays attributable instead of arriving as an unlogged kill.
- **Exit codes.**

  | Code | Meaning                                                      | Supervisor should    |
  | ---- | ------------------------------------------------------------ | -------------------- |
  | 0    | clean shutdown                                               | restart per policy   |
  | 1    | startup or shutdown failure                                  | restart with backoff |
  | 78   | configuration fault (bind address, data root, instance lock) | **not** restart      |

  78 is `EX_CONFIG`. Put it in systemd's `RestartPreventExitStatus`: restarting on a data
  root owned by someone else is a restart-spin, not a recovery.

- **Logs.** orcad writes human-readable diagnostics to **stderr** and its readiness contract
  to **stdout**; the supervisor owns capture and rotation. The daemon, being detached, writes
  its own NDJSON lifecycle log to `<data-root>/logs/daemon.log` (suppressed by
  `ORCA_DIAGNOSTICS_DISABLED=1`). Rotation of that file is not implemented — see
  [What is not covered](#what-is-not-covered).

### orcad supervising the daemon

- **Launch.** Forked detached from `daemon-entry.js` beside `orcad.js`, with its own PID
  record, token and socket under `<data-root>/daemon`.
- **Adoption before spawn.** A daemon already answering the endpoint is adopted, not
  replaced, unless it is unhealthy, foreign, or built from a superseded bundle _and_ owns no
  live sessions. Replacing a healthy daemon kills its PTYs, so code freshness always defers
  to live work.
- **Restart.** The adapter respawns the daemon on death, transparently to callers.
- **Crash-loop containment.** At most **5 launches per 60s rolling window** per orcad run;
  past that, launches are refused with `daemon_crash_loop` and terminals fail with that
  message instead of the process forking forever. The window slides, so a repaired host
  recovers without restarting orcad. An operator-initiated daemon restart clears it — that
  is the deliberate "try again".
- **No macOS login-session watch.** That watch retires the daemon when the spawning GUI login
  session dies. An orcad daemon must survive its SSH session ending.
- **Shutdown.** orcad never stops the daemon. A daemon that was never adopted retires itself
  after its adoption window; an adopted one stays resident (see Decommissioning).

### Decommissioning

After a PID-scoped stop, an adopted daemon stays resident so the next orcad can reattach.
A combined-unit systemd stop kills it instead. To retire a process-scoped deployment, apply
the census rule above, stop orcad, then stop the daemon named by `health.terminalDaemon.pid`.
Only report it `exited` after verification on the execution host; loss of contact is
`unverifiable`.

## Health

The readiness payload carries a `health` object:

```
buildHash    sha256 (16 hex) of the running orcad bundle — build identity that a version
             string cannot give, so a rollback that did not replace the file is visible
buildVersion ORCA_VERSION
nodeVersion  / nodeAbi   process.versions.node / .modules — the ABI native addons must match
platform / arch / pid
terminalDaemon:
  state              live | degraded | absent
  ownsFreshSessions  whether NEW terminals are daemon-owned; this supports PID-scoped
                     restart recovery, not supervisor or service-cgroup isolation
  pid                the live daemon's pid, from its own PID record
  buildVersion       the build the LIVE daemon was forked from (may legitimately predate
                     this orcad after an update — reporting orcad's version for both would
                     hide exactly that)
  entryPath / protocolVersion
  selfTest { ok, coverage, verdict, durationMs }
```

### What the self-test proves

`selfTest` runs `checkDaemonHealth` against the daemon's socket. It is green only when the
daemon **opened its socket, completed the protocol handshake, and ran `ptySpawnHealth` — a
real short-lived PTY spawned inside the daemon's own process**. It therefore spans both
processes: orcad drives it, the daemon performs it, the verdict crosses the socket.

- `coverage: 'pty-spawn'` — the full round trip above.
- `coverage: 'handshake'` — **win32 only**, where `checkPtySpawnHealth` returns without
  spawning anything. A green verdict there covers the handshake and nothing more. It is
  reported separately rather than folded into `ok` so nobody reads it as a PTY round trip.

`state` is `live` only when the self-test passed **and** `ownsFreshSessions` is true. A
daemon that answers but has fallen back to local spawning for new terminals is `degraded`,
because those terminals die with orcad. A daemon that answered and then failed its spawn
probe is also `degraded`, not `absent`: it still holds live sessions, and calling those
exited would be the verdict `ssh-execution-boundary.md` forbids guessing.

## What is not covered

Named here so nothing reads as implemented that is not:

- **A continuous health endpoint.** `health` is published once, in the readiness payload. A
  supervisor's periodic liveness/readiness probe needs an HTTP or RPC surface over the same
  `collectOrcadHealth()`; that surface does not exist yet.
- **Systemd-isolated daemon supervision.** orcad and its daemon currently share one service
  cgroup, so a combined-unit stop cannot preserve live terminals.
- **libc slot.** There is no honest health value to publish until native libc detection owns
  it.
- **`degradations[]`.** The readiness contract does not publish this collection yet.
- **Credential administration** (list / revoke / rotate devices, expiring pending offers,
  structured security logging).
- **Pinned-port fail-closed.** A pinned `--port` still falls back to an OS-assigned port on
  conflict.
- **Reconciling `webClientUrl` with reachability** under the loopback default.
- **State-schema rollback rules.**
- **Daemon log rotation.** `<data-root>/logs/daemon.log` grows unbounded.
