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

Process detachment is not service isolation. A daemon that orcad launches directly, and every
PTY it owns, remain in the same systemd service cgroup. `KillMode=mixed` does **not** preserve
them: it sends the graceful stop signal only to the main process, then sends `SIGKILL` to every
process remaining in the cgroup the moment that main process exits — `TimeoutStopSec` never gets
the chance to apply. `KillMode=control-group` is destructive too. `KillMode=process` leaves
service-owned processes unmanaged and is not a supported preservation mechanism.

Service-restart survival therefore requires a separately supervised cgroup, and orcad now asks
for one: on Linux it launches the daemon through `systemd-run --user --scope`, which places the
daemon and its PTYs in their own transient `orca-daemon-<launch-nonce>.scope` unit under the
user slice instead of the caller's service cgroup. A stop or restart of the service unit then
leaves that scope — and the live terminals in it — running, and the successor adopts the
endpoint as it always has.

A newly launched private daemon scope also follows the daemon's own lifetime. A small
detached shell holds an input pipe from the daemon; after that pipe closes and `/proc`
confirms the daemon PID is gone, it asks the user manager to stop that exact scope.
Systemd sends remaining processes SIGTERM and escalates after five seconds. This includes
children that double-forked or called `setsid` and can no longer be found by parent PID.
Disconnecting or restarting the runtime does not close the pipe: the daemon owns it.

The cleanup only arms on a fresh scoped launch with a matching launch nonce. Adopted
legacy scopes can contain GUI processes and are never armed retroactively. Unscoped
launches and children deliberately moved into another systemd unit remain outside this
cleanup. `nohup`, `disown`, and `tmux` alone do not move a process out of its cgroup, so
those children now end when their terminal daemon dies. Work intended to outlive that
daemon needs its own service or scope.

The scope is requested only where it can work. All of these must hold:

- **Linux with systemd as PID 1** (`/run/systemd/system` exists).
- **A reachable user bus** — a connectable `bus` socket in the per-UID runtime dir
  (`/run/user/<uid>`, or whatever `XDG_RUNTIME_DIR` points at). A unit whose
  `RuntimeDirectory=` hardening moves `XDG_RUNTIME_DIR` off the per-UID path is handled, because
  the real per-UID path is probed first.
- **`systemd-run` on `PATH`** and answering `--version`.
- **A user manager that outlives the login sessions** — lingering is on for the user
  (`loginctl enable-linger <user>`, recorded as a file in `/var/lib/systemd/linger/` named after
  the C-escaped user name, as logind writes it), or the launcher itself runs under that user's
  `user@<uid>.service` (an `app-*.scope` under `user@<uid>.service` or a `systemctl --user` unit;
  a plain `session-N.scope` login does not count). An open login session alone is not enough:
  without lingering, the user manager stops a few seconds after the last session closes and takes
  every scope it owns with it. When this is the only condition missing, the launcher logs one
  line, once per process: a `loginctl enable-linger <user>` hint, or, when the UID has no passwd
  entry or the linger dir cannot be read, that it cannot tell whether lingering is on.

Any of those missing, or a `StartTransientUnit` call that fails anyway, falls back to the
direct launch — and in that unscoped fallback case the paragraph above still describes reality:
the daemon shares the service cgroup and a combined-unit stop ends live terminals. Read the
`cgroupUnit` field in the daemon health payload to tell the two cases apart on a running host;
it is populated from `/proc/self/cgroup`, so it reports the isolation the daemon actually has
rather than what the launcher intended.

## `orca serve` on this machine

