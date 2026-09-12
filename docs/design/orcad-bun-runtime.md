# Bun-backed orcad

September 6 integration evidence: updated against main `a567e33bf7d`, with startup and runtime
wiring ported into main's extracted modules. Strict SSH/WSL release bundles build successfully.
The macOS Bun restart and Node→Bun→Node lifecycle checks preserve PTYs and scrollback; the real
Linux arm64 SSH lifecycle preserves a live PTY through managed update and rollback. Native watcher,
SQLite, WebSocket resource bounds, and mixed-version terminal wire checks pass. This evidence covers
the agreed managed switchover slice; the universal ownership-transfer mutation gate remains disabled.

**Status:** the managed Bun runtime, managed Node→Bun upgrade path, and durable recovery for interrupted
activation, rollback, and stop mutations are complete in this worktree. Overall release remains
conditional on physical Windows execution, routed DNS/suspend and soak-promotion evidence, and
rebuilding after this dirty worktree is reconciled. The reproducible current-source eight-target matrix
passes independent native-format and content verification. Disposable real-SSH driver and rendered
Settings lifecycle runs pass, including production SSH reconnect, exact-port tunnel reconstruction,
and visible stale-transaction recovery while a Bun daemon-owned PTY stays `live`. Universal live
migration from direct SSH, independently paired runtimes, or the local desktop is not implemented. A
bounded static-catalog transaction layer now durably fences the source, stages without publication,
commits with a durable receipt, reconciles lost responses, and is invoked by managed deployment. Its
additive dormant-state payload now transfers worktree metadata, in-scope worktree/workspace lineage,
sparse presets, repo/path retirement registries, inactive session/layout records without process,
browser-profile, or active-routing authority, bounded scrollback snapshots and references,
destination-local sleeping-agent resume records, dormant source-partition focus, disabled SSH-owned
automations whose retained runs are all final, representable mobile/client routing state, and
client-hosted browser close intents re-keyed to the destination environment. Saved forwards remain durably owned by
the fenced source target, with duplicate-port checks and no second listener. Main-owned live terminal
recovery, enabled/in-flight or externally routed automations, ambiguous markdown frontmatter IDs,
and every `live` or `unverifiable` PTY remain fail-closed blockers. Stale markdown entries that no
longer name an open file are omitted safely. Global browser URL history stays client-owned.

The first live-continuity increment is now implemented as shared `PtyOwnershipBridge` framing/state
logic. It negotiates protocol and safety capabilities, preserves stable terminal identity, bounds
sequenced replay and input-deduplication memory, rejects output gaps and changed duplicate inputs,
and makes commit/abort idempotent for lost-response recovery. Its durable companion journal now
requires an explicit, exact source-end cursor and destination publication receipt before source
retirement; cursors can only advance monotonically while prepared. A transport-independent
destination adapter now durably stages ordered replay, validates exact commit/publication receipts,
deduplicates input across reconnects, and enforces contiguous post-commit output through a bounded
store contract. A crash-safe profile sidecar now implements that contract with bounded recovery and
fsynced atomic mutations, and explicitly truncated replay fails before durable advancement. The relay
`PtyHandler` exposes an exception-contained observer seam for post-ingress output and single-path
terminal retirement; `RelayRuntimeServices` attaches the source adapter to that seam in a dormant,
fail-closed mode. Its owner-private journal is persisted beside the relay endpoint and reconstructed
with bounded validation on restart. The additive status and authenticated source-grant RPCs are
registered, while transfer mutation remains canary-gated and fail-closed; `liveTransfer`, destination
control, and authoritative-exit capabilities remain false by default. A production direct-SSH
preflight/status gate is wired through
runtime IPC and preload, but it deliberately refuses transfer until destination construction,
acknowledged output/input/control routing, and paired/local ownership paths are complete.

The destination runtime now has a canary-gated paired coordinator-construction seam. Construction
requires both paired unary and source-stream transports, the durable destination registry, exact
`remote:` environment/terminal identity, tracked incarnation and surface binding, and a fresh
capability preflight; the release gate is checked again immediately before source preparation. No
product caller invokes this seam while the gate is closed. The built relay smoke also exercises a
detached Bun companion-process path for watcher and AI-vault IPC, managed-hook loading, reconnect,
and teardown.

