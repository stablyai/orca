# PTY daemon identity and lifetime architecture

## Status

Discussion document. No architecture is selected yet.

This document compares two permanent fixes for PTY ownership across Orca app and daemon
restarts:

1. incarnation-addressed daemons;
2. one stable PTY host separated from the replaceable control daemon.

It is grounded in the
[2026-08-23 terminal-session incident](./TERMINAL_SESSION_DISAPPEARANCE_INCIDENT_2026-08-23.md)
and the
[recovery-v2 control case](./recovery/2026-08-23-session-disappearance/cutover-v2-20260823T140110MST/RECOVERY_V2_CUTOVER_STATUS.md).

## Problem

Orca currently addresses a local daemon primarily through a protocol-version endpoint such as
`daemon-v36.sock`. Protocol version answers whether two processes can communicate; it is not the
identity of the process that owns a PTY.

The current code already has useful process- and session-incarnation checks. However, the exact
owner route is not a durable, self-addressing part of every persisted terminal record, and the
endpoint namespace still permits only one current owner per protocol version. On restart, routing
can fall back to asking the currently registered adapters which one recognizes a session.

That produces an invalid inference:

```text
session not found in registered adapters
    -> exact owner route is unavailable
    -> historically collapsed to exited
```

The only valid exit authority is the execution host and exact owner/session incarnation:

```text
matching owner reports matching session incarnation exited
    -> raw PTY exited
```

The execution-host contract remains
[`live` / `unverifiable` / `exited`](./docs/reference/ssh-execution-boundary.md). Transport loss,
registry loss, socket absence, or an answer from a different daemon incarnation can never
establish `exited`.

## Goals

- Route every persisted PTY to its exact owner without scanning unrelated adapters.
- Allow an app update to reuse a compatible live owner.
- Prevent a new same-protocol process from taking over the identity of an old owner.
- Reconstruct routes after app/control-plane restart.
- Accept exit evidence only from the matching execution host and owner/session incarnation.
- Bound idle CPU, memory, process, socket, and file-descriptor overhead.
- Support macOS, Linux, Windows, WSL, direct SSH, paired runtimes, git worktrees, and folder
  workspaces.
- Preserve mixed-version compatibility during a staged rollout.
- Keep logical provider recovery distinct from raw PTY reattachment.

## Non-goals

- Proving that a detached descendant process exited when its PTY owner died.
- Reconstructing arbitrary shell state after the process holding the PTY master is gone.
- Treating worktree existence, UI topology, or provider-session presence as process-liveness
  evidence.
- Solving the separate missing-worktree teardown defect.
- Changing update-window activation behavior.

## Shared identity model

Both approaches need to separate logical identity, process ownership, compatibility, and
incarnation:

```ts
interface PersistedPtyOwnerRef {
  executionHostId: string
  ownerKind: 'daemon' | 'pty-host'
  ownerIncarnationId: string
  sessionIncarnationId: string
  protocolVersion: number
}
```

The existing logical PTY ID remains stable when product behavior requires an in-place provider
continuation. A replacement raw PTY must always receive a new `sessionIncarnationId`, even if it
reuses the logical PTY ID and visual tab.

| Field | Meaning | Must not mean |
|---|---|---|
| Logical PTY ID | Stable product/tab/provider recovery identity | A particular OS process |
| Session incarnation | One raw PTY lifetime | The latest session with the same logical ID |
| Owner incarnation | Exact PTY-owning process lifetime | Protocol version or PID |
| Execution host | Host with process authority | Client currently displaying the terminal |
| Protocol version | Compatibility contract | Owner identity |
| PID | Diagnostic observation | Durable identity; PIDs are reused |

Endpoint paths must be derived from validated incarnation IDs inside a host-controlled runtime
directory. Persisted state must not contain an arbitrary socket or named-pipe path.

## Shared semantic invariants

Both approaches must enforce these rules:

1. Only the exact owner may report `live` or `exited` for a session incarnation.
2. An unreachable or undiscoverable owner produces `unverifiable`.
3. A different compatible owner reporting absence is irrelevant.
4. A late event for a superseded session incarnation cannot close its replacement.
5. UI and persisted topology survive every `unverifiable` verdict.
6. Provider continuation creates a new raw session incarnation; it is not reattachment.
7. New sessions may use a current-owner pointer, but existing sessions never do.
8. Owner routing is execution-host state. A client disconnect cannot change the verdict to
   `exited`.

## Approach A: incarnation-addressed daemons

### Design

Every daemon process gets a random incarnation UUID and a unique endpoint:

```text
runtime/
  daemons/
    <daemon-incarnation-id>/
      endpoint
      metadata.json
      token
```

