# Running orcad

`orcad` is the headless Orca runtime. Managed installs run from their slot-local pinned Bun
executable; host Node is considered only when rolling back to a complete pre-Bun slot whose native
dependencies pass a load probe. This is the contract between orcad, its terminal daemon, the managing
desktop, and any external supervisor.

## Two long-lived processes, not one

A deployment is **orcad** plus **the terminal daemon**.

|            | orcad                            | terminal daemon                       |
| ---------- | -------------------------------- | ------------------------------------- |
| Started by | the desktop or supervisor        | orcad, detached                       |
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
| `orcad_instance_lock_unreadable`       | the existing lock cannot safely identify its holder           |
| `orcad_data_root_unusable`             | the root cannot be created, stat'd or written                 |

A root that is merely too permissive and that we own is tightened to `0700` rather than
refused — orcad stores credentials there unsealed (no OS keyring on this host), so the goal
is a private root, and refusing when we could just fix it helps nobody. We refuse when the
permissions are not ours to fix. Windows is exempt from the owner and mode checks: ACLs are
not expressible as a POSIX mode, and `statSync().mode` there reports a synthesized one.

A dead holder's record is reclaimed (PID plus process start time, so a recycled PID does not
read as alive). A record belonging to a different identity is never reclaimed. Malformed,
oversized, or unreadable records fail closed: the operator must first stop orcad and then remove
the stale lock, because an unreadable record is not proof that its holder has exited.

Startup failure and normal shutdown unwind acquired runtime resources before releasing the lock.
Cleanup attempts every registered step even if an earlier step fails. If any cleanup fails, the
lock remains held until the process exits; failure is not permission for a second runtime writer.
The terminal daemon is disconnected, not killed, during this cleanup.

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

The managed flow launches orcad detached over SSH and records the exact slot PID. A manual deployment
may instead use systemd, launchd, or another process manager. orcad conforms to either model:

- **Readiness.** One JSON line on stdout (`--json`), `type: "orca_server_ready"`, published
  after the listener is bound and the daemon verdict is in. There is no separate readiness
  socket; the line is the signal. Set the supervisor's start timeout generously — the daemon
  launch has its own retries and can take tens of seconds on a cold host.
- **Shutdown.** `SIGTERM` or `SIGINT` starts a graceful stop. Managed lifecycle writes the
  slot-local `.orcad-stop-request` on every platform so a stale, reused PID can never direct a
  signal at an unrelated process. The runtime consumes that request through the same graceful
  path. A **second** signal exits
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
  `ORCA_DIAGNOSTICS_DISABLED=1`). The daemon log rotates at 5 MiB and retains
  `daemon.log.1` and `daemon.log.2`; logging failures disable that sink without affecting
  terminal service.

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

### Managed decommissioning

Ordinary orcad shutdown deliberately disconnects from the daemon without killing it. Managed
**Stop and unlink** is different: it must retire an idle daemon and must not race a terminal created by
another paired client.

The managing desktop therefore does not trust a separate “zero sessions” census followed by stop.
While holding the host activation fence it asks the running orcad for `orcad.decommissionIfIdle`:

1. orcad fences new adapter spawns and refuses if a create/attach is already in flight;
2. every compatible current or preserved daemon generation must supply authoritative zero-session
   inventory;
3. each daemon executes `shutdownIfIdle`, which atomically fences daemon admission and accepts only
   with no live sessions and no competing daemon transport; and
4. orcad keeps its adapter fence closed after acceptance or any ambiguous partial retirement.

The verdict vocabulary stays exact:

| Verdict        | Required host evidence                                                           |
| -------------- | -------------------------------------------------------------------------------- |
| `live`         | positive daemon inventory counted one or more live terminal sessions             |
| `unverifiable` | inventory, compatibility, admission, transport, or contact was not proved        |
| `exited`       | the SSH execution host positively confirmed the recorded orcad process is absent |

Before the request, the client writes a prepared decommission transaction and sends its transaction
ID. A receipt-capable orcad atomically writes the version-bound `decommissioning` marker to
`~/.orca-remote/orcad-active.json` before acknowledging that exact ID. The client then records the
admission-fenced and process-exited phases around the graceful stop request. If the RPC response,
contact, or local cleanup is lost, recovery resumes from that host-owned receipt and transaction; it
does not reopen terminal admission or reinterpret silence as exit. After confirmed exit the record is
deactivated, then the client closes the tunnel, retires runtime and browser transports, clears the
browser partition, releases SSH-target ownership, and removes the managed environment. A failed cleanup
leaves the environment linked for retry.

Stop/unlink is refused while that environment is the desktop's Active Server. Choose another Active
Server first. Do not manually signal daemon PIDs or delete the data root as a substitute for this
contract; either action bypasses the evidence and retry boundaries.