Remote `terminal.send` now carries an optional stable operation identity through the unary fallback. The
runtime retains a bounded, incarnation-scoped receipt for accepted payloads, rejects conflicting reuse,
shares concurrent first attempts, and clears receipts on PTY generation changes. Settled agent-prompt
delivery uses the same receipt and derives stable per-chunk and submit identities for capable providers.
This closes duplicate writes after a lost RPC response while the runtime survives without treating queue
admission or an unverified transport outcome as settlement.

The local read-only ownership source now reconciles the installed provider before runtime publication and
automatically starts a new exact reconciliation whenever the daemon provider generation is replaced.
Reconciliation deactivates prior authority immediately and restores only durable fences whose terminal,
incarnation, lease, and provider inventory match. The dormant mutation adapter refuses to advertise live
transfer without a separate owner-authorization seam and rechecks the caller connection generation before
every operation. Production composition remains observation-only: local transfer mutation, destination
control/output, and authoritative exit are still unavailable until the explicit canary gate is enabled
with end-to-end evidence.

## Decision

Ship a checksum-pinned Bun executable inside each content-addressed orcad install slot and run both
`orcad.js` and the terminal daemon with it. Use `Bun.Terminal`, `bun:sqlite`, and the Bun-native
WebSocket adapter; do not make host Node or the current `node-pty` ABI part of a new Bun slot.

Use the ordinary Bun executable plus the existing JavaScript entrypoints, not `bun build --compile`.
orcad needs independently forked children, versioned daemon adoption, transparent content hashing,
and rollback to older JavaScript. A slot-local runtime keeps that boundary inspectable.

## Current evidence

Historical exact artifacts passed on physical darwin-arm64 and Linux x64 glibc. All eight current-source
target directories were built twice and independently checked for required files, content version,
pinned runtime checksum, native runtime and watcher format, architecture, libc loader, and optional
browser inventory. The current darwin-arm64 artifact also passed the exact bundled lifecycle. Windows
x64/arm64 execution is still `unverifiable`; generated PowerShell, FFI, ConPTY job ownership, and
command-line contracts have deterministic coverage but not host-owned physical evidence.

The implementation proves:

- Bun RPC readiness, repo/worktree RPC, terminal input/output/resize, restart survival, daemon
  reattachment, and scrollback replay;
- production SSH transport reconnect, exact persisted tunnel-port reconstruction, and continued input
  on the same daemon PID and terminal handle after accepted sshd transports are killed;
- target-native `@parcel/watcher` events and synchronous `bun:sqlite` access;
- POSIX output backpressure through bounded process-group suspension;
- bounded Bun WebSocket admission, payload, send-buffer, heartbeat, and proxy teardown;
- pending-upgrade admission reservations and post-shutdown upgrade rejection, plus build-keyed
  health-probe coalescing for mixed-version supervisors;
- target-aware packaging and launch on macOS, glibc Linux, musl Linux, and Windows; and
- production Settings and IPC flows for managed deploy, update, rollback, and guarded stop/unlink;
- exact activation of the managed loopback port, build, Bun runtime, `bun-terminal` backend, daemon
  health, and runtime-scoped pairing offer; and
- authenticated cached health reporting with Linux libc and daemon PTY self-test evidence.

See [`orcad-bun-handoff.md`](./orcad-bun-handoff.md) for exact artifact identities, test evidence, and
the physical Windows checklist.

## Shipping shape

Each install remains self-contained:

```text
orcad-<version+hash>/
  bun-runtime
  orcad.js
  daemon-entry.js
  parcel-watcher-process-entry.js
  parcel-watcher-entry.js
  node_modules/@parcel/watcher/index.js
  node_modules/@parcel/watcher/watcher.node
  agent-browser-<platform>-<arch>  # optional where upstream publishes it
  .version
  .install-complete               # written by the remote installer, last
```

Build and deploy rules:

1. Pin one Bun release asset and SHA-256 for every supported target. Never download `latest` during
   build or activation.
2. Include the runtime and every required file in the content hash. Write `.install-complete` only
   after remote verification succeeds.
3. Launch `<slot>/bun-runtime <slot>/orcad.js`; never consult `PATH` for Bun or Node.
4. Fork bundled children with the slot-local `process.execPath` and retain detached daemon semantics.
5. Keep runtime health additions optional for mixed-version clients. Backend identity is diagnostic
   metadata, not a terminal stream opcode; new Bun activation additionally requires the daemon's
   own identity proof.
6. Hash and copy release-scale artifacts asynchronously while retaining byte-for-byte cache validation.

### SSH relay packaging