On Windows, the host derives an equivalent named-pipe name from the UUID. On Unix, the runtime
directory and abbreviated/encoded UUID must stay within socket-path length limits.

The host maintains a small current-daemon registry used only for new spawns:

```text
compatibility/capability requirement -> current daemon incarnation
```

Persisted sessions route directly through `ownerIncarnationId`. A new v36 daemon cannot replace
the endpoint belonging to an older v36 daemon. Multiple daemons speaking v36 may coexist while
they own different sessions.

```text
new PTY -> compatible current daemon
old PTY -> recorded daemon incarnation -> unique endpoint
```

### Lifecycle

#### Spawn

1. Select or start a compatible current daemon.
2. The daemon creates the PTY and returns both logical and session-incarnation IDs plus its daemon
   incarnation ID.
3. Persist the owner reference before exposing the terminal as recoverable.
4. Route all later operations directly to that owner.

#### App restart or update

1. Read persisted owner references.
2. Connect to each referenced daemon endpoint directly.
3. Reuse a compatible live daemon for new sessions where policy permits.
4. Do not create one daemon per app build.

#### Protocol or capability transition

Start a new current daemon only when the existing one cannot satisfy a required capability. The
old daemon continues serving only its existing sessions and retires after its authoritative live
session count reaches zero.

#### Owner unavailable

Return `unverifiable`. Keep topology and the exact owner reference. A host-side proof that the
owner process incarnation is gone establishes loss of the raw PTY owner, but it does not prove
that detached descendants exited.

#### Retirement and garbage collection

A daemon may remove its endpoint after reporting zero sessions and completing shutdown. A later
collector may remove stale endpoint metadata only after proving the exact process incarnation is
gone. Endpoint absence by itself is not deletion authority for session records.

### Performance model

```text
full daemon processes = live incompatible/independent daemon generations
session state         = active sessions
```

Compatible app builds reuse one daemon, as recovery-v2 reused PID `26391`. Accumulation occurs
only when long-lived sessions span protocol/capability transitions or an old daemon remains
unverifiable. Idle daemons must be event-driven and should consume no recurring polling CPU, but
each generation still retains a process, runtime, socket, credentials, logs, and baseline memory.

### Advantages

- Smallest change from the current architecture.
- Directly fixes same-protocol endpoint collision and adapter-scan ownership inference.
- Reuses existing daemon, adapter, protocol, and process-incarnation machinery.
- Allows independent retirement of drained generations.
- Limits migration risk because PTY ownership stays where it is today.
- A failure in one old daemon affects only sessions owned by that daemon.
- Compatible builds normally keep one daemon, avoiding per-build accumulation.

### Disadvantages

- Long-lived sessions can retain multiple full daemon generations.
- Old daemon code, including security-sensitive code, may remain alive indefinitely.
- The old bundle may be removed while its daemon still runs; binaries and required resources must
  live in a stable versioned support directory.
- Lifecycle, endpoint garbage collection, and security retirement policy become explicit product
  responsibilities.
- A daemon crash still destroys every PTY master held by that daemon.
- A wedged daemon may retain resources while remaining `unverifiable`.
- Existing records without an owner incarnation require a conservative legacy migration path.

### Migration

- Add owner fields as optional persisted and wire fields first.
- For legacy records, retain adapter discovery only as a non-destructive compatibility path.
- Backfill an owner only when exactly one adapter positively proves ownership and returns its
  incarnation. Never backfill from a negative scan or protocol number.
- New hosts publish optional owner metadata; old clients ignore it. If behavior depends on a new
  terminal-stream operation rather than an optional field, capability-negotiate it according to
  [remote wire compatibility](./docs/reference/remote-wire-compatibility.md).
- Remove legacy discovery only after the oldest supported persisted state is migrated or retired.

## Approach B: stable PTY host plus replaceable control daemon

### Design

Split the current daemon into two lifetime domains:

```text
Orca app
    -> replaceable control daemon
        -> stable PTY host
            -> PTY masters and child processes
```

The PTY host contains only the minimum long-lived data-plane behavior:

- spawn and attach;
- read and write;
- resize;
- signal and terminate;
- bounded replay/history handoff;
- process inspection required for terminal correctness;
- session-incarnation and exit reporting.

Agent orchestration, provider policy, Git/worktree behavior, update logic, application routing,
and fast-moving product features remain in the replaceable control daemon.

All local sessions point to the stable host incarnation. App and control-daemon updates reconnect
to the same host and do not change PTY ownership.

### Lifecycle

#### Spawn

1. The control daemon requests a spawn from the stable host.
2. The host creates the PTY and returns a session incarnation.
3. Persist the stable-host and session-incarnation identity.
4. The control daemon may restart without changing either identity.