## Managed updates and rollback

Managed deploy, update, rollback, and stop/unlink are production runtime-environment APIs surfaced in
Settings → Remote Orca Servers. The SSH registration is exclusively claimed by its managed environment,
so the same target cannot simultaneously act as a direct SSH runtime.

Activation is serialized by a host-wide lock. For an existing runtime it positively stops orcad before
capturing shared state, so the archive is quiescent. If capture fails, the candidate is not launched and
the incumbent is restarted and health-gated. A candidate launch exception or rejected readiness also
restores the incumbent state and health-gates the active runtime before releasing the fence. Candidate
readiness must prove bundle identity and terminal-daemon health before the activation record changes.
The readiness file is bounded and schema-validated; activation also requires the exact managed loopback
port, runtime kind, PTY backend, build hash, and runtime-scoped pairing offer. A complete malformed
readiness line fails activation instead of polling indefinitely.

For a new Bun candidate, the daemon must also report `runtimeKind: bun` and
`ptyBackend: bun-terminal` from its own health probe. This prevents a Bun orcad process from
silently accepting a Node-owned daemon after a mixed-version restart; older daemons remain readable
for rollback and compatibility paths.

Activation writes its prepared transaction before the first mutation and advances it through
incumbent-stopped, snapshot-captured, and candidate-ready phases. Rollback separately journals
incumbent-stopped, rescue-captured, rollback-state-restored, and target-ready. Settings displays the
interrupted operation/phase and replaces ordinary mutation controls with Recover.

The activation fence cannot be reclaimed merely because it is old. After the 20-minute recovery window,
Recover may take the fence only to compare the current activation record with both journaled sides,
prove candidate quiescence before state restoration, and health-gate the runtime it keeps. An unreadable
or inconsistent journal, changed record, unproved quiescence, or failed health gate remains
`unverifiable` and fenced for operator inspection. Ordinary incomplete install locks keep their bounded
stale-takeover behavior.

When no managed activation record exists, the host first checks `orcad.lock` and `orca-runtime.json`.
A live owner or an unreadable, malformed, non-regular, or oversized record refuses first activation;
force cannot bypass ownership. This prevents a rejected Bun candidate from restoring over an
unmanaged runtime that is still writing the shared data root.

Managed slots use one safe SemVer-compatible version rule for install, activation records, inventory,
and GC. Prerelease/build versions such as `1.4.178-rc.2+abcdef123456` remain visible after installation.
Update and rollback refuse while a durable `decommissioning` marker exists, even when forced, so a
partially retired host cannot be silently reactivated.

GC first renames a removable slot to a strict model-owned tombstone. Relay and orcad clean only their
own tombstone names, and those names are excluded from the version-directory classifier so interrupted
cleanup cannot be reclassified as an installed slot.

Rollback requires the recorded snapshot, a trustworthy snapshot-presence verdict, and proof that no
live terminal started after activation. A Bun slot uses its bundled runtime. A pre-Bun slot uses host
Node only after `node-pty` resolves and loads from that slot; an incomplete or ineligible slot is refused
before launch. After the active runtime stops, rollback captures current state in a unique durable
rescue directory. It extracts and validates the old archive in staging before removing live profile
members. Restore failure or an unhealthy old runtime restores the rescue and restarts the active
runtime. An interrupted rollback uses the durable rescue verdict and last phase to perform the same
safe restoration; `unverifiable` recovery retains the activation fence.

### Workload conversion is not migration

Managed Node→Bun update preserves daemon-owned terminals because the daemon stays on the same host and
is adopted by the new orcad. Other execution models have different owners and are intentionally
refused:

- direct-SSH repository/folder rows are client control-plane state;
- direct-SSH terminals belong to the relay and cannot transfer their PTY identity to orcad;
- independently paired runtimes have no managed activation transaction to adopt; and
- local Electron workloads remain desktop-owned.

Do not delete workspace rows or terminate work merely to make the SSH target claimable. Settings
preflights the selected target and lists exact persisted repositories, folder workspaces, non-final
relay PTY leases, and saved forwards. That inventory is read-only: it does not contact the execution
host or establish `exited`.