Managed and newly created relay workloads ship with a checksum-pinned, target-native Bun companion;
release builds run `build:relay:release`, which materializes all eight Bun targets and invokes the
relay builder with `ORCA_REQUIRE_RELAY_BUN_RUNTIME=1`. Linux packages carry separate glibc and musl
executables and target-native watcher binaries. The deploy path detects the remote libc, verifies the
exact Bun version after upload/reconnect, and never probes Node, npm, or compiles native dependencies
in strict mode. Bun owns credential generation, relay launch/reconnect, readiness probes, and relay
GC liveness checks. The watcher loader prefers the runtime's libc report (or launcher hint) before a
compatibility fallback.

The same strict release policy applies to WSL guest hook and browser-network relays. Their Windows-side
bundle carries x64/arm64 glibc/musl Bun companions and a Bun-required marker; the guest launcher selects
the exact native variant (or an already-installed Bun at the pinned version) and exits with the existing
unavailable code if none can run. It does not probe `node`, `npm`, or a distro package manager. Bundles
without the marker remain the documented legacy/developer compatibility path and may use Node 18.

Ordinary developer relay builds remain Node-compatible for mixed-version testing. Node is retained
only as the fallback for legacy relay slots that predate bundled Bun; newly shipped strict packages
fail closed if their exact runtime is missing or mismatched. Durable dormant-state migration remains
lossless, while active PTYs that cannot be adopted continue draining under their existing owner.

## Runtime and PTY contract

| Required behavior              | Bun implementation                                           | Evidence state                          |
| ------------------------------ | ------------------------------------------------------------ | --------------------------------------- |
| spawn with cwd/env/cols/rows   | `Bun.spawn({ terminal })`                                    | physical macOS/Linux                    |
| input/output/resize/exit       | `Bun.Terminal`, streaming `TextDecoder`, `subprocess.exited` | physical macOS/Linux                    |
| POSIX pause/resume             | exact PTY process-group `SIGSTOP` / `SIGCONT`                | bounded physical probes                 |
| Windows pause/resume           | suspend exact per-PTY job members, fail closed if incomplete | injected native tests; physical pending |
| Windows ownership              | daemon host job plus one nested job per PTY                  | injected native tests; physical pending |
| recursive termination          | owned process group/job, no unscoped process-table fallback  | deterministic; Windows physical pending |
| shell-ready without slave path | existing readiness fallback                                  | automated lifecycle coverage            |
| native file watching           | isolated target-native watcher child                         | physical macOS/Linux                    |

Windows remains a release evidence gate because Bun's public terminal object does not expose the
patched `node-pty` job handles. Orca supplies ownership with `bun:ffi`, but the real kernel structure
layouts, ConPTY behavior, Unicode/hostile argv, flood suspension, descendant cleanup, and normal
background-child survival must still run on physical Windows hosts.

## Updates, rollback, and state

The runtime slot and the terminal daemon have different lifetimes. orcad stops during update or
rollback; the detached daemon survives when it owns live sessions. New orcad adopts that daemon, so
no live PTY moves between backends and an outgoing bundle remains pinned while its daemon entrypoint is
load-bearing.

State is shared across versions and has no schema version. Activation therefore:

1. plans from a host terminal census;
2. positively stops the incumbent;
3. captures the now-quiescent shared state;
4. launches and health-gates the candidate; and
5. records active, previous, activation time, and snapshot atomically.

If the post-stop snapshot fails, the candidate is not launched and the incumbent is restarted. A
rollback restores that snapshot only when its presence is proven and no live terminal began after the
activation it predates. Before destructive rollback, current state is captured in a durable rescue
snapshot. The old archive is fully extracted into staging before live state is removed; a failed
restore, candidate launch exception, or unhealthy rollback target restores the rescue and restarts the
active runtime. Both the restored state and the relaunched runtime must pass their health gates. If
that recovery cannot be proven, the host activation fence remains held.

Before its first mutation, activation writes a durable host transaction and advances it through
prepared, incumbent-stopped, snapshot-captured, and candidate-ready boundaries. Rollback uses its own
prepared, incumbent-stopped, rescue-captured, rollback-state-restored, and target-ready phases. Once a
retained activation fence reaches its recovery age, the explicit recovery path compares the current
activation record with both durable sides, proves candidate quiescence before restoring state, and
health-gates the runtime it keeps. Settings shows the interrupted operation/phase and exposes Recover.