#### App or control-daemon update

Disconnect the control plane, replace it, and reconnect to the existing host. The host's API must
remain backward compatible across the supported mixed-version window.

#### PTY-host update

The stable host cannot be casually replaced while it owns sessions. Available policies are:

1. defer replacement until it drains;
2. run old and new stable-host generations side by side temporarily;
3. require explicit recovery/termination for a mandatory security update.

Policy 2 temporarily reintroduces Approach A at the PTY-host layer.

#### Host unavailable

Transport loss is `unverifiable`. If the execution host proves that the exact PTY-host process
incarnation exited, all raw PTYs it owned are gone. Detached descendants may still exist and must
not be described as exited without their own evidence.

### Performance model

```text
full PTY-owning host processes = 1 in steady state
control daemons                = 1 current process
session state                  = active sessions
```

This hard-bounds daemon-generation accumulation during ordinary app/control-daemon updates.
Session memory, PTY handles, replay buffers, and child processes still grow with active sessions;
that cost is inherent. The split adds one IPC hop between the control daemon and PTY host and may
duplicate some connection, serialization, and buffering work.

### Advantages

- One PTY-owning process in steady state.
- App and control-daemon replacement cannot sever raw PTYs.
- Separates stable terminal lifetime from rapidly changing product logic.
- Removes most reasons to retain old full-feature daemon generations.
- Gives one place to enforce exact session-incarnation and exit authority.
- Makes control-daemon crash recovery materially stronger than Approach A.

### Disadvantages

- Larger initial refactor and a new internal protocol boundary.
- The stable host is a single failure domain: if it crashes, every PTY master it owns is lost.
- The host API must remain deliberately small and backward compatible; feature leakage recreates
  the current versioning problem.
- Updating the stable host while sessions are live remains difficult.
- An additional IPC hop can affect input latency, output throughput, backpressure, replay, and
  resize ordering.
- Cross-platform extraction is substantial, especially Windows ConPTY, WSL, macOS process
  attribution, and SSH relay ownership.
- Debugging spans app, control daemon, host, and child-process logs.
- Security-sensitive host defects can remain resident until all sessions drain.

### Migration

- First put the current daemon's PTY operations behind an internal host interface without changing
  process placement.
- Add a capability-negotiated external host transport and run it in shadow/verification mode.
- Move new local sessions to the stable host while existing daemon-owned sessions keep their old
  owners.
- During transition, route by `ownerKind` and exact owner incarnation; never guess based on logical
  PTY ID.
- Retire daemon-owned sessions naturally. Do not attempt cross-process PTY transfer as part of the
  first migration.
- Keep remote execution ownership on the remote host. A desktop client must never address a remote
  host socket directly.

## Side-by-side comparison

| Criterion | Approach A: incarnation-addressed daemons | Approach B: stable PTY host |
|---|---|---|
| Fundamental identity ambiguity | Eliminated | Eliminated |
| Same-protocol owner collision | Eliminated with unique endpoints | Eliminated because ownership stays in the stable host |
| App restart survival | Yes, if owning daemon remains live | Yes |
| Control-daemon crash survival | No; it owns the PTYs | Yes; PTY host owns them |
| PTY-owner crash survival | No | No; stable host is the PTY owner |
| Steady full-process count | One per live daemon generation | One host plus one current control daemon |
| Generation accumulation | Possible across compatibility transitions | Avoided for control-daemon updates; possible only when the host itself must version |
| Additional steady IPC hop | No | Yes |
| Initial implementation scope | Moderate | Large |
| Migration risk | Lower | Higher |
| Old security-sensitive code lifetime | Per retained daemon generation | Stable host may remain old until drain |
| Failure blast radius | Sessions in one daemon generation | All sessions in the stable host |
| Protocol evolution | New daemon generation | Stable host API must remain backward compatible |
| Best fit | Correctness retrofit with minimal disruption | Hard process bound and control-plane restart survival |

## Neither approach provides PTY-owner crash survival

This distinction must remain explicit:

```text
app/control process dies -> Approach B preserves PTYs
PTY-owning process dies   -> both approaches lose its PTY masters
```

Surviving the PTY-owning process itself requires a third architecture: one independently
supervised host per session, or an OS facility that can transfer/recover PTY ownership. A
per-session host reduces the failure blast radius to one terminal but adds a process and endpoint
per active session. Cross-platform transfer of live Unix PTY and Windows ConPTY state is not a
simple alternative and is outside this comparison.

## Cross-platform and execution-host requirements

### Local Unix