Managed deployment can durably fence an idle direct-SSH source, stage its bounded static catalog without
publication, commit it with an exact host receipt, and reconcile lost replies. The optional dormant
payload also carries worktree metadata, lineage whose two ends are in scope, sparse presets, and
repo/path retirement registries. It also carries inactive owner-scoped session/tab/layout rows only
when they contain no PTY ID, browser profile, external runtime/file route, or active selection. Dormant
source-partition focus scalars are carried when they reference captured entities and are re-keyed to
the destination-local host. Inline
and stored scrollback bytes transfer through bounded content-addressed snapshots whose references
publish only after exact bytes are durable; source files retire only after the destination receipt.
Dormant sleeping-agent records transfer only when their provider resume identity stays on the same host
and their authority can rekey to destination-local ownership; cross-target, orchestration-fenced, and
missing-pane records remain blockers. Disabled SSH-owned automations also transfer when their entire
retained history is final; they are rekeyed to destination-local execution and scheduler ownership
while historical terminal IDs and output snapshots remain intact. Enabled, in-flight, duplicate,
cross-host, malformed, or externally routed automation state remains a blocker. Representable mobile
selections and UI routing transfer with exact destination conflict checks. Durable client-hosted browser
page rows transfer when their browser workspace is in the captured session; the owner map is rekeyed but
the browser workspace id is preserved, and duplicate or out-of-scope page references fail closed. Saved
forwards remain owned by the fenced source target without opening duplicate listeners. Source drift keeps
the fence;
receipt-gated retirement removes only exact captured source keys and retains shared source namespace
tombstones. Recoverable sessions, main-owned terminal recovery, cross-scope lineage, leases, and
unsupported client projections remain blockers. Older desktops keep the target fence and journal but cannot resume its phases; if they
strip the environment link during a rewrite, current code repairs it on re-upgrade only after exact
endpoint, owner, and generation proof. A `live` or `unverifiable` relay PTY still blocks conversion.

Release SSH relay packages are strict Bun bundles. They carry libc-specific Linux runtimes and
target-native watcher binaries; deployment verifies the exact runtime before launch and does not
require system Node, npm, or a remote compiler. Node is consulted only when reconnecting to a legacy
relay slot that predates bundled Bun.

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
runtimeKind / runtimeVersion   bun + pinned Bun version for managed slots (optional for skew)
ptyBackend                    bun-terminal for Bun slots (optional for skew)
libc / glibcVersion           Linux slot libc and observed glibc version when available
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
  runtimeKind / runtimeVersion  runtime reported by the daemon process itself (optional for skew)
  ptyBackend                    backend selected by that daemon (`bun-terminal` or `node-pty`)
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

The same health object is available through the authenticated `orcad.health` JSON-RPC method.
Results and concurrent probes share a five-second cache so a supervisor cannot create unbounded
daemon PTY self-test churn. `status.get` separately includes optional `degradations[]` entries for
unavailable browser and terminal capabilities; absence means no reported degradation.

## Disposable SSH lifecycle acceptance

Run `pnpm smoke:orcad-ssh` with Docker running. It builds the matching Linux Bun artifact
and provisions a Debian SSH host without Node/npm; the test checks their absence over SSH
before deployment. Set `ORCA_REVIEW_ORCAD_ARTIFACT_DIR` to a fresh output directory to retain
the artifact without replacing the default `out/orcad-ssh-lifecycle` build.

The test covers real terminal input, daemon survival, half-open and disconnected SSH recovery,
interrupted activation/rollback, fresh input after update/rollback, identity-bound live-stop
refusal/cancellation, lost decommission acknowledgment and completed-stop retry. Terminal
probes require standalone output lines rather than matching echoed input. This does not prove
live ownership transfer from an incumbent direct-SSH relay, the Linux glibc floor, or other
platforms; those require separate acceptance runs.

## What is not covered

Named here so nothing reads as implemented that is not:

- **An unauthenticated HTTP health endpoint.** Periodic health exists only as authenticated JSON-RPC;
  supervisors that cannot hold a pairing credential must use the readiness line and process state.
- **Headless credential administration.** The desktop runtime can list and revoke its own mobile and
  runtime grants, and offer creation can rotate pending grants, but orcad exposes no operator CLI/RPC
  for listing, revoking, expiring, or security-auditing credentials on the unattended host.
- **A hosted web client.** orcad does not configure a static web-client root and therefore advertises
  `webClientUrl: null`; managed clients connect through the SSH tunnel with the pairing offer.
- **A state schema version.** Managed rollback is safe through a quiescent pre-activation snapshot,
  but the persisted store itself still carries no schema version.
- **Universal workload migration.** Managed Node→Bun upgrades and the bounded direct-SSH catalog plus
  dormant metadata/inactive-session/scrollback/sleeping-agent/settled-automation tranche are covered.
  Main-owned terminal recovery, unsupported client projections, and live PTY ownership—and independently
  paired or local desktop ownership—cannot yet be imported universally.
- **Systemd-isolated daemon supervision.** orcad and its daemon currently share one service
  cgroup, so a combined-unit stop cannot preserve live terminals.