The activation fence is not an ordinary stale install lock. Age permits the recovery protocol to take
the lock; it does not permit blind takeover. An unreadable or inconsistent journal, changed activation
record, unproved quiescence, or failed runtime health gate remains `unverifiable` and fenced. Ordinary
incomplete bundle installs still use bounded stale-lock takeover.

First managed activation also probes the existing instance lock and runtime metadata before snapshot
or launch. A `live`, malformed, oversized, or otherwise `unverifiable` owner record refuses conversion,
and force does not bypass the refusal.

Every candidate and recovery launch passes the same bounded readiness gate. It requires the exact
managed loopback port, content build hash, slot runtime, PTY backend, daemon self-test, and matching
runtime-scoped pairing offer. Complete malformed JSON is a failure, not a reason to poll forever, and an
older runtime that silently binds a fallback port is rejected.

Runtime selection is slot-scoped. A Bun slot always uses its executable `bun-runtime`. Host Node is a
rollback fallback only for a complete pre-Bun slot, and only after `node-pty` resolves and loads from
that slot. An incomplete or native-ineligible legacy slot is refused before launch.

Install, activation, inventory, and GC share one safe SemVer-compatible version rule, including
prerelease/build versions. A durable `decommissioning` marker blocks update and rollback, even when
forced, until managed retirement finishes or is explicitly recovered.

GC renames a removable slot to a strict model-owned tombstone before deletion. Relay and orcad passes
recognize and clean only their own tombstone names, and tombstones are excluded from the version-dir
classifier so a failed cleanup cannot later be mistaken for a live install.

## Workload migration boundary

This lifecycle upgrades an already managed orcad slot without moving its daemon-owned PTYs. It does not
transfer control-plane ownership between Orca execution models:

- a direct-SSH repository or folder workspace remains client-owned and its relay PTY cannot be adopted
  by the orcad daemon;
- an independently paired runtime has no activation record or managed SSH ownership to transfer; and
- local Electron workspaces and terminals remain owned by the desktop runtime.

Settings and the SSH claim gate now share one structured preflight with stable blocker codes and exact
repository, folder-workspace, non-final PTY-lease, and saved-forward identities. Static rows are labeled
drainable, while attached or detached leases remain `live` or `unverifiable`; the local record cannot
establish `exited`. The preflight is bounded and read-only, and claim remains fail-closed. Ending
terminals or deleting workspace rows is not a migration mechanism. Product deployment now invokes the
transactional static cutover only when this census proves every dependency is represented.

The safe static-transfer lower layer exports the exact target repositories, inherited or explicit
folder workspaces, referenced project groups, group ancestry, worktree metadata, in-scope lineage,
sparse presets, and retirement registries into a bounded v1 manifest. Before remote mutation, the
desktop claims the target and durably records that exact manifest in a bounded source journal. The
authenticated host verifies its digest and every ID, path, scope, count, size, and destination conflict
before persisting a dormant stage that publishes no rows. Commit publishes catalog, dormant state, and
a bounded idempotency receipt in one durable generation. Exact destination status reconciles lost
stage, commit, and abort responses; committed state cannot be aborted. Old manifests without the
optional dormant payload remain valid, while a host that strips a present extension cannot satisfy its
digest. An exact target-scoped census discounts a represented dormant class only while its source
projection still matches byte-for-byte. Owner-scoped inactive session records reuse the profile-transfer
projection and merge into the destination-local session only when IDs do not collide; PTY IDs,
browser profiles, external runtime/file routing, and active selections remain on the source and block.
Inline and stored scrollback become bounded content-addressed snapshots; exact chunk acknowledgements,
digest/conflict checks, durable publication, restart recovery, and receipt-gated source deletion keep
bytes and references together. Dormant sleeping-agent records retain provider resume identity and
same-host transcript paths while worktree and connection authority rekey locally; cross-target,
orchestration-fenced, or missing-pane records block. Disabled SSH-owned automations transfer only when
their complete retained run history is final; execution targets, scheduler ownership, workspace IDs,
and execution contexts rekey to the destination-local authority while historical terminal IDs and
output snapshots remain intact. Enabled, in-flight, duplicate, cross-host, malformed, or externally
routed automation state remains on the source and blocks. Representable mobile selections and routing
records transfer with exact destination conflict checks. Durable client-hosted browser page rows also
transfer when their browser workspace is captured, preserving the browser workspace id while rekeying
only the owner map; duplicate page identities and rows that reference an uncaptured browser workspace
fail closed. Saved forwards remain on the fenced source target. Dormant source-partition focus scalars
now transfer with the session when they reference only captured entities. A stale consumer-recovery row
or shutdown reconnect hint no longer blocks once all source leases and persisted PTY references are final;
the census still refuses main-owned live terminal recovery, cross-scope lineage, leases, and other
unsupported projections. After exact committed evidence, static source retirement removes only captured source keys, preserves other-host
rows, shared group ancestry, and shared source namespace tombstones, retains the ownership fence, and
retries durably. This remains deliberately integrated with deployment: environment registration,
tunnel routing, destination reconciliation, and source retirement reuse one environment identity,
while any unrepresented state refuses before remote mutation and again before retirement.