- Derive socket paths with platform path utilities.
- Keep paths below Unix-domain socket limits.
- Restrict directory and token permissions to the user.
- Prove process incarnation with PID plus platform start identity, never PID alone.

### Windows

- Derive named-pipe names from validated incarnation IDs.
- Preserve `windowsHide` and the shared child-process boundary.
- Treat ConPTY ownership and handle lifetime as host-local implementation details.
- Do not assume Unix descriptor-transfer mechanisms exist.

### WSL

- Keep native Windows, each WSL distribution, and any relay as distinct execution hosts.
- Never route a WSL PTY through a native endpoint merely because the client can see both.
- Preserve existing `wsl.exe --exec` and captured-login-shell requirements.

### Direct SSH and paired runtimes

- Store and resolve owner identities on the execution host.
- A client or relay disconnect always produces `unverifiable`.
- The host publishes optional opaque ownership evidence; it does not expose a connectable local
  filesystem path to the client.
- Mixed client/host versions are normal. New optional fields must remain optional; new operations
  require capability negotiation.

### Worktrees and folder workspaces

PTY ownership must not depend on Git identity. Worktree or folder workspace IDs are grouping and
display metadata, not execution authority. Deleting or failing to discover a workspace cannot
change an owner verdict without a separate, host-authoritative stop operation.

## Security and operational policy

Both approaches require:

- authenticated endpoints with per-owner credentials;
- endpoint derivation inside a protected runtime directory;
- process-incarnation verification before trusting metadata or deleting stale endpoints;
- bounded logs and replay buffers;
- explicit maximum supported age for security-critical owners;
- observable owner/session counts and retirement reasons;
- no automatic destructive fallback when metadata is corrupt or incomplete;
- a user-visible recovery choice when a security update cannot preserve an old owner.

## Acceptance criteria shared by both approaches

1. Two same-protocol owners can each host a session without either claiming the other's ID.
2. App restart reconstructs exact routes without broad `listSessions` ownership inference.
3. Removing an adapter, endpoint, or transport returns `unverifiable` and preserves all topology.
4. An exact-owner exit closes only the matching session incarnation.
5. A delayed exit for an old incarnation cannot close a replacement using the same logical PTY
   ID.
6. Ten compatible app updates do not create ten PTY-owning processes.
7. A protocol transition retains the old owner only while it has sessions and retires it after
   drain.
8. SSH disconnect and relay loss remain `unverifiable`.
9. Folder workspaces pass the same lifecycle tests as Git worktrees.
10. Current client/old host and old client/current host pass the relevant cross-version suites.
11. Windows ConPTY, WSL, macOS, Linux, and remote hosts pass owner-isolation tests.
12. Provider continuation preserves the logical tab but creates a new session incarnation.

## Approach-specific performance gates

### Approach A

- Measure baseline memory and idle CPU for one current and multiple drained-but-live daemons.
- Require no periodic polling proportional to daemon generations or persisted sessions.
- Verify compatible app updates reuse one daemon.
- Bound endpoint discovery and startup work by referenced owners, not every historical protocol.

### Approach B

- Measure input latency and output throughput across the added IPC hop.
- Verify backpressure, replay, resize, pause/resume, and exit ordering under dense output.
- Measure stable-host memory per active session and control-daemon restart time.
- Prove ordinary control-daemon updates never create another PTY host.

No architecture should be selected without production-shaped measurements for hundreds of
sessions and at least two simultaneously supported host/client versions.

## Decision framework

Choose Approach A when the priority is the smallest safe correction to ownership identity and the
product can tolerate a small number of draining daemon generations. It fixes the incident class
without moving PTY ownership across a new process boundary.

Choose Approach B when the product requires a hard steady-state bound on PTY-owning daemons and
raw terminals must survive replacement or crashes of the feature/control daemon. Accept the
larger refactor, extra IPC hop, and stable host's larger failure blast radius.

If the requirement is that a raw terminal survive failure of the process that owns its PTY master,
neither approach is sufficient. Decide that requirement separately before treating Approach B as
complete crash continuity.

## Implementation touchpoints

The eventual implementation is expected to affect at least:

- `src/main/daemon/daemon-init.ts` and daemon endpoint path construction;
- `src/main/daemon/daemon-pty-router.ts`;
- `src/main/daemon/daemon-session-owner-resolution.ts`;
- `src/main/daemon/daemon-pty-adapter.ts`;
- `src/main/ipc/pty.ts`;
- persisted terminal and pane ownership records;
- local/SSH/paired-runtime terminal publications;
- daemon/relay launch and retirement telemetry;
- cross-version terminal-wire and restart recovery tests.

Before implementation, the selected approach needs a concrete schema, endpoint authentication
contract, migration state machine, rollback plan, and measured resource budget.