`orca serve` runs on the local orcad slot by default. The CLI asks the app's
`out/main/orcad/orcad-local-serve-selection-entry.js` (run as plain Node on the app's executable)
which host to use. Any reason orcad cannot serve falls back to Electron serve with one
`[serve] using Electron serve: <reason>` line on stderr. Those reasons are: no slot for this host,
no template in the install, the pinned Node could not be fetched, or a failed native preflight.

- `ORCA_SERVE_RUNTIME=electron` keeps Electron serve and skips the question. `orcad` (or unset) is
  the default, and any other value falls back with a reason.
- Packaged macOS stays on Electron: only Electron serve, supervised by the CLI, can take a remote
  app update there, and orcad has no updater. Recipe-JSON serve has no handoff and uses orcad.
- Windows serves on orcad too. Both hosts share `<userData>\daemon`, so the daemon pipe name
  (hashed from that path) is the same, and the relocated Electron daemon host changes only the
  executable, not the pipe. The `orcad-serve-mode-switch-windows` e2e job checks D7 there, in the
  daily run and on PRs routed to it; it does not block merges.

The slot and its pinned Node live under the desktop's `<userData>/orcad-artifacts`.

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

A host whose sshd refuses forwarding (`AllowTcpForwarding no`) is reached through the stdio
bridge instead: the client keeps the same local port, and each connection to it opens one SSH
exec channel running a small script on the host's pinned Node that dials orcad's loopback port.
Windows hosts run it as the host script's `stdio-bridge` op and frame bytes as base64 lines,
because a PowerShell DefaultShell re-decodes native output. Bridges are capped below OpenSSH's
default `MaxSessions` of 10 per connection; further connections wait for a free one. The choice
is made each time the tunnel starts (`orcad-managed-tunnel-transport.ts`), so nothing is
recorded per host, and only a host where even the bridge cannot run keeps the relay, recorded as
`ssh_tunnel_unavailable`.

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
permissions are not ours to fix. Windows has no owner or mode check, because ACLs are not
expressible as a POSIX mode and `statSync().mode` there reports a synthesized one. Instead
orcad restricts the root's ACL to its own user with `icacls` (the same verified restriction
`secure-file.ts` applies to credential files) and refuses with `orcad_data_root_shared` when
that cannot be applied.

A dead holder's record is reclaimed (PID plus process start time, so a recycled PID does not
read as alive). On Windows the start time is the kernel creation time read through the
process-tree addon the slot stages; without the addon it is null and the PID alone fences,
which errs toward "held". A record belonging to a different identity is never reclaimed.

**The lock scopes one role — who is the runtime.** It deliberately says nothing about the
daemon, which lives under `<data-root>/daemon` and fences its own endpoint with its own PID
record. A lock that asked "is any process using this root" would refuse exactly the restarts
a live daemon makes worthwhile.

## Supervision

### Process-scoped and cgroup-wide stops