## Managed stop and unlink

A separate terminal census followed by process stop is racy: another paired client could create a
terminal between them. Managed unlink instead calls a host-side atomic decommission contract.

The running orcad fences adapter admission, rejects in-flight creation, and asks every compatible
daemon generation to execute `shutdownIfIdle`. That daemon primitive fences its own admission and
accepts only with zero live sessions and no competing transport. Outcomes remain exact:

- `live` — the host positively counted live terminal sessions;
- `unverifiable` — inventory, admission, daemon compatibility, transport, or contact was not proven;
- `exited` — the SSH execution host positively confirmed the recorded orcad process is absent.

Before requesting atomic acceptance, the SSH lifecycle writes a prepared decommission transaction and
sends its transaction ID. A receipt-capable orcad atomically writes the accepted decommission record
before acknowledging that exact ID. The lifecycle then records admission-fenced and process-exited
phases around the graceful stop request. A retry can resume from the journal and accepted record without
reopening terminal admission or guessing whether a lost RPC response took effect. Only then does the
client close the tunnel, retire transport/browser state, release SSH ownership, and remove the
environment. Cleanup failure leaves the link retryable.

All platforms request that exit through the slot-local `.orcad-stop-request`. POSIX does not signal a
PID-file PID, because a reused PID is not proof of orcad identity. The runtime consumes filesystem-watch
delivery with a one-second poll fallback.

## Mixed versions

The migration adds optional health and activation-record fields plus additive authenticated JSON-RPC
methods: `orcad.health`, `orcad.terminalCensus`, `orcad.decommissionIfIdle`, and dormant
`orcad.migration.stageCatalog`, `commitCatalog`, `abortCatalog`, `catalogState`, and legacy
`importCatalog`. The decommission request/response transaction ID is optional, so older
peers safely ignore or omit it; only a matching receipt is used as proof. Old clients ignore new record
fields, and a new client talking to a server without atomic decommission refuses unlink as
`unverifiable`. No terminal stream opcode was added. The existing output-pause opcode remains
capability-negotiated because old decoders silently drop unknown opcodes.

The direct-SSH migration preflight is additive desktop IPC only. It does not change paired-runtime,
relay, terminal-stream, or mobile contracts. The catalog RPCs are absent from the mobile allowlist.
Their new method names make older runtimes return method-not-found without accidentally performing the
legacy immediate import. The optional source journal is profile-persisted; an older build keeps the
existing target-owner fence and unknown top-level journal even though it cannot resume the transaction.
Its environment-store schema strips `orcadDeployment` during a rewrite. On re-upgrade, current code
keeps the same-ID environment visible as resumable and restores the link only when its explicit loopback
endpoint, target owner, generation, and journal identity agree. An exact `origin/main` rewrite oracle
passes at all four journal phases.

## Remaining release evidence

- Run the physical Windows x64 and arm64 matrix in the handoff.
- Collect routed DNS disruption and physical host sleep/resume evidence, then route the runtime and
  managed-SSH soak gates for 100 consecutive passes or 14 days. The deterministic EAI_AGAIN ladder,
  production post-wake handler, a real half-open socket, repeated transport loss during
  activation/rollback/stop, and a local 100+100 cycle bundled-Bun PTY/WebSocket/backpressure soak are
  green; the synthetic wake journey is not physical suspend proof.
- Reconcile the dirty worktree, rebuild the reproducible eight-target matrix, and repeat physical and
  broad gates.
- Keep main-owned terminal recovery and live or `unverifiable` relay PTYs blocked until the
  transport-integrated ownership bridge is production-enabled; the direct-SSH bridge lower layer is
  implemented, while production mutation/control registration and local/paired ownership paths remain
  gated. Ambiguous markdown visibility IDs remain a client projection blocker (stale entries are omitted
  safely).

Do not turn a missing host, closed tunnel, timeout, or absent client-side row into `exited`.