The built-in remote updater performs a PID-scoped stop and keeps the daemon's install version
pinned while it owns sessions. A combined-unit systemd stop or restart is different: unless the
daemon holds a durable cgroup scope of its own (see
[Two long-lived processes, not one](#two-long-lived-processes-not-one)), it reaps the daemon and
every live terminal after the graceful window. Treat a stop as destructive unless
`health.terminalDaemon.cgroupUnit` names an `orca-daemon-*.scope` on that host.

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
- **Shutdown.** `SIGTERM` or `SIGINT` starts one graceful stop. Repeated signals share
  that stop because a supervisor may signal both the launcher and its child. A 15s deadline
  exits with code 1 if teardown stalls. The bundled runtime also stops gracefully if its
  launcher's IPC channel closes. On POSIX, both the launcher and runtime ignore `SIGHUP`,
  so terminal hangups do not stop a headless host. Use `SIGTERM` or `SIGINT` to stop it.
- **Stop requests.** A file stops orcad the same way `SIGTERM` does, without a PID that may
  since have been reused by another process:
  - `.orcad-stop-request` beside `orcad.js` in the running slot. orcad deletes it and stops.
  - An instance-bound request in the data root, named
    `.orcad-managed-stop-request.<sha256 of the instance lock nonce>`. orcad stops only when it
    names this orcad's version, runtime ID, PID, start time and lock nonce, and while the
    instance lock still holds that record. The file is kept as evidence.
  - `orcad --complete-managed-stop '<request JSON>'` writes that request, waits for the
    instance to exit, and prints one JSON line whose `verdict` is `live`, `unverifiable` or
    `exited`. `exited` needs proof: no process with that PID, or a PID whose start time shows
    it now belongs to another process. On `exited` it writes
    `<data-root>/orcad-stop-receipts/<transactionId>.json`. It exits 0 whenever it printed a
    verdict, 64 for a malformed invocation, and 1 for a failure before any verdict, which is
    never evidence of exit.
  - A request with `retireIdleDaemon: true` asks orcad to retire the terminal daemon too. This
    is best effort and never blocks or fails the stop:
    - The daemon is retired only when it proves it owns no live session across every
      generation.
    - A busy daemon (`live`) or one whose state cannot be proven (`unverifiable`) stays up with
      its terminals, and orcad reopens new-terminal admission before exiting.
    - The completed-stop receipt records `retirement` as `retired`, `live` or `unverifiable`.
      If orcad exits without recording an outcome, the receipt says `unverifiable`.
  - `orcad --cancel-managed-stop '<request JSON>'` withdraws a request orcad has not acted on.
    orcad and the canceller each try to create `<transactionId>.decision.json` exclusively,
    so exactly one wins. `canceled` means orcad keeps running and the request file is removed;
    `dispatched` means orcad already began stopping, and only the completion can say how it
    ended.
  - A build advertises all of the above with `health.stopRequests: 1` in its readiness line.
    Clients stop such a build through the slot request file and older builds with `SIGTERM`,
    after corroborating the PID with readiness either way. A launch clears a slot request
    that the previous process never consumed.
- **Decommissioning a managed slot.** An Orca client decommissions through the same activation
  journal and fence as deploy and rollback. It refuses while the terminal census reports live
  or uncounted terminals, stops the instance with a managed request that also asks to retire
  the daemon, and records that no version is active only after `exited` is proven. A stop
  that did not finish is cancelled; if orcad already acted on it, or the host cannot answer,
  the fence stays for recovery.
- **Instance lock.** `<data-root>/orcad.lock` names the running orcad. A record that is
  unreadable, malformed or over 64 KiB is never reclaimed: orcad exits 78 until an operator
  removes it. A shutdown whose teardown failed keeps the lock until the process exits, so a
  second orcad cannot start beside a writer that may still be running.
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
  [What is not covered](#what-is-not-covered). orcad records every trace span it emits
  (git commands, worktree paths, terminal spawns, structured-chat failures and the rest) to
  `<data-root>/logs/orcad.trace.ndjson`, rotated at 10 MB × 10 files, private to its user and
  redacted for secret-shaped strings. It stays on the host: a desktop's diagnostics bundle does
  not collect it. `ORCA_DIAGNOSTICS_DISABLED=1` turns it off, and a logs folder orcad cannot
  open leaves it off with one stderr warning rather than stopping orcad.

### orcad supervising the daemon

- **Launch.** On Linux, through `systemd-run --user --scope` so the daemon gets its own
  transient cgroup and survives a service-unit restart; everywhere else, and wherever that
  scope is unavailable, forked detached. Either way it runs `daemon-entry.js` beside
  `orcad.js` with its own PID record, token and socket under `<data-root>/daemon`.
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

After a PID-scoped stop, an adopted daemon stays resident so the next orcad can reattach. A
combined-unit systemd stop also leaves a scope-isolated daemon resident, but kills one that
fell back to the service cgroup. To retire a process-scoped deployment, apply the census rule
above, stop orcad, then stop the daemon named by `health.terminalDaemon.pid`.
Only report it `exited` after verification on the execution host; loss of contact is
`unverifiable`.

### Windows hosts

What differs on a Windows SSH host, and what deliberately does not:

- **Stop path.** A signal is TerminateProcess on Windows: no flush, no lock release. The
  slot's `.orcad-stop-request` file (and the managed, instance-bound request) is therefore the
  only graceful stop. A detached orcad receives no console control events, so the listener
  (`fs.watch` plus a one-second poll) is what stops it; the packaged-slot test proves it exits
  cleanly within the 15 s shutdown deadline on every server lane, Windows included.
- **Exit proof.** `--complete-managed-stop` proves a reused PID by the addon's creation time.
  Without the addon a live PID stays `live` or `unverifiable`, never `exited`.
- **Daemon endpoint.** The terminal daemon listens on a named pipe
  (`\\?\pipe\orca-terminal-host-v<protocol>-<suffix>`), not a socket under the data root.
- **Leaving sshd's job.** orcad is started outside the SSH session's kill-on-close job, so the
  daemon it forks inherits no such job and outlives the connection the same way.
- **Per-PTY jobs.** Each ConPTY child gets its own job (`windows-pty-job.ts`), and Git Bash /
  MSYS panes follow [`windows-msys-job-breakaway.md`](./windows-msys-job-breakaway.md)
  unchanged. A ConPTY smoke test runs inside a process started exactly that way (breakaway,
  no window) on the Windows server lanes.
- **No daemon-host relocation.** The desktop copies its runtime to `%LOCALAPPDATA%` because
  the NSIS updater deletes the install directory under a running daemon
  ([`windows-daemon-host-relocation.md`](./windows-daemon-host-relocation.md)). orcad slots are
  versioned directories that nothing deletes while a process runs from them: Windows refuses
  to delete a running image, and GC treats an in-use slot as live.

## Idle exit (client-managed orcad only)

An orcad that a desktop client launched over SSH stops itself, like the relay, once its host has
been unused for 15 minutes. The client's launch sets `ORCA_ORCAD_MANAGED_ACTIVATION_ROOT`; an
orcad started by hand, by a supervisor, or as a paired server never carries it and never idles
out.

"Unused" means every one of these held on every check for the whole period:

- no client socket open and no RPC request running;
- no terminal in the PTY provider, and the daemon answered with zero live sessions (a daemon
  that does not answer keeps orcad up);
- no agent reporting `working`;
- no staged migration into this server;
- no enabled automation and no automation run still in flight (nothing on the host would start
  orcad again for the next scheduled run, so a server with an enabled automation never idles out);
- no activation fence on the host (an update, rollback, decommission or recovery in flight).

The stop is the ordinary graceful shutdown, which disconnects from the daemon and never shuts it
down, so it cannot kill a terminal. It then asks the daemon to retire only if the daemon itself
proves it holds no session. Before stopping, orcad writes `<data-root>/orcad-idle-stop.json`;
the next start reports it once as `health.previousIdleStop` and removes it, so a later crash is
never read as an idle stop. A managed start with no record reports `previousIdleStop: null`.

The client starts a stopped server again, whatever stopped it (an idle stop, a kill, a host
reboot): on every connect, on every fresh tunnel (including after the client wakes from sleep),
and before a call through an environment the client restored at launch. A server that does not
answer is checked on the host; only a proven exit starts the activated slot, under the activation
fence, and the status line shows "Starting managed server…". A daemon that survived is adopted
with its terminals; after a reboot both start fresh. A process that is live or cannot be proven
gone is left alone, and a start that fails keeps the host managed with the reason and orcad.log's
tail, never as a verdict about its terminals. `ORCA_E2E_ORCAD_IDLE_TIMEOUT_MS` shortens the idle
period for tests; the client forwards it to the servers it launches.

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
- **Supervision of an unscoped fallback daemon.** When the durable `systemd-run --user --scope`
  launch is unavailable (see [above](#two-long-lived-processes-not-one)) orcad and its daemon
  share one service cgroup, and a combined-unit stop cannot preserve live terminals. There is
  no mechanism that re-isolates such a daemon after the fact.
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
