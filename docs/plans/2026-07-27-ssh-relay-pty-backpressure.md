# SSH Relay PTY Backpressure

Date: 2026-07-27

Status: architecture gate closed and exact SSH V1 wire/API implemented
always-on for new SSH sessions; integrated lifecycle fixes reconciled at
the current working tree; live topology gaps remain explicit below

Historical unbounded baseline: `badf91101babf96fa09cb79a8294f7e23b9f081c`
(the implementation branch parent). The implementation was rebased onto
`origin/main@d9fec8fd61d0349ae8cdf0eea594de7425db94c9`; final GitHub CI remains
the merge gate.

## Scope

This implemented design bounds SSH relay PTY output from the native PTY through the relay
dispatcher, SSH channel or relay socket, Electron main process, and renderer
parser. It covers:

- application-level PTY output credit;
- relay stdout and socket drain handling;
- per-client isolation, fairness, ordering, and cleanup;
- bounded frame decoding on both sides of the relay protocol;
- memory budgets, diagnostics, compatibility, tests, and deployment.

The sidebar reconnect fix in `9d3ae3adc7` is out of scope. The non-ancestor
commit `1500a92904` is design input only; it must not be cherry-picked. This
work does not change PTY input semantics, terminal-model interpretation, or
file/Git payload semantics. It does change replay transport, SSH producer
pause wiring, and bulk frame admission where they share the dispatcher sink.

## Implemented architecture and evidence boundary

The architecture review approved one shared semantic
`PtyConsumerSession` state machine with an SSH-specific transport adapter,
not a universal wire protocol. The exact SSH adapter contract is now
implemented. In this PR:

- `PtyConsumerSession` owns authenticated client/owner generations, lease
  recovery, capability intersection, and grant publication commit/rollback.
- `SshPtyConsumerSessionAdapter` binds those semantics to the existing
  authenticated relay connection and the first framed `pty.openClient`
  request. The relay dispatcher remains the only sink-publication authority.
- The relay source ledger owns immutable source spans, outstanding source
  credit, token rotation, sealed exit, and cancellation proof. The dispatcher
  writer owns byte admission, priorities, `write(false)`, callbacks, and drain.
- Spawn and attach responses carry immutable `sourceActivation` metadata. The
  main mux installs a provisional receive lease synchronously in
  `beforeResolve`; adjacent source notifications remain private to that lease
  until spawn validation commits or a validated reconnect contract transfers
  them into its private recovery quarantine. Rollback drops untransferred data
  and waits for exact token-cancellation proof.
- `SshRelaySession` owns grant/reconnect state, bounded recovery quarantine,
  exact recovery fencing, and cumulative ACK publication through the main SSH
  mux. Failed recovery-cancellation publication or proof closes the exact
  provider generation and its publishers once.
- The main SSH intake owns one atomic admission across the model, desktop
  projection, and required remote consumers. Model completion and consumer
  terminality make ACKs eligible; only the mux write callback publishes them.
- Desktop and remote replacement transactions carry immutable span identity.
  Reserve happens before publication, commit requires the exact
  generation/sequence fence, and failure, stale publication, or already
  reclaimed spans reject commit and roll back idempotently without credit.
- Relay `restoreRequired` cancellation retains its exact delivery record until
  the metadata response settles, then retires only that record so a retry can
  mint a fresh token. Main exit timeout obtains cancellation proof before
  transferring projections and committing reclamation, with generation checks
  around every finalization step.
- The main-to-relay writer has three FIFO lanes: liveness, control, and
  ordinary. Drain reselects liveness/control ahead of queued ordinary traffic,
  while one ordinary frame is guaranteed after four control writes.

The implementation is intentionally scoped:

| Surface                                     | State in this PR                                          | Evidence                                                                                         |
| ------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Same-build direct SSH/deployed relay, V1    | implemented; every session offers and relay advertises V1 | current-working-tree deterministic contracts plus provenance-bound macOS-hosted Docker OpenSSH   |
| Capability/method-not-found legacy fallback | implemented bounded legacy compatibility                  | deterministic negotiation and writer contracts                                                   |
| Reconnect/owner recovery                    | implemented                                               | exact contiguous recovery, fail-closed cancellation, eight-wide reattach tests, Docker reconnect |
| Headed/headless remote consumers            | source-range rotation/replacement implemented             | deterministic runtime/main seam only; no live paired-runtime claim                               |
| WSL stdio and Windows named pipe/ConPTY     | shared transport paths preserved                          | deterministic/common-contract evidence only; no physical run                                     |
| Local provider and local daemon             | unchanged                                                 | outside SSH V1 negotiation; existing behavior only                                               |
| Folder workspace                            | no `.git` dependency added                                | code-path review only; no dedicated live fixture                                                 |
| Prior-version/mixed-version peers           | fail-closed or version-scoped legacy behavior preserved   | deterministic negotiation/deploy contracts; no live old binary                                   |
| Ubuntu 20.04/glibc 2.31                     | no native dependency added                                | cross-target relay build only; no physical packaging run                                         |

Docker SSH proves the Linux SSH provider and deployed-relay topology. It does
not prove headed or headless paired-runtime behavior, WSL, Windows ConPTY or
named pipes, local daemon/provider behavior, folder workspaces, prior-version
processes, mixed-version clients, or the Ubuntu 20.04 packaging floor.

The final exact-code Docker rerun rebuilt the E2E main bundle and all relay
targets from the current-main merge head. It is bound to implementation commit
`adba3410fe4427ceb7525f3fdce2ec58973263a7`, tree
`e43d87340666ca3a733bdb38007c24f95be3f219`, main bundle SHA-256
`3c304ffc0618520e42bede9a52f72d4b7bb68cbfe543974f89e82a3c477c44b3`,
and deployed Linux-x64 relay SHA-256
`366cb7ccf2e4b388cc6f81a8f6055ab9fde57d2d91381767005c15908832e776`.
No additional live topology proof is inferred from that run.

## Verified baseline and migration boundary

On the historical baseline, the SSH path was not protected by the main pending-data bound:

1. `node-pty` calls `PtyHandler`'s `onData`. `PtyHandler` keeps the existing
   100 Ki-source-unit replay tail. The first ordinary flush waits 8 ms, a
   sustained flush continues after 1 ms, and interactive or transformed output
   may publish immediately; a turn publishes at most two 16 Ki-unit chunks.
2. `RelayDispatcher.notify('pty.data')` broadcasts each publication. The
   ordinary notification path ignores `process.stdout.write()` and
   `Socket.write()` returning `false`, so every later frame can extend a Node
   writable queue after the first saturated write.
3. Main's `FrameDecoder.feed()` drains all complete frames synchronously.
   `MultiplexerTransport` exposes neither read pause/resume nor write drain.
4. `SshRelaySession.wireUpPtyEvents` is the production SSH delivery owner. It
   calls `runtime.onPtyData()` and then sends `pty:data` directly to the
   renderer. It does not enter the `PtyPendingDataDrainQueue` installed by
   `src/main/ipc/pty.ts` for local and daemon providers.
5. Main therefore has no SSH queue record against which to calculate useful
   upstream progress. The current cumulative renderer ACK is converted to a
   delta, the SSH path commonly emits zero, and the relay's
   `PtyHandler` ignores `pty.ackData` in any case.
6. Production POSIX and Windows deployment launches the relay detached, then
   attaches the real desktop bridge through a Unix socket or named pipe.
   Dispatcher construction therefore cannot identify the usable session owner.
7. `OrcaRuntime.onPtyData` returns synchronously while headless-emulator writes
   append captured strings to an unmetered asynchronous `writeChain`.
8. Relay fs/Git chunks use `notifyBulk`/producer chains outside any stated PTY
   reserve; they can occupy the same ordered sink ahead of cancel, ACK, and
   interactive output.
9. `computeRemoteRelayDir` content-hash-scopes both daemon files and endpoints.
   Mixed deployed binaries are fenced, while a prior-version daemon can remain
   alive in its old directory after upgrade.
10. `SshPtyProvider` omits the existing producer-pause hooks, and production
    constructs `MultiplexerTransport` in both SSH sentinel handling and the WSL
    hook path.
11. Lossless remote terminal streams ACK encoded byte deltas today and retain
    only aggregate in-flight bytes; no existing record maps those bytes back to
    immutable SSH source intervals. `694363805` extracted their UTF-16
    code-unit-preserving chunker to
    `src/main/runtime/rpc/terminal-output-frame-chunks.ts`; it improves
    performance and equivalence coverage but adds no provider/token identity.
12. `1fd0f731f` routes SSH folder-workspace automation launches to their owning
    host. It does not change PTY output delivery or make folder workspaces Git
    worktrees.
13. `077561f89` moved remote terminal stream UTF-8 measurement into
    `terminal-stream-byte-length.ts`, preserving legacy flush boundaries and
    partial over-limit counts. Those encoded-byte counters remain transport
    budgets, not SSH source credit.
14. `2dac0741b` preserves ordered DEC mode 2031 subscribe/withdraw decisions
    when the current main pending-data queue drops or salvages renderer output.
    Its bounded cross-chunk scan state is projection metadata that a unified
    SSH intake must preserve; it does not settle source spans.
15. `d547e278f` adds epoch-scoped, post-delivery watermarks for mobile
    notification catch-up. That notification replay protocol is distinct from
    mobile terminal streaming; its sequence and epoch cannot identify or settle
    PTY source ranges.

This project first moves ownership of every SSH provider data event out of the
direct `wireUpPtyEvents` send and into one main delivery intake. That intake
performs runtime ingestion, desktop delivery policy, remote-consumer
fan-out, and upstream span settlement exactly once. Adding another listener is
forbidden because it would double-ingest and double-render output.

The initial 8 ms/continuation 1 ms cadence and two-write limit are scheduling
controls, not bounds. A continuous producer can currently grow the relay
writable queue, SSH buffers, decoder input, and Electron heap. The frame-header
`ack` remains transport liveness bookkeeping; it is not PTY credit and never
enters this ledger.

The falsifiable invariant is: accepted SSH relay PTY output remains bounded
across relay writable queues, SSH/socket transport, main decoding and model
admission, renderer projection, and remote consumers while every source span
settles exactly once in order. The observable failure on this baseline is that
ordinary relay PTY notifications continue after `write(false)`, main drains all
complete frames synchronously, SSH bypasses `PtyPendingDataDrainQueue`, and
headless emulator writes enter an unmetered Promise chain. A sustained SSH
producer can therefore increase relay, transport, and main memory without a
finite upstream credit owner.

Authority and delivery boundaries on this baseline are:

```text
renderer/viewer
  -> IPC or runtime RPC
  -> Electron main / OrcaRuntime
  -> SshRelaySession + SshPtyProvider
  -> SshChannelMultiplexer
  -> SSH channel / --connect bridge
  -> RelayDispatcher
  -> PtyHandler
  -> node-pty / ConPTY
```

`PtyHandler` owns native output and replay; relay dispatcher/adapters own
client writes; `SshRelaySession.wireUpPtyEvents` owns production SSH ingestion;
`OrcaRuntime` owns the headless model; `src/main/ipc/pty.ts` owns
main-to-renderer accounting; and `terminal.multiplex` owns remote-consumer
delivery. The current bug is fragmentation across those owners, not a missing
renderer-only cap.

## Required invariants

1. Protocol credit uses one canonical unit: UTF-16 code units in the
   pre-transform source span, called source units (`su`). Retained memory and
   wire queues use exact bytes and never masquerade as source credit.
2. For a negotiated token,
   `0 <= sentEnd - creditedEnd <= windowSu`; each admitted slice fits the
   remaining window, so no frame overshoot is permitted. ACKs are cumulative,
   monotonic, client/PTY/token scoped, and never exceed `sentEnd`.
3. Source-credit spans are immutable and stored in a cumulative ledger.
   Queue data may merge, split, salvage, thin, or coalesce without moving,
   copying, or destroying ledger boundaries.
4. A sink `write(false)` accepts its frame exactly once. No ordinary frame is
   written again before drain. PTY admission stops before a reserved
   control/liveness capacity is consumed.
5. A spawn/attach token remains `activating` until its metadata-only response
   crosses the relay sink fence. Main may receive source frames after its
   synchronous provisional install, but they remain lease-private and cannot
   project. A validated reconnect contract transfers that lease into the
   attempt's private recovery quarantine; final commit, model, and desktop
   admission remain fenced until all recovery `pty.data` and the exact
   completion fence agree.
6. Data is ordered within a token. `pty.exit` follows every accepted data frame
   and cannot bypass the sink gate or activation fence. Publishing exit seals
   new data but does not retire an uncredited suffix.
7. Every open token-owned span and consumer obligation ends exactly once in
   `settled`, `transferred`, or `canceled`; a transfer may pass through the
   non-terminal `transferring` state only while its named replacement fence is
   outstanding. A canceled `restoreRequired` delivery remains addressable until
   its exact response settles and retires only if the map still names that
   record. Records are never merely abandoned while their relay token can live.
8. Desktop, mobile, web, and agent-session consumers follow the explicit
   settlement policy below. A stalled recoverable desktop projection cannot
   freeze a healthy lossless remote view.
9. One slow additional subscriber cannot retain unbounded data or stop a
   healthy subscriber. The negotiated session owner is not torn down for one
   PTY's backlog; constructor position never grants that role.
10. When every delivery for a PTY is blocked, pause the native PTY. Resume only
    when both local and relay-wide low-water predicates hold.
11. An unexpected client loss transfers outstanding output to a bounded
    reconnect-grace owner. Normal subscriber absence retains only the existing
    replay tail and no live queue.
12. Decoder work, decoded bytes, model admission, and activation-hold turns are
    bounded. A self-imposed read or local-write pause rebases both liveness
    clocks. Main-to-relay drain reselects liveness, then control, ahead of
    ordinary PTY input; four consecutive control selections force one ordinary
    selection when both lanes remain non-empty.
13. Disconnect, provider replacement, renderer reload, exit, disposal, and
    workspace removal have explicit bounded cleanup. After their required
    publication, transfer, cancellation, or generation-close proof, they leave
    no open span, token, writer callback, drain waiter, timer, cursor, or paused
    PTY. Recovery-cancellation publication failure or rejected proof fails
    closed by closing only the owning provider generation and disposing its
    mux, provider, publishers, transferred activation state, and registration
    once.
14. All counters are finite safe integers. A transformed frame requires a
    valid `rawLength`; malformed, excessive, stale, and cross-client values
    cannot create credit or crash either process.
15. The session owner is elected by an authenticated session grant and
    identified by an owner generation. It is never inferred from dispatcher
    construction, stdout, socket order, a path, `.git`, or a worktree.
16. Recovery and serialization control responses contain metadata only.
    Source-ranged recovery or snapshot bodies use bounded producer lanes and
    explicit completion fences before live delivery.
17. The required main model has bounded asynchronous admission. Relay credit
    cannot advance while data waits outside that charged admission or after an
    emulator failure.
18. Negotiated V1 has one upstream ACK owner. Renderer projection progress and
    remote encoded-byte ACKs settle ledger obligations but never emit legacy
    SSH ACK deltas.
19. Required obligations becoming terminal, cumulative ACK queueing, and ACK
    publication are three monotonic states. A write callback publishes already
    eligible credit; it never creates eligibility.
20. Desktop admission carries immutable span identity through model reserve,
    projection queue, renderer send, ACK, salvage, reload, and replacement.
    Failure either rolls back an uncommitted transaction or transfers a
    committed obligation with proof. Exit timeout acquires cancellation proof
    without mutation, transfers published projections, commits proof
    reclamation, prepares/finalizes exit once, and rechecks the provider
    generation before each post-proof mutation.
21. Projection drop, thinning, salvage, restore, and replay preserve current
    main's ordered terminal side-effect facts and bounded scanner state,
    including DEC mode 2031 subscribe/withdraw decisions. Pre-commit rollback
    restores the prior scanner snapshot, committed transfer moves projection
    state exactly once, and an explicit source gap resets cross-chunk state;
    none of these facts creates source credit.
22. The immutable delivery identity is exactly `(id, providerGeneration,
clientGeneration, ownerGeneration, ptyIncarnation, deliveryToken)`. Each
    admitted source span additionally fixes `spanId`, source/display half-open
    ranges, transform metadata, and model-sequence end where required.
23. Receive activation begins at `checkpointSourceEndSu`. Every recovery
    `pty.data` frame is contiguous from that cursor through `recoveryEndSu`;
    only the exact `pty.recoveryComplete` writer settlement opens live output.
24. A reentrant cumulative ACK may reserve only the exact pending send
    boundary for the same delivery identity. Failed send settlement retains
    that boundary and permits only an exact same-token retry.
25. A fixed `fs.streamChunk` keeps the protocol's 256 KiB payload and offset
    semantics. It may use the fixed-frame lane only from an empty,
    unsaturated producer epoch; ordinary PTY and reshapable bulk frames still
    obey the non-reserved capacity.
26. A lossless remote stream may advance its cumulative encoded-byte ACK to an
    interior byte offset. Exact byte budget is released immediately, while the
    covering immutable source frame remains unsettled until its complete
    encoded boundary is crossed.
27. A lossless remote stream accepts an in-place source-token rotation only
    when PTY ID, provider generation, and incarnation match; both client and
    owner generations strictly increase; the token changes; and source/display
    coordinates remain contiguous. Old or partially increasing identities are
    rejected.
28. Snapshot replacement commits are idempotent and never synthesize byte or
    source credit. Duplicate/closed ledger commits are no-ops; if cancellation
    proof already reclaimed a reserved span, source replacement commit rejects,
    rollback skips the absent span, and settle/detach prune cached mappings.
29. Exact exit seals a provisional or private-recovery receive lease before
    any later same-token frame can reserve or project. Exit publication waits
    for the held contiguous prefix to admit or for cancellation proof whose
    sent end covers every privately observed exact-token frame.
30. Transfer does not consume rollback authority until the ledger proves the
    lease is still current and installs the private recovery sink. A stale
    transfer can still retire and cancel only its own token.
31. Canceled-frame suppression retains at most one latest ordered delivery
    identity per relay PTY. Transport ordering makes earlier token records
    obsolete when a later cancellation is observed; exact next activation,
    PTY exit, or provider teardown clears the remaining record.

## Protocol

### Architecture decision record

Decision: `PtyConsumerSession` is a shared semantic state machine, not a
universal transport protocol. The architecture gate is closed and is no
longer waiting for exact wire/API names: the SSH adapter implements
`sourceActivation`, source-bearing `pty.data`, `pty.recoveryComplete`,
cumulative `pty.ackData`, and token-scoped cancellation. Current-working-tree
deterministic validation is an engineering gate; unexecuted live topologies
remain separate promotion gates. A relay-only
`pty.getCapabilities` followed by `pty.negotiateClient` remains rejected
because it would create a second readiness authority beside the existing
authenticated handshakes.

The 2026-07-28 architecture/terminal review closed its three blocking
findings as follows:

| Finding                                                                   | Implemented resolution                                                                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exited delivery removed while uncredited spans remain                     | Native exit seals the token; logical state survives until cumulative ACK, exact transfer, token-scoped cancellation proof, or generation close.                          |
| Terminal obligations depended circularly on ACK publication               | Obligation terminality advances `obligationsTerminalEndSu`; the coalescer independently queues `ackQueuedEndSu`; only mux write settlement advances `ackPublishedEndSu`. |
| Desktop projection admission lacked immutable range identity and rollback | Model, source span, projection range, and scanner snapshot reserve atomically; pre-commit failure rolls back, while post-commit replacement transfers with proof.        |

Later adversarial review also required exact recovery continuity, stale-attempt
isolation, session-grant fallback semantics, and idempotent remote detach
after token reclamation. Those are incorporated in the activation, lifecycle,
cleanup, tests, and compatibility sections below.

The final 2026-07-28 architecture/terminal re-review found and closed three
additional interleavings:

| Finding                                                                                 | Implemented resolution                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed exit publication could discard a sealed delivery before its suffix was credited  | Failed publication retains the sealed delivery; late cumulative ACK and exact owner recovery can still settle it, and exit is republished without reopening source admission.          |
| Recovery-response cancellation authority ended at enqueue rather than writer settlement | The request remains cancellation-authoritative until its response settles; retry reuses the same provisional replacement identity instead of creating an unfenced owner.               |
| Snapshot replacement transferred every pending remote span at one sequence fence        | Each immutable span retains its model-sequence end; replacement transfers only spans covered by the authoritative `SnapshotEnd`, while trailing spans remain live and replay in order. |

Current-working-tree adversarial reconciliation closed these additional integrated
failures without widening the approved topology:

| Finding                                                                      | Implemented resolution                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invalid-checkpoint `restoreRequired` left a canceled delivery blocking retry | Keep the exact canceled record through response settlement, then delete it only if it is still current; retry mints a fresh activation token.                                        |
| Recovery cancellation publication/proof rejection left ambiguous authority   | Raise a typed recovery-cancellation failure and close the exact provider generation, disposing its mux, provider, publishers, lease, and registration exactly once.                  |
| Remote partial ACK or higher-generation token rotation detached the stream   | Release exact cumulative byte credit at any valid interior offset without source settlement; admit only contiguous strictly higher client/owner generations with a new token.        |
| Snapshot cleanup raced cancellation-proof reclamation                        | Make ledger replacement commit idempotent and make remote replacement commit reject reclaimed spans while rollback, settle, and detach prune them without dereference or new credit. |
| Drain resumed the main mux's old ordinary FIFO ahead of control              | Select liveness, control, and ordinary from separate FIFO lanes; prioritize control after drain and force one ordinary write after four controls.                                    |
| Same-turn source data escaped a provisional activation                       | Queue data privately under the provisional lease; commit publishes in order, while rollback drops it, restores only the active predecessor, and awaits exact cancellation proof.     |
| Exit cancellation proof reclaimed spans before projection transfer           | Acquire proof first, transfer projections, commit proof, prepare/finalize once, and fence every post-proof step against provider-generation close.                                   |
| Exit during private recovery could publish before held frames settled        | Seal the private lease immediately, wake the exact recovery fence, then either admit the ordered prefix before exit or retire it only after exact token-cancellation proof.          |
| A superseded transfer lost its cancellation authority                        | Keep the outer lease unsettled until transfer ownership is verified; a stale transfer can still roll back and request cancellation for its exact token.                              |
| Recovery proof watermark skipped rejected or post-restore frames             | Observe every exact-token private frame before retention or restore checks and reject any cancellation proof whose sent end is below that immutable high-water.                      |
| Canceled-token tombstones grew once per token                                | Retain only the latest ordered canceled token per relay PTY, replace it on later cancellation, and clear it at exact next-activation, PTY-exit, or provider-teardown boundaries.     |
| Reconnect checkpoint raced a running raw model callback                      | Freeze the exact provider-generation/PTy admission, cancel only queued work, and await the bounded running callback before exporting a checkpoint.                                   |
| Migration-owned callback failure closed the shared provider                  | Contain failure to the exact migrating PTY, reset only its model, preserve siblings and transport, and retain the ordinary generation-fatal policy outside migration.                |
| Closed-generation telemetry omitted active gaps                              | Compact exact closed ranges and expose the count of allocated but unclosed provider generations below the closed high-water.                                                         |

The final exact-implementation-head architecture/lifecycle review was clean
across 27 files and 296 tests. The transport/topology review confirmed the
exact-PTY containment fix and found no remaining code blocker; its sole
evidence finding was the stale artifact record replaced by the
provenance-bound build and Docker run above.

The common state machine accepts only:

- an authenticated principal and owner-eligibility decision from the adapter;
- a consumer generation and optional capability offer/grant;
- a subscription/delivery identity and close reason;
- an adapter-provided publication fence.

It does not authenticate sockets, parse frames, own sentinel/residue bytes,
wait for stream drain, prove reconnect credentials, or define remote-runtime
encoded-byte ACKs. Those remain adapter responsibilities. The semantic input
and output may be represented as:

```ts
type PtyConsumerSessionHello = {
  clientInstanceId: string
  requestedRole: 'session-owner' | 'subscriber'
  resume?: {
    ownerGeneration: number
    ownerLease: string
  }
  capabilities?: {
    outputFlowControl?: { versions: [1]; requestedWindowSu: number }
  }
}

type PtyConsumerSessionGrant = {
  serverBuildId: string
  clientGeneration: number
  role: 'session-owner' | 'subscriber'
  ownerGeneration?: number
  ownerLease?: string
  capabilities?: {
    outputFlowControl?: { version: 1; windowSu: number }
  }
}
```

These types are not wire schemas. Authentication produces a transport-bound
principal and `allowSessionOwner` before the state machine sees the offer. A
request field cannot self-promote a client. The state machine performs
generation allocation, owner replacement, capability intersection,
publication fencing, and close cleanup; the adapter proves identity, carries
the semantic fields, and calls the fence.

The reviewed decision preserves the existing connection machinery:

| Path                                    | Authentication and identity                                                                                | Binding in this PR                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Local in-process provider               | trusted main-process construction                                                                          | unchanged; it does not negotiate SSH V1                                       |
| Local daemon                            | token-authenticated `HelloMessage`, stable `clientId`, paired control/stream sockets, and `daemonIdentity` | unchanged; an exact-version daemon remains outside the SSH wire contract      |
| SSH relay socket/named pipe             | existing authenticated relay endpoint and dispatcher client identity                                       | first framed `pty.openClient`; response settlement is the readiness fence     |
| Primary relay stdio and WSL child stdio | no authenticated dispatcher principal in this PR                                                           | bounded legacy transport only; an unproved client cannot become session owner |
| Remote-runtime server                   | paired-device/E2EE identity and connection ID                                                              | source-range reserve/commit/rollback only; never receives an SSH owner lease  |

The implemented owner path is the authenticated detached relay endpoint used
by the SSH provider. After extracting the exact sentinel and residue, main
sends `pty.openClient` before spawn, attach, or ordinary dispatch. The relay
adapter queues later decoded frames behind the session response's write
callback, so an eager next request cannot race activation. Main marks the
provider ready only after receiving the valid response.

Detached `--connect` first reads the version-scoped endpoint credential and
authenticates its Unix-socket/named-pipe bridge before emitting its sentinel.
The adapter converts that proof into a principal and
`allowSessionOwner = true`; `pty.openClient` carries no secret to the generic
RPC handler. The primary relay stdin/stdout dispatcher identity remains
explicitly unproved and therefore subscriber-only; there is no launch nonce in
this implementation. WSL child stdio shares the bounded decoder/writer
transport changes but does not negotiate an SSH V1 owner in this PR. A manual
relay without the version-scoped endpoint credential is also subscriber-only.

POSIX hosts may expose different shell and SFTP home namespaces. While the
install lock is held, a per-launch marker maps the canonical shell credential
path to the matching SFTP-relative path; the credential write uses that
mapping before the lock is released. If the marker is unavailable or its
creation fails with confirmed termination, main generates the credential
remotely with the selected Node binary at the canonical shell path. System SSH
keeps its shell-path writer, Windows keeps its native secure writer, and the
remote CLI launcher receives the same credential-file path. An unconfirmed
marker teardown retains the lock rather than authorizing a competing writer.

The review compared sentinel extension and the single request against one
readiness authority, no first-spawn race, authenticated owner replacement,
response publication fencing, reconnect idempotency, exact residue transfer,
and deterministic testability. The single request wins for the authenticated
deployed-relay bridge. A separate capability probe, two-step negotiation, and
a generic cross-transport wire API are not approved.

The local daemon adapter is deliberately not changed in this PR. Its existing
sequential control/stream hello, authentication, exact-version fencing, and
prior-version isolation remain authoritative. Reusing the semantic state
machine there is a later design decision and is not required to ship the SSH
bound.

Every new SSH session offers V1, and every relay from the same build advertises
V1. The server intersects the offer with its supported versions and clamps
`windowSu`; an older client that omits the capability receives bounded legacy
delivery while still establishing the role and generation. Main accepts only
a returned version it offered and a finite safe integer satisfying
`0 < windowSu <= requestedWindowSu`. An absent or invalid V1 grant after
`pty.openClient` succeeds closes that connection attempt rather than silently
downgrading it.

For compatibility with a legacy relay that does not implement
`pty.openClient`, main permits token-free bounded legacy delivery only for the
narrow same-build-validated JSON-RPC method-not-found result. Other errors,
missing grants after a successful method call, and unproved version skew fail
closed. This fallback does not change the normal same-build contract: the
session offers V1 and the relay advertises and grants it.

“Bounded legacy” is transport backpressure, not a hidden source-credit mode.
It creates no delivery token, source window, or cumulative ACK obligation, and
the relay continues to ignore legacy `pty.ackData`. Slice 3 retains at most
2 MiB of ordinary publications per client and 32 MiB across the relay, with
1 MiB/24 MiB low waters, plus at most one 128 KiB producer-held frame per PTY.
At a cap, `PtyHandler` pauses the PTY; accepted write callbacks/drain remove
transport publications, and crossing both low waters resumes it. Slice 2/4
read pauses propagate through SSH until the relay writer saturates, so stalled
model admission remains bounded without pretending renderer ACKs reached the
relay.

Legacy exit waits only for preceding transport publications and the exit write
callback; main's receive-exit barrier below still waits for its admitted model
and projection work. Transport close cancels the connection's retained
publications and reconnect uses the existing replay/restore behavior. It may
pause all legacy subscribers behind one slow connection because legacy mode
has no authenticated source-owner role, but it neither drops output nor grows
without bound. These mechanics remain available to negotiated legacy peers.

The session hello creates no PTY token. A later V1 spawn/attach returns a fresh
`deliveryToken` and creates a subscription only for the authenticated
transport client and installed generation. `pty.attach` must receive request
context just as `pty.spawn` does. Spawn failure, identity mismatch, stale
context, and response cancellation create no active V1 subscription. A legacy
spawn/attach returns the current identity/replay shape and creates only the
bounded transport subscription above—no token or source coordinate. A live V1
token never rotates into legacy service; disconnect closes it before any
separately negotiated legacy fallback connection can open.

Session ownership is granted by the authenticated session hello, not
constructor-assigned:

- fresh relay deploy writes one endpoint credential beside the versioned
  endpoint, reusing the local daemon's token-authenticated-hello pattern rather
  than inventing a second claim protocol. It has mode `0600` on POSIX or a
  current-user ACL on Windows. `--connect` proves it; a plain dispatcher socket
  without the credential is subscriber-only. Primary relay stdio and WSL
  child stdio remain unproved bounded-legacy transports. The adapter converts
  proof into `allowSessionOwner = true` and does not expose the credential to
  RPC handlers;
- the main creates one opaque `clientInstanceId` for its relay-session
  lifetime. The first authenticated owner hello when no owner exists binds
  that identity, returns a lease, and starts owner generation 1;
- until that first grant crosses its write fence, a retry with the same
  authenticated identity is idempotent and any competing identity is rejected.
  Once fenced, replacement requires both the current lease and expected
  generation;
- an unexpected owner disconnect retains that lease and its PTY grace cursors
  for 30 seconds. A reconnect presenting the lease and expected owner
  generation atomically increments the generation, rotates the lease, replaces
  the old client, and transfers grace ownership before any new token activates;
- a same-generation retry is idempotent only for the same live client.
  Competing, stale, lease-less, or unauthenticated identities cannot replace
  the owner and may connect only as ordinary subscribers;
- after grace expiry, the old owner lease is invalidated and the next
  owner-authorized session hello can elect a new owner at the daemon's next
  monotonic owner generation; generations are never reused. Ordinary
  subscribers never inherit owner teardown protection merely by arriving first.

Source activation, `pty.data`, recovery completion, ACK, and cancellation
carry client/owner generations and the delivery token. `pty.exit` retains its
existing PTY ID plus incarnation shape and resolves against the already
installed delivery identity; it cannot create or rotate one. Main rejects a
generation other than the one installed by its synchronous response hook. The
constructor stdout client is never implicitly a session owner. Production
launches detach on POSIX and Windows, invalidate stdout, and connect the
desktop bridge through `attachClient` over the versioned Unix socket or named
pipe. Unproved direct stdio remains subscriber-only.

Capability support is negotiated on every SSH session. `SshRelaySession`
always offers V1 during initial connection and automatic reconnect, and POSIX
and Windows relays always advertise it as an unconditional capability. Sink
drain, writer ordering, decoder bounds, and header-ACK hardening remain
unconditional correctness fixes.

Production deployment does not form arbitrary mixed-build main/relay pairs.
`computeRemoteRelayDir` content-hash-scopes the install directory and its
socket/named-pipe endpoint, and the `.version` handshake is a second fence, so
the desktop bridge and daemon reached at that endpoint share a build. The
normal same-build mode is session-granted V1. A missing mandatory session grant
fails readiness except for the narrow method-not-found compatibility fallback
above. Protocol tolerance for unknown fields remains for direct/manual relay
launches, but an absent session contract outside that fallback is diagnostic
`unsupported-version-skew`, not a deployment cohort.

The reachable upgrade skew is an orphaned prior-version daemon in its old
version directory with live PTYs while the new main connects to a new endpoint.
It retains its old behavior until its own grace/cleanup completes and is not
reachable by a new same-build session. Upgrade diagnostics enumerate
these versioned orphan processes; V1 neither adopts their PTYs nor claims to
bound their memory.

Unknown fields are never capability proof. Place the transport-neutral state
types with the narrowest shared session package, while relay/daemon/runtime
wire types remain in their current protocol packages. Do not make the local
provider depend on relay framing for code reuse.

### Data and ACK schema

Flow-controlled output is:

```ts
// relay -> one subscribed client
{
  jsonrpc: '2.0',
  method: 'pty.data',
  params: {
    id: string,
    ptyIncarnation: string,
    data: string,
    deliveryToken: string,
    clientGeneration: number,
    ownerGeneration?: number,
    sourceEndSu: number,
    sourceLengthSu: number,
    seq?: number,
    rawLength?: number, // required and equals sourceLengthSu when transformed
    transformed?: true
  }
}
```

For untransformed frames, `sourceLengthSu = data.length` and `rawLength` is
absent or equal. For `transformed: true`, `rawLength` is required, finite,
safe, non-negative, and equals `sourceLengthSu`; display length is never used
as source credit. A violation cancels the token as malformed. `sourceEndSu` is
the monotonic cumulative coordinate within one opaque `ptyIncarnation`, not a
display offset. A new token starts with `sentEndSu == creditedEndSu` at its
declared checkpoint, so its absolute coordinate still satisfies the window
equation. The source interval is
`[sourceEndSu - sourceLengthSu, sourceEndSu)`. It is independent of `seq`,
which remains the terminal-model source sequence.

The wire does not send `providerGeneration` or `spanId`. Main supplies its
locally allocated provider generation and derives
`spanId = deliveryToken:sourceStartSu:sourceEndSu`; together with `id`,
client/owner generations, incarnation, token, source/display ranges, and
transform metadata, that forms the immutable admission identity. No later
queue, snapshot, ACK, detach, or replacement path may reconstruct identity
from PTY ID, byte count, or display length alone.

ACKs are cumulative and coalescible. Main holds the latest settled end per
token and emits at most one batched notification per SSH session every 8 ms,
or immediately when any token frees at least 64 Ki su:

```ts
{
  jsonrpc: '2.0',
  method: 'pty.ackData',
  params: {
    acknowledgements: Array<{
      id: string,
      deliveryToken: string,
      clientGeneration: number,
      ownerGeneration?: number,
      creditedEndSu: number
    }>
  }
}
```

One frame contains at most 64 latest-value entries; another turn handles the
remainder. Replacing a queued entry for the same token is lossless because the
value is cumulative. ACK frames use the reserved control lane and never one
frame per data frame.

The relay normally accepts an entry only from the owning dispatcher client and
only when `creditedEndSu` is a finite safe integer satisfying
`previousCreditedEnd <= creditedEndSu <= sentEnd`:

```text
if creditedEndSu > previousCreditedEnd:
  creditedEnd = creditedEndSu
```

Negative, non-finite, unsafe, fractional, over-credit, wrong-client, wrong-PTY,
unknown-token, and stale-token values are rejected and counted diagnostically;
they never clamp into valid credit. Duplicate and regressing values are
no-ops. Token generation, not PTY ID reuse, defines the credit lifetime.

The writer callback is not guaranteed to run before main processes and ACKs an
accepted frame. If an ACK reaches the relay while that exact same-token send
reservation is pending, the ledger records only its exact source-end boundary;
`sentEndSu` and `creditedEndSu` do not advance yet. Successful send settlement
commits the boundary and immediately applies the reservation. Failed
settlement rolls back the send but retains the reserved boundary, so the next
send must reproduce that exact boundary and cannot admit a shorter or later
slice. Cross-token, interior-boundary, and excessive early ACKs remain errors.

Explicit cancellation is a request so main receives proof:

```ts
// main -> relay
{
  method: 'pty.cancelDelivery',
  params: {
    id: string,
    deliveryToken: string,
    clientGeneration: number,
    ownerGeneration?: number
  }
}
// result
{ canceled: true, sentEndSu: number, creditedEndSu: number }
```

The relay validates client/PTY/token ownership, changes the token to `closing`,
removes its cursor and activation/exit fences, then responds through the control
lane. Duplicate cancellation of the same recently closed token is idempotent.
Main may discard open obligations only after this response drains back through
the mux or the client-generation close proves equivalent cleanup.

Every relay-initiated token close emits this metadata-only control
notification before the token record is forgotten:

```ts
{
  method: 'pty.deliveryCanceled',
  params: {
    id: string,
    deliveryToken: string,
    clientGeneration: number,
    ownerGeneration?: number,
    reason: string,
    sentEndSu: number,
    creditedEndSu: number,
    remainingStartSu: number,
    remainingEndSu: number,
    replacementDeliveryToken?: string
  }
}
```

It covers supersession, activation/exit timeout, reconnect-grace expiry, and
explicit delivery cancellation. `remainingStartSu == creditedEndSu` and
`remainingEndSu == sentEndSu` state the exact source interval still unsettled
at the relay. If the sink cannot drain the proof, its generation close is the
proof. Without a replacement, main cancels the matching remaining obligations
and schedules restore/reattach. With a replacement, it keeps those obligations
in `transferring` until replacement `pty.data` and its fence prove exact contiguous
coverage, then atomically transfers the covered suffix. Any prefix already
included in the proved model checkpoint is canceled as superseded without
re-ingestion; an uncovered or mismatched remainder cancels with
`restoreRequired` instead of being credited. Every source subrange therefore
settles once. Stale generations are ignored.

### Activation, replay, and idempotent spawn

Token creation and response publication are one fenced operation. The exact
activation metadata carried by V1 spawn and attach responses is:

```ts
type PtySourceReceivingActivation = Readonly<{
  status: 'pending'
  clientGeneration: number
  ownerGeneration: number
  ptyIncarnation: string
  deliveryToken: string
  checkpointSourceEndSu: number
  recoveryEndSu: number
}>

type SpawnResult = {
  id: string
  incarnationId: string
  sourceActivation?: PtySourceReceivingActivation
}

type AttachResult = {
  incarnationId: string
  replay?: string
  sourceActivation?: PtySourceReceivingActivation
  sourceRecovery?:
    | PtySourceReceivingActivation
    | Readonly<{ status: 'restoreRequired'; reason: string }>
}
```

The dispatcher places the metadata-only response on the response lane and
invokes the request's `onResponseSettled` callbacks only from the exact writer
settlement. Success clears relay activation; failure cancels a fresh token or
leaves the exact recovery attempt available to its proved replacement.
Enqueue, `write(true)`, and `write(false)` alone are not activation proof.

The main mux supplies the receive fence. Spawn and attach requests register a
synchronous `beforeResolve(result)` hook in their pending-request record.
`handleResponse` parses the whole response and provisionally installs
`sourceActivation` before resolving the Promise. The lease captures the exact
prior receive state, candidate token, and a private ordered list of same-turn
source frames. Spawn and non-recovery attach commit only after operation-ID
result, incarnation, claimed-owner, attach identity, stale-attempt, and exit
validation. Reconnect first validates the owner, incarnation, token,
checkpoint, and recovery end, installs the exact private quarantine, then
transfers the lease to its private sink before awaiting the body/completion
fence. That transfer cannot update ordinary provider listeners or
`livePtyIds`, and it cannot reach the model, runtime, desktop, or remote
consumers. Final commit switches future exact-token frames to ordinary
publication only after the body, fence, model admission, and activation
validation succeed. Any failure before transfer
retires the candidate and drops its held data, restores only the nearest
non-retired predecessor, then waits for a valid `pty.cancelDelivery` response
from the originating mux. After transfer, recovery cancellation or
provider-generation close owns cleanup; rollback is no longer authoritative.
It cannot erase a newer revision or cancel a newer token. An identical
already-committed activation is an idempotent no-op; an identical provisional
activation is stale. Fresh-spawn rollback that cannot prove cancellation
surfaces `execution_owner_unavailable` rather than claiming the old token
retired.

The receive cursor starts at `checkpointSourceEndSu`, not
`recoveryEndSu`. Source-bearing notifications for the installed identity may
then advance only contiguously. Frames through `recoveryEndSu` stay
quarantined as recovery; later frames stay held until the exact completion
fence commits. Unknown or mismatched source identities are rejected before
`livePtyIds`, runtime, renderer, or source obligations change. Exact
source-bearing frames carry their immutable `ptyIncarnation` directly and do
not invoke or mutate the legacy incarnation resolver.

Every exact-token private frame advances a monotonic observed-source high-water
before quarantine retention or `restoreRequired` checks. If exact exit arrives,
main wakes the recovery fence and seals the private lease immediately. It may
publish exit only after the held contiguous prefix is admitted, or after
`pty.cancelDelivery` proves `sentEndSu` covers that high-water and the accepted
checkpoint remains the credited end. Capacity-rejected and post-restore frames
therefore cannot disappear below the cancellation proof.

Output produced while a token is activating is retained by its bounded shared
cursor and can pause the native PTY; it is never sent early. Output arriving
after main's synchronous install but before authority commit is bounded by the
provisional lease and is not visible to runtime, desktop, remote consumers, or
`livePtyIds`. Main drops unknown-token notifications before any side effect.

Before issuing attach or any same-client replacement, main serializes each
`(providerGeneration, appPtyId)` through a migration fence: freeze new
old-generation intake, cancel queued-but-unstarted model entries, await the one
in-flight emulator callback, then record the last completed receipt. A later
overlapping reconnect preserves and awaits an earlier fence for the same PTY;
an empty newer generation cannot expose the earlier checkpoint. Before the
deadline, every old callback remains owned by its admission and generation
until raw completion settles. Stale-owner retry invalidates the checkpoint
value but retains the same fence, then requests restore after it settles. If
the 10-second migration deadline expires or the callback fails, admission
checks the exact active migration before its generation-fatal default. Main
cancels only that admission, detaches that PTY's old headless model, prefers
provider/renderer snapshot restore, and requests `checkpointUnavailable`;
recovery reports `restoreRequired` instead of replaying a guessed gap. The
shared mux, sibling PTYs, filesystem, and Git traffic remain live. Outside an
active exact-PTY migration, the same callback failure still closes its provider
generation. Late raw completion stays on the detached model and cannot advance
the canceled source checkpoint.

Attach sends `sourceRecovery: { status: 'checkpoint', clientGeneration,
ownerGeneration, ptyIncarnation, deliveryToken, acceptedSourceEndSu }`. A
queued, in-flight, or merely rendered span is not a checkpoint. Without a
proved fence it sends `{ status: 'checkpointUnavailable' }`.

The relay accepts the checkpoint only for the same incarnation and within
`[oldCreditedEndSu, retainedLiveEndSu]`. It never clamps a value forward,
trusts a value beyond sent/retained data, or replays freed pre-credit source;
an invalid or uncovered checkpoint cancels the attempted delivery and returns
the token-free `restoreRequired` arm. The canceled record remains installed and
cancellation-authoritative until that metadata response settles. Settlement
deletes it only if the delivery map still points to the exact record and wakes
capacity; a retry can then mint a fresh token. It does not activate a
subscription or stream a partial gap; main either restores an authoritative
model generation before retry or surfaces the gap.

The reconnect coordinator consumes `restoreRequired` and owns snapshot-backed
replacement. A generic existing-session provider reattach has no such recovery
owner, so it maps `restoreRequired` to `SSH_SESSION_EXPIRED` instead of
returning an outputless live PTY; the existing renderer fallback may then
replace that stale session.

Recovery bodies use the ordinary source-bearing `pty.data` schema. The new
token initializes `sentEndSu = creditedEndSu = checkpointSourceEndSu`, and
the retained gap covers exactly
`[checkpointSourceEndSu, recoveryEndSu)`. Each frame consumes the normal
window and bounded model admission; there is no separate recovery body method,
stream ID, or replacement-only snapshot kind on this SSH wire.

Only after the last recovery `pty.data` writer callback succeeds does the relay
attempt this metadata-only control notification:

```ts
{
  method: 'pty.recoveryComplete',
  params: {
    id: string,
    clientGeneration: number,
    ownerGeneration: number,
    ptyIncarnation: string,
    deliveryToken: string,
    checkpointSourceEndSu: number,
    recoveryEndSu: number
  }
}
```

`recoveryCompletionPending` permits one admitted attempt at a time. If control
capacity rejects it before admission, the record retains both range ends and
the capacity callback retries; repeated capacity signals cannot enqueue
duplicates. Only the completion notification's successful writer settlement
clears recovery state and permits buffered live `pty.data`. A failed
settlement leaves recovery fenced for exact owner replacement or cleanup.

Notification-style `pty.replay` remains the legacy attach compatibility path.
`pty.serialize` remains its existing bounded metadata response; neither is a
second V1 source-recovery body channel.

Main quarantines the entire candidate recovery transaction until it can prove
the fence. The first source-bearing recovery range must start at the accepted
checkpoint, every later range must be exactly contiguous, and the final end
must equal `recoveryEndSu`. Empty recovery is valid only when the checkpoint
already equals `recoveryEndSu`; main retains that end as the required start of
the first later live frame even after activation. The first live frame and
every successor must also be exactly contiguous. Gap, overlap, incomplete
suffix, missing body, bad empty recovery, or bad live handoff reaches neither
the model nor desktop projection.

A failed or stale recovery attempt cancels only its own replacement token.
It never sends cancellation on a newer mux, clears a newer checkpoint, shuts
down the physical PTY/process, deletes PTY ownership, or expires the owner
lease. A valid matching token-scoped cancellation proof is applied locally and
leaves the lease detached and retryable. If the current attempt cannot publish
cancellation or local proof application rejects, the session fails closed:
it closes the exact provider generation with
`ssh_source_recovery_cancellation_failed`, disposes that generation's mux,
provider, ACK/cancellation publishers, provisional lease, and registration
once when still provisional, or its transferred activation state after
quarantine ownership begins, and reconnects without clearing physical PTY
ownership. If the attempt is already stale, it performs no cleanup against the
replacement. A fresh
relay that no longer retains the cached owner returns typed error `-32041`;
main clears only the cached owner/checkpoints and retries `pty.openClient`
exactly once without `resume`.

Idempotent agent-session spawn has two layers. The cached
`agentSessionCreateOperationId` promise returns only the physical PTY
identity/outcome. After that promise resolves, every current, non-stale outer
`pty.spawn` request creates its own requesting-client subscription and
activation fence. Creating a token for an existing
`(clientId, clientGeneration, ptyIncarnation)` is one atomic supersession
transaction: create the replacement cursor first, move the old token to
`closing`, cancel its outstanding activation/exit work, emit
`pty.deliveryCanceled(reason='superseded')`, and return the old token in the
new response. The cancellation names the replacement token and exact remaining
old span. Main transfers that span only after matching recovery completes;
otherwise it cancels it and restores. The pair therefore has at most one
active token and no range is both canceled and replayed as new model input. A
retry served from the cache receives one fresh token, never a duplicate live
subscription. If the client becomes stale after physical commit, no token
survives; the next retry can subscribe to the retained PTY.

## Relay output architecture

Split policy from lifecycle and transport:

- `pty-source-credit-ledger.ts`, `pty-source-credit-record.ts`, and
  `pty-source-replay-index.ts` own cumulative token state, immutable retained
  source records, exact replay ranges, rotation, and reclamation.
- `relay-pty-source-publication.ts`,
  `relay-pty-source-activation.ts`,
  `relay-pty-source-send-scheduler.ts`, and
  `relay-pty-source-exit-publication.ts` own activation/restore settlement,
  16 Ki-su publication, recovery, exit barriers, budgets, and subscriber
  scheduling.
- `dispatcher-client-writer.ts` owns the one writer per sink, activation
  fences, lane queues, drain callbacks, and close settlement.

`PtyHandler` retains PTY lifecycle, the 8 ms initial/1 ms continuation cadence,
immediate interactive/transformed publication, replay tail, streaming
transform state, and idempotent native `pause()`/`resume()`. It publishes
immutable source spans rather than broadcasting notifications.

### Cumulative span ledger

Each PTY ledger is append-only until every cursor has passed a span:

```ts
type RelaySourceSpan = {
  spanId: number
  sourceStartSu: number
  sourceEndSu: number
  data: string
  splittable: boolean
  retainedBytes: number
}

type PtyDelivery = {
  state: 'activating' | 'recovering' | 'active' | 'sealed-unsettled' | 'closing' | 'closed'
  clientId: number
  clientGeneration: number
  ownerGeneration?: number
  deliveryToken: string
  cursor: { spanId: number; displayOffset: number; sourceOffsetSu: number }
  sentEndSu: number
  creditedEndSu: number
}
```

Different subscribers may stop at different offsets in one span. A cursor
contains both display and source offsets, so no global chunk split can lose or
repeat a suffix. Data storage may coalesce adjacent splittable spans for a
frame or slice one span per cursor; the immutable source boundaries and
cumulative ends do not change. Reclamation requires every live, activating,
sealed-unsettled, closing, or reconnect-grace cursor to pass the complete
span. Native process exit seals admission but does not weaken reclamation.

The transform publisher cuts source input into scalar-safe pieces, never
between a surrogate pair, and records each display result against its source
interval. An untransformed span may be 16 Ki su and is sliced per sink.
A transformed span is indivisible after publication, so its publisher reduces
the source slice until the encoded span is at most 8 KiB, below the token
window, and no larger than the sink's empty non-reserved capacity. An
implementation that cannot stream a transform must pause before the hard limit
and request model restore; it may not over-credit, truncate, or send an
oversized or permanently inadmissible frame.

The existing 100 Ki-su replay-tail policy and the chunked
`RecentPtyOutputBuffer` representation from `79ec57d04` remain.
`PtySourceReplayIndex` now provides the bounded parallel source-range index
without restoring the former rolling-string re-slice. Legacy replay still
materializes the same display tail. V1 restore additionally preserves
incarnation, exact source ranges, and transform metadata. Index eviction
follows the buffer's exact retained prefix and never fabricates a mapping; the
existing append-path equivalence/performance contracts remain in force.

### Scheduling and fairness

The relay scheduler uses deficit round-robin over PTYs, then rotates subscribed
clients for the selected PTY. One scheduling turn admits at most:

- two PTY frames;
- 32 Ki su;
- 2 ms of scheduler work.

Requeue work with `setImmediate` after any limit. Input and control requests can
therefore interleave with output. A recent-input PTY may move to the front once
per round, but repeated interactive classification cannot consume another
PTY's quantum. Preserve the existing bounded interactive fast path: after any
already-queued liveness/control frame, if its token is active, has no earlier
backlog, remaining window covers the exact slice, and the writer admits it
without reserve use, publish one echo frame of at most 4 Ki su immediately
instead of waiting for the 8 ms timer or DRR. Allow at most one such frame per
input epoch; it advances the same cursor once and then yields to normal
priority selection.

For each live/interactive candidate, all gates must be open:

```text
frameSourceLengthSu <= windowSu - (sentEndSu - creditedEndSu)
client writer admits PTY bytes without consuming its control reserve
token state == active
```

For a splittable span, the admitted slice is at most
`min(16 Ki su, remainingWindowSu)`. An indivisible transformed span is admitted
only when its entire source length fits. There is no one-frame window
overshoot. Dispatcher admission creates one pending send reservation. A
`write(false)` still gives Node that frame exactly once, but the cursor and
`sentEndSu` commit only on successful writer settlement; failure rolls back
the reservation. No later ordinary frame is admitted meanwhile. Unsent frames
remain ledger-owned. Liveness, control, interactive PTY, ordinary source PTY,
and bulk are reconsidered on every writer turn. Recovery and live output use
the same source-bearing `pty.data` producer; recovery additionally requires
`token state == recovering`, exact continuity, byte capacity, and
remaining-window capacity.

The V1 source owner and additional subscriber projections use independent
publication transactions:
`projectPtyDataToMatchingClients`/`projectPtyExitToMatchingClients` exclude
the `source-owner` and reserve each remaining client separately. If one
additional subscriber cannot reserve bounded writer/publication capacity,
close only that client and continue the healthy subscriber and source-owner
sends; never pause or tear down the native PTY solely for that projection. A
legacy-fallback primary is different: it remains a required bounded-legacy
backpressure participant and is not evicted for saturation. Constructor
position still grants no session-owner role.

Pause when every remaining delivery is blocked or either retained-byte hard
cap is reached. Resume only when:

```text
perPtyRetainedBytes <= 1 MiB
relayRetainedBytes <= 48 MiB
at least one delivery can advance, or no delivery remains
```

Both predicates are required; the per-PTY low water cannot immediately resume
while the relay-wide budget remains exceeded. Calls are idempotent because a
last `node-pty` callback may re-enter pause/exit handling.

### Exit

On native exit, seal the PTY's output stream after publishing the last ingress
emissions. The source-owner delivery changes to `sealed-unsettled`; additional
subscriber exits use their independent bounded projection transactions:

1. write all preceding data within normal window and drain rules;
2. once that data is accepted by the sink, write `pty.exit` without waiting for
   the final data ACK;
3. record the exit write callback as `exitPublished` only on explicit success;
   on error, generation-close/cancellation proof owns cleanup. Retain the
   delivery, token ledger, cursor, cumulative ACK state, and timeout while any
   `[creditedEndSu, sentEndSu)` suffix remains;
4. close only when the outstanding suffix becomes terminal through cumulative
   ACK application at the relay, exact transfer to a replacement, explicit
   cancellation, or client-generation close proof.

Never force a final tail past the credit window. An additional subscriber that
cannot admit its projected `pty.exit` is detached without changing the source
owner. For the session owner, cancel only this PTY token after its bounded
deadline, keep the sealed record until ACK, transfer, cancellation, or
generation-close proof, and do not tear down unrelated PTYs. A late valid ACK
against a sealed token remains valid and may complete cleanup. Sealed records
are excluded from the 50-live-native-PTY spawn admission count but remain
charged to retained-data budgets. Relay disposal generation-closes all
records and clears their scheduled work exactly once. Exit listeners and
native PTY disposal run at physical exit; logical delivery cleanup waits for
proof.

Main has a matching receive-exit barrier. Receiving `pty.exit` seals the token
against later data but does not immediately call `runtime.onPtyExit`, retire
the headless emulator, clear desktop ranges, close remote subscriptions, or
send renderer exit. It retains every preceding model receipt, projection ID,
remote mapping, and ACK publication record. In order, it:

1. waits for preceding model receipts;
2. publishes or exactly transfers committed desktop ranges and required
   remote mappings;
3. advances/queues the terminal cumulative source ACK;
4. then invokes runtime and renderer exit cleanup while retaining ACK
   publication state until success or generation-close proof.

The barrier has the same charged 30-second deadline. At expiry, main first
sends token-scoped `pty.cancelDelivery` and waits up to 10 seconds for its
proof without applying it. If the exact barrier/generation still owns the
exit, main transfers published desktop projections to
`ssh-exit-delivery-canceled`, commits the proof to reclaim source spans,
prepares exit once, rechecks generation ownership, finalizes exit, rechecks
again, then closes the projection. This order prevents proof commit from
reclaiming a span before its published projection transfers.

If provider-generation close wins while proof is pending, it rejects and
removes the barrier plus its preparation ownership; cancellation ownership is
operation-local rather than retained in a process-lifetime tombstone. The late
proof performs no transfer, commit, preparation, final exit, or projection
close. If cancellation publication or proof fails while the barrier remains
current, main closes the provider so generation cleanup proves cancellation;
unrelated PTYs are not torn down on the ordinary successful timeout path. A
late emulator callback cannot mutate the reset generation. Thus relay sink
ordering and main asynchronous model ordering are both proved.

Provider generations come from one process-wide monotonic allocator and are
never reused. Main rejects closed generations through sorted, merged inclusive
ranges rather than one retained entry per reconnect. Sequential closes compact
to one range; out-of-order closes preserve exact live-generation gaps until
those generations close, then merge. This keeps stale-generation rejection
exact while retained range count follows live gaps instead of process uptime.

## Dispatcher and transport drain

Every dispatcher client is constructed with one bidirectional transport:

```ts
type SinkWriteResult = 'accepted' | 'saturated' | 'closed'
type SinkWriteSettlement = { ok: true } | { ok: false; error: Error }

type RelayClientTransport = {
  write(data: Buffer, onSettled: (result: SinkWriteSettlement) => void): SinkWriteResult
  writableLength(): number
  writableHighWaterMark(): number
  onDrain(cb: () => void): () => void
  pauseReads(): void
  resumeReads(): void
  close(): void
}
```

Adapters map Node `true` to accepted, `false` to saturated, known-dead to
closed, and map the `stream.write(data, callback)` callback's optional error
to explicit success/failure settlement. Only `{ ok: true }` is a publication
fence. A callback error or thrown error closes the client, cancels the
generation, and cannot activate a token, publish ACK state, or release a source
obligation. A saturated or closed transport is never called again for ordinary
traffic before drain/replacement.
One 13-byte keepalive may bypass a saturated epoch; no second liveness bypass
is allowed until that write callback or drain, so the exemption is constant
space rather than an unbounded queue.

`DispatcherClientWriter` is the only encoder/writer for a client. It owns:

1. a coalesced liveness lane, at most two 13-byte frames;
2. a FIFO control lane, at most 256 frames and 1 MiB encoded;
3. producer-scheduled interactive PTY, ordinary source PTY, and bulk lanes,
   whose frames remain with their producers until the writer admits them.

It reserves
`min(64 KiB, max(1 KiB, floor(highWaterMark / 4)))` below the stream's
high-water mark for liveness/control. PTY, recovery, and bulk admission all
require
`writableLength + frameBytes <= highWaterMark - effectiveReserve`; the
scheduler reduces source slices and reshapable bulk before publish. The
`fs.streamChunk` wire contract is the exception: its fixed 256 KiB raw chunk
and sequence-offset math are preserved, and the `fixed-bulk` lane admits one
encoded frame only when the producer queue and writable sink are empty and
unsaturated. It then obeys ordinary callback/drain settlement before another
producer frame. No producer writes around these gates.
Every transport accepted for a PTY subscription must expose at least 8 KiB of
empty non-reserved capacity. A lower-capacity subscriber is rejected before
token creation, so an already-published indivisible transformed span cannot
become permanently inadmissible.
Liveness is selected first, then control FIFO, interactive PTY, ordinary source
PTY, and bulk; after one producer frame the writer re-runs selection. The
physical stream is still FIFO—V1 does not claim a second SSH channel—but the
finite burst and byte reserve bound head-of-line delay. Control overflow closes
an additional subscriber; overflow on the negotiated session owner is a
transport failure and reconnects that owner generation.

Drain registration is one-shot per saturated epoch. `close`, `error`,
`attachClient`/`detachClient`, owner-generation replacement, and dispose
cancel every outstanding write callback and producer fence exactly once.
`setWrite` remains a test/compatibility seam; production reconnect ownership is
the socket/stdin construction plus `attachClient` and `detachClient`.

In detached relay startup, immediately invalidate the synthetic stdout client
when `stdoutAlive` becomes false. A no-op writer must not look like successful
delivery. The first valid session-owner grant on an `attachClient`
socket/named-pipe client elects the owner; reconnect resume replaces its
generation atomically. Constructor identity and connection order confer no
role.

One `DrainAwareStdoutWriter` owns every byte written to `process.stdout`,
including the initial relay sentinel, handshake residue, dispatcher frames,
and connect-mode forwarding. `runConnectMode` performs
`sentinel -> residue -> socket data` through that writer and pauses the source
socket after stdout saturation; it never mixes ad-hoc `stdout.write()` with
`sock.pipe(stdout)`. The same state contract wraps Unix sockets, Windows named
pipes, and the initial stdio client.

Keepalive frames are independent of PTY credit, use reserved capacity, and have
the single-frame saturated-epoch exemption above. A decoder self-pause or
local writer-saturation epoch suspends dead-link evaluation. Resume calls the
same `rebaseHealthClocks(now)` used after a wake gap: set `lastReceivedAt` and
every existing `unackedTimestamps` entry to `now`, then allow a full timeout
window. Rebasing only received-data age is insufficient because the
outstanding-header-ACK conjunct would remain stale. During a suppressed
interval, keepalive intent coalesces behind one outstanding probe and the
header-ACK timestamp map has a hard entry cap; at 4095 entries it stops
ordinary main-to-relay admission and reserves the final coalesced entry for
cancel/liveness.
No pause fabricates an ACK. Tests sustain both states past 20 seconds and prove
zero reconnect oscillation or timestamp growth.

## Main-process credit ownership

`SshRelaySession.wireUpPtyEvents` remains the provider listener but stops
calling `runtime.onPtyData` and `webContents.send` itself. It validates the
provider generation/token and hands each notification once to a main-only
`SshPtyOutputDelivery` intake installed by `src/main/ipc/pty.ts`. This intake is
the only SSH owner allowed to ingest runtime output, mutate delivery state, or
send `pty:data`.

### Main cumulative ledger

The intake appends immutable wire spans:

```ts
type PtySourceDeliveryIdentity = Readonly<{
  id: string
  providerGeneration: number
  clientGeneration: number
  ownerGeneration: number
  ptyIncarnation: string
  deliveryToken: string
}>

type PtySourceSpan = PtySourceDeliveryIdentity &
  Readonly<{
    spanId: string
    sourceStartSu: number
    sourceEndSu: number
    displayStart: number
    displayEnd: number
    data: string
    splittable?: boolean
    indivisible?: boolean
    transform: {
      transformed: boolean
      rawLengthSu: number
      scalarSafe: boolean
    }
  }>

type SourceSpanRecord = {
  span: PtySourceSpan
  obligations: Map<ConsumerId, SpanObligation>
}

type SpanObligation =
  | { state: 'open' }
  | { state: 'transferring'; to: ConsumerId; reason: string }
  | { state: 'settled'; reason: string }
  | { state: 'transferred'; to: ConsumerId; reason: string }
  | { state: 'canceled'; reason: string }

type TokenAckPublication = {
  obligationsTerminalEndSu: number
  ackQueuedEndSu: number
  ackPublishedEndSu: number
}

type DesktopProjectionSpan = Readonly<
  Omit<PtySourceSpan, 'data' | 'splittable' | 'indivisible'> & {
    splittable: boolean
    projectionSemanticsId: string
  }
>
```

The ledger is separate from `PendingPtyData`. Queue merge, split, remainder,
drop sentinel, query salvage, thinning, and interactive bypass receive no
delivery token and cannot rewrite source spans. At SSH intake,
`SshPtyLegacyProjectionLedger` keeps per-PTY cursors and admits the complete
immutable `DesktopProjectionSpan`; it never receives only `data` plus source
length.
`PendingPtyData` continues to store display batching fields plus an opaque
projection admission ID, not mutable source accounting.

`projectionSemanticsId` addresses an immutable per-admission record containing
the accepted chunk's ordered main-authoritative terminal facts and the
projection queue's before/after bounded scanner snapshots. This preserves
current main's dropped-output DEC mode 2031 subscribe/withdraw salvage without
putting mutable scanner state in the source ledger. A source gap resets the
recorded cross-chunk state before later bytes are admitted.

When the data queue sends a display prefix, drops a pending entry, or replaces
it with salvage, it asks the range queue to consume the same operation. The
range queue—not mutable `rawLength` fields—returns the exact source length and
transform metadata for the renderer payload and consumer obligation.
Admission is transactional:

1. reserve model bytes and create the source span;
2. stage the main terminal facts and before/after projection scanner snapshots;
3. reserve the exact desktop range by `spanId` and `projectionSemanticsId`;
4. enqueue display data and publish only after every reservation succeeds;
5. commit model ownership, main facts, and projection admission together.

If model reservation fails, remove every uncommitted reservation. If
projection admission or `webContents.send` fails, roll back the uncommitted
range selection and restores the prior projection scanner snapshot without
publishing staged facts. After model commit, main facts remain published once
and a send failure atomically transfers the desktop obligation plus committed
projection state to a model-restore marker. Queue merge/split preserves the
ordered admission IDs, salvage/drop transfers exact superseded ranges and DEC
mode 2031 decisions, renderer reload transfers committed desktop obligations
before clearing, and token replacement rejects stale IDs by generation while
exact replacement coverage transfers their ranges. Untransformed source may
split only at a recorded display/source offset; a transformed range stays
indivisible. No rollback fabricates an ACK or destroys a live relay
obligation. Renderer ACK retirement reserves both range and ledger mutations,
validates both, then performs one no-throw commit; neither side becomes
terminal before that commit.

Development assertions enforce:

```text
receivedSu = openSu + transferringSu + settledSu + transferredSu + canceledSu
obligationsTerminalEndSu =
  largest contiguous end whose required obligations are terminal
ackPublishedEndSu <= ackQueuedEndSu <= obligationsTerminalEndSu
```

Only `SshPtyOutputDelivery` may call the V1 cumulative ACK coalescer. The
generic `IPtyProvider.acknowledgeDataEvent(id, delta)` API remains for local
and daemon behavior. Legacy-fallback SSH may still emit its current delta, but
the relay ignores it and no legacy bound depends on it; it is a hard no-op for
negotiated V1 PTYs. At every shared `pty:ackData`, resync, heal,
write-off, drop, salvage, and reload call site, V1 routes renderer display
progress through
`SshPtyLegacyProjectionLedger`: parsing settles exact mapped source ranges and
heal/write-off atomically transfers them. These projection transitions may
advance ledger eligibility already earned by the model, but never emit legacy
`{ id, charCount }` wire traffic or manufacture source progress from a display
count.

ACK eligibility and ACK publication are separate transitions. Terminal
obligations advance `obligationsTerminalEndSu` without waiting for a write
callback. The coalescer independently queues the latest cumulative eligible
end and advances `ackQueuedEndSu`. The mux write callback advances
`ackPublishedEndSu` and permits cleanup only on explicit success; it never
creates eligibility. A synchronous throw, callback error, or close leaves the
cumulative value queued for a generation-aware retry or reaches cancellation
proof on provider close. Coalescing replaces only with a greater cumulative
value, so retries cannot lose an eligible prefix.

### Bounded asynchronous model admission

The charged FIFO per PTY and global scheduler replace the unmetered
headless-emulator `writeChain` contract. `acceptPtyData` returns a Promise
receipt:

1. before capturing the frame, reserve its charged retained bytes against the
   per-PTY and global model-admission budgets;
2. the per-PTY budget covers one full token window and the global budget
   matches the relay retained-data cap, so a conforming owner reaches token
   backpressure before routine admission denial. If a transient frame still
   cannot fit, keep that current decoded frame in a separately charged intake
   slot and leave its model obligation open. Enter selective pressure mode:
   quarantine at most 1 MiB or 64 later PTY data frames in wire order while
   continuing to apply transport liveness, unrelated RPC control, and
   cancellation proofs. Keep `pty.exit`, `pty.recoveryComplete`, activation
   fences, and other source-ordering lifecycle frames behind all preceding
   quarantined data for their token. A same-token cancellation proof may bypass
   only by atomically canceling those quarantined obligations first. Do not
   admit quarantined data out of order. If the reserve fills before capacity
   returns, pause reads and start a 10-second provider-close deadline;
3. enqueue only after capacity is owned. Snapshot all consumer memberships and
   allow bounded desktop/remote fan-out at that point; neither projection
   progress nor queue ownership settles the required model obligation.
   Preserve per-PTY order while allowing fair turns across PTYs;
4. resolve the receipt only from the emulator write callback. Then release the
   queue charge, settle the model obligation, and advance eligible credit;
5. resume admission only after both low waters hold. Rejection cancels the
   token and schedules restore; it never passes through the current
   best-effort swallowed-error path.

The relay writer rechecks control priority after every PTY frame, so the
receive reserve needs to cross only a bounded already-written PTY burst, not an
unbounded producer stream. If no control can be reached within the reserve and
deadline, provider close supplies generation cleanup proof. Selective pressure
never settles, drops, or reorders a data frame and never lets a model stall
silence cancellation indefinitely.

Provider close, token supersession, PTY exit, and runtime disposal cancel
queued-but-unstarted entries and reject their receipts exactly once. An
in-flight emulator callback owns its entry until completion or failure and
must pass its captured token/generation check before committing. Reconnect and
supersession use the migration fence above rather than letting that callback
race a replacement checkpoint. Failure dispatch consults the exact
`(providerGeneration, ptyId)` migration owner before invoking generation close;
this does not suppress the ordinary non-migrating failure policy. The old
Promise chain may remain as the per-PTY execution primitive only after each
link is charged by this scheduler; it is no longer an unbounded owner.

### Desktop, mobile, web, and agent policy

Consumer membership is snapshotted when each span arrives:

- The main terminal model is always required.
  `runtime.acceptPtyDataBounded` returns the asynchronous receipt Promise
  above; it resolves only after the emulator accepts the span.
  Status and agent-session observers derived from that model add no duplicate
  obligation.
- The desktop renderer is a recoverable projection. Parsing settles its
  obligation. Hidden thinning, reload, destroyed-window, send failure,
  pending-cap replacement, or delivery heal atomically transfers the
  obligation to the already-accepted main model and emits a model-restore
  marker before settlement. A transfer requested before the model receipt
  remains pending and commits only when that receipt succeeds. Once the model
  receipt exists, desktop obligations
  remain tracked for main-to-renderer bounds but are not required for upstream
  ACK eligibility.
- A mobile/web/raw agent terminal subscriber that negotiated lossless ACKs is
  required while attached and settles independently from its bounded delivery
  cursor. At its ACK cap it stops sending and remains required; a stall cannot
  auto-transfer itself out of upstream backpressure. On explicit detach or
  replacement, transfer to a snapshot/resubscribe marker if supported;
  otherwise cancel that consumer and close only its stream.
- A legacy or observational remote subscriber is best-effort and creates no
  upstream obligation. It receives bounded fan-out and is dropped/resynced on
  overflow.

Current mobile notification replay remains a separate runtime method and
identity space. Its notification epoch and post-local-delivery watermark prove
notification catch-up only; terminal obligations require the stream generation
and immutable encoded-byte/source-range mapping below.

The token ACK advances when the main model and every currently required
lossless consumer for the contiguous prefix have terminal obligations. A
desktop stall therefore cannot freeze a healthy mobile/web consumer, while an
actually lossless remote subscriber still participates explicitly.

Each lossless remote stream owns an immutable encoded-byte/source-range ledger:

```ts
type LosslessRemoteSendRange = {
  streamGeneration: string
  encodedStartByte: number
  encodedEndByte: number
  providerGeneration: number
  ptyIncarnation: string
  deliveryToken: string
  sourceRanges: ReadonlyArray<{
    spanId: string
    sourceStartSu: number
    sourceEndSu: number
    indivisible: boolean
  }>
}
```

Existing `terminal.multiplex` `ackOutput: 1` remains a byte-delta flow-control
mechanism and creates no SSH source obligation. A required source-mapped stream
must separately negotiate `ackOutputSourceRanges: 1`. The server allocates an
opaque `streamGeneration` in the subscribed control frame; every cumulative
ACK carries that generation and `ackedEndByte`. A reused `streamId`, old
client, legacy `{bytes}` ACK, or stale generation cannot settle the new stream.

The mapping is recorded only when the remote writer accepts that exact encoded
output payload, in the same byte unit used by its ACK window. Batching flushes
on provider generation, PTY incarnation, or delivery-token change. When one
encoded frame contains multiple same-identity source spans, it records their
ordered composite list rather than collapsing them into a proportional range.
An ACK must be a finite safe integer in
`previousAckedEndByte <= ackedEndByte <= lastAcceptedByte`; excessive values
are rejected and counted, never clamped into full settlement. An in-range
partial-frame ACK advances the byte watermark and releases exactly that byte
budget, but retains the covering frame's immutable source mapping and settles
no source units. Only complete recorded frame boundaries settle their exact
ordered source ranges. UTF-8 width, JSON escaping, `rawLength`, and display
transforms are never converted proportionally.

The same attached stream may cross a source-token rotation without transferring
its older unsettled frame. Admission requires the same PTY ID, provider
generation, and incarnation; strictly greater client and owner generations; a
different delivery token; and exact source/display continuity. The ledger then
rebinds future frames to the new identity while older frames retain their own
immutable identity and settle at their encoded boundaries. Equal, lower,
partially advanced, cross-provider, cross-incarnation, or same-token rotations
are rejected. Before stream replacement, snapshot recovery, or detach, create
the replacement owner and atomically transfer every remaining mapping;
otherwise cancel that consumer and its bounded stream. Old stream generations
cannot settle new mappings.

The main registry stores the immutable source identity with each admitted
remote mapping, not only its `spanId`. A replacement reservation moves the
named consumer obligations to `transferring`; only an accepted headed or
headless `SnapshotEnd` publication at or beyond the reservation's required
sequence commits them. Stale generation, failed publication, disconnect, or
explicit rollback restores the original live-stream obligation. If
token-scoped cancellation proof has already reclaimed the authoritative span,
late ACK/settle prunes the cached mapping, detach skips absent spans, and a
replacement commit returns false without dereferencing the reclaimed record.
Rollback then deletes the exact reservation and skips already-absent spans.
These paths are idempotent and create no credit.

ACK-pending output overflow uses the same transaction. For a source-mapped
stream, serialize the bounded snapshot, reserve only immutable spans whose
model-sequence end is covered by its `seq` through
`reserveRemoteTerminalSourceRangeReplacement`, publish every snapshot frame,
then call `commitRemoteTerminalSourceRangeReplacement` against the exact
current stream generation, snapshot source identity, and sequence. Only after
commit may the server trim queued chunks with
`chunk.seq <= snapshot.seq` and clear the overflow marker. Serialization,
publication, or commit failure calls
`rollbackRemoteTerminalSourceRangeReplacement`, preserves the live
obligations, reports the stream error, and detaches that stream. One
`ackRecoverySnapshotInFlight` flag bounds the operation to single-flight.
At the encoded-byte ledger, snapshot replacement commit is itself idempotent:
duplicate commits and commits after close are no-ops, preserve cumulative byte
coordinates, and remove only source mappings covered by the authoritative
snapshot sequence.

The stall policy is deliberately split. Desktop-only parse failure reaches its
bounded projection cap, transfers to model restore, and lets upstream credit
continue. A stalled model receipt or attached lossless remote has no automatic
projection transfer: its required obligation stays open, the token window
exhausts, and the relay pauses the native PTY when every remaining delivery is
blocked. Only an explicit, capability-proven snapshot/resubscribe transition
can transfer a lossless remote obligation.

### Exactly-once lifecycle

`settle`, `beginTransfer`, and `cancel` are compare-and-set operations from
`open` for both the upstream token span and each consumer obligation.
`transferring` becomes `transferred` only after the named replacement fence or
becomes `canceled` on mismatch/failure; duplicates are no-ops with diagnostics.
Required obligations becoming terminal advances
`obligationsTerminalEndSu`. That transition makes the cumulative ACK eligible;
it does not wait for ACK publication. The coalescer advances `ackQueuedEndSu`,
and only the later mux write callback advances `ackPublishedEndSu` and allows
record reclamation. A token span begins transfer only when the relay atomically
moves reconnect-grace ownership to a new token and the attach response
declares the new cumulative boundary, or cancels after
explicit/connection-close proof. The transaction creates the replacement
owner before marking source `transferring`; only exact recovery-complete
coverage terminally transfers it.

| Event                                                 | Mandatory transition                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| spawn/attach response decoded                         | install provisional `sourceActivation` in synchronous `beforeResolve`; hold same-turn data privately; spawn commits after full operation validation, while reconnect transfers into an exact private recovery quarantine after contract validation and commits after fence/admission |
| invalid-checkpoint `restoreRequired`                  | keep the canceled relay record through response settlement; retire only the still-current record, wake capacity, and permit a fresh-token retry                                                                                                                                      |
| model accepts; desktop/mobile parses                  | settle that consumer                                                                                                                                                                                                                                                                 |
| hidden thinning, empty transform, pending-cap salvage | preserve ordered terminal facts/scanner state, then transfer desktop to model and emit restore marker                                                                                                                                                                                |
| renderer reload/destroy/send failure/heal             | transfer all desktop obligations to model before clearing queue/accounting                                                                                                                                                                                                           |
| pane closes while provider/token remains live         | transfer recoverable views, then request token cancel if no required consumer remains                                                                                                                                                                                                |
| PTY exit                                              | relay seals token; main retains prior receipts/projections/remotes; runtime/renderer exit only after terminality or bounded cancellation proof                                                                                                                                       |
| provider replacement/reconnect                        | close old client generation; transfer only exact ranges proven by replacement recovery, otherwise cancel and restore                                                                                                                                                                 |
| relay `pty.deliveryCanceled`                          | without replacement, cancel matching remainder and restore; with replacement, enter `transferring` pending coverage                                                                                                                                                                  |
| same-client token supersession                        | create replacement first, transfer exact covered remainder after recovery, cancel any uncovered range                                                                                                                                                                                |
| empty or non-empty recovery completion                | require checkpoint-to-`recoveryEndSu` continuity, retain that live-start anchor after activation, then admit only an exactly contiguous live frame                                                                                                                                   |
| exact exit during private recovery                    | wake the fence, reject later same-token admission, and publish exit only after the held prefix is admitted or exact cancellation proof retires it                                                                                                                                    |
| recovery completion lacks writer capacity             | retain range/fence state and retry on capacity; keep at most one admitted completion attempt                                                                                                                                                                                         |
| stale/overlapping recovery attempt                    | cancel only that attempt's token; never mutate the replacement mux, checkpoint, PTY ownership, physical process, or owner lease                                                                                                                                                      |
| current recovery cancellation publication/proof fails | after quarantine ownership transfer, close the exact provider generation and release its mux, provider, publishers, and registration once; retain physical PTY ownership for reconnect                                                                                               |
| partial remote cumulative byte ACK                    | advance/release exact byte credit; retain the covering source frame and obligation until a complete recorded boundary                                                                                                                                                                |
| contiguous higher-generation source token             | keep the stream attached, bind later frames to the new identity, and preserve unsettled older-token frame mappings                                                                                                                                                                   |
| remote snapshot replacement                           | reserve immutable span IDs/ranges, commit only after current-generation `SnapshotEnd` coverage, otherwise roll back                                                                                                                                                                  |
| snapshot commit after proof reclaimed a span          | reject commit without dereference; rollback removes the exact reservation and skips absent spans; later settle/detach prunes cached mappings                                                                                                                                         |
| remote ACK-pending overflow snapshot                  | reserve covered spans, publish, commit exact snapshot identity/sequence, then trim; rollback and detach on failure                                                                                                                                                                   |
| late remote detach after token cancellation           | prune already-reclaimed mappings and detach idempotently without dereference or new credit                                                                                                                                                                                           |
| exit timeout receives cancellation proof              | while generation-current, transfer projections, commit proof, prepare/finalize once, and close projection with generation checks between mutations                                                                                                                                   |
| provider generation closes during exit proof          | reject/remove barrier ownership; a late proof cannot commit, prepare, finalize, or publish exit                                                                                                                                                                                      |
| provider generations close over process lifetime      | merge exact closed ranges; preserve out-of-order live gaps and reject every closed generation without one tombstone per reconnect                                                                                                                                                    |
| source tokens cancel repeatedly for one PTY           | retain only the latest ordered canceled token for that PTY; replace at the next cancellation and clear at the next activation, PTY exit, or provider teardown                                                                                                                        |
| explicit live-token reset                             | `pty.cancelDelivery` response proves relay cancellation before local discard; failure closes the provider transport                                                                                                                                                                  |
| relay/client dispose                                  | relay cancels token/cursors; main cancels only after close-generation proof                                                                                                                                                                                                          |

There is no “abandon live token” transition. A main-side path that cannot prove
settlement, transfer, or relay cancellation must keep the ledger or close the
provider. Delayed renderer/mobile ACKs carry the consumer generation and cannot
settle a new provider generation or reused PTY ID.

### State-machine pseudocode

```text
session owner:
  none --authenticated claim--> electing(next monotonic generation)
  electing --session-grant write success--> active
  electing --session-grant write error--> none(close generation)
  electing --client close/cancel--> none
  active --proved live replacement/tokens to grace-->
    active(generation + 1, rotated lease)
  active --unexpected client close--> grace
  grace --proved resume--> active(generation + 1, rotated lease)
  grace --30-second expiry--> none(invalidate lease, cancel grace cursors)

relay token:
  create -> activating
  activating --response write success/no recovery--> active
  activating --response write success/recovery--> recovering
  activating --response write error--> closed(cancel generation)
  recovering --completion not admitted--> recovering(retry on capacity)
  recovering --completion admitted--> completion-in-flight(single)
  completion-in-flight --write success--> active
  completion-in-flight --write error--> recovering(exact replacement/cleanup)
  recovering --invalid checkpoint--> restore-canceled-awaiting-response
  restore-canceled-awaiting-response --exact response settles/current record-->
    closed(delete record, wake capacity)
  activating --stale/close--> closed(cancel)
  activating|recovering|active --same-client replacement--> closing(superseded)
  active --native exit--> sealed-unsettled
  sealed-unsettled --exit write success--> sealed-unsettled(exit-published)
  sealed-unsettled --exit write error--> closing(generation proof)
  sealed-unsettled --relay applies suffix ACK/exact transfer--> closed
  sealed-unsettled --timeout--> closing(exit-timeout cancellation proof)
  active --cancel request--> closing
  closing --cancel response/client close proof--> closed

writer:
  writable --write(false)--> saturated --drain--> writable
  writable|saturated --close/error/detach--> closed

main mux writer selection:
  any queued liveness --> select liveness
  control queued and (ordinary empty or controlsSinceOrdinary < 4) --> select control
  ordinary queued --> select ordinary(reset controlsSinceOrdinary)
  control queued after ordinary empty --> select control
  drain --> writable(re-run the same selection; preserve FIFO inside each lane)

main obligation:
  open --consumer receipt--> settled
  open --replacement created atomically--> transferring
  transferring --exact replacement coverage fence--> transferred
  transferring --missing coverage/replacement close--> canceled
  open --relay cancel/close proof--> canceled

main token span:
  open --required consumers terminal--> obligations-terminal
  obligations-terminal --coalescer queues cumulative end--> ack-queued
  ack-queued --ACK write success--> ack-published(cleanup eligible)
  ack-queued --ACK write error--> ack-queued(close/retry)
  open|obligations-terminal|ack-queued
    --attach boundary + replacement created--> transferring
  transferring --exact recovery-complete fence--> transferred
  transferring --gap/replacement failure--> canceled
  open|obligations-terminal|ack-queued
    --cancel response/client-generation close--> canceled

main receive token:
  unseen --beforeResolve--> provisional(cursor = checkpointSourceEndSu, heldData = [])
  provisional --same-turn contiguous data--> provisional(append heldData; no projection)
  provisional --all spawn/non-recovery attach/exit validation-->
    active(commit lease, publish heldData in order)
  provisional --validated recovery contract + private quarantine installed-->
    receiving-activation(transfer lease to private sink, route heldData by range)
  provisional --pre-transfer validation failure-->
    rollback(drop heldData, restore active predecessor, request exact cancellation)
  rollback --valid cancellation response--> prior exact state
  rollback --publication/proof rejects--> fail operation(execution owner unavailable)
  receiving-activation --quarantine exact checkpoint..recoveryEnd + complete fence-->
    active(final commit, expectedLiveStart = recoveryEnd)
  receiving-activation --exact exit-->
    exit-sealed(admit held contiguous prefix or prove exact cancellation first)
  active --first/next live starts at expectedLiveStart--> active(advance expectedLiveStart)
  receiving-activation|active --gap/overlap/bad fence--> canceling-only-this-token
  active --pty.exit--> exit-sealed
  exit-sealed --prior model/projection/remote terminal--> exit-ack-queued
  exit-ack-queued --runtime + renderer exit cleanup--> exited-awaiting-ack-publication
  exited-awaiting-ack-publication --ACK success/generation close--> closed
  exit-sealed --deadline--> acquiring-exit-cancellation-proof
  acquiring-exit-cancellation-proof --proof + generation current-->
    transfer-projection -> commit-proof -> prepare-once -> finalize -> close-projection
  acquiring-exit-cancellation-proof --generation closes-->
    closed(reject barrier; late proof has no authority)
  acquiring-exit-cancellation-proof --proof cannot publish while current--> closing-provider
  receiving-activation|active --overflow/cancel/close--> closed

main provider-generation guard:
  open(g) --close--> closed-ranges(add [g, g], merge adjacent/overlapping)
  event(g in closed-ranges) --> reject(stale generation)
  event(g in an unclosed gap) --> validate PTY incarnation normally
  diagnostics --> closed range count + allocated-unclosed IDs below high-water

main canceled-source retirement:
  none(pty) --cancel token T--> latest(pty, T)
  latest(pty, T) --later ordered cancel U--> latest(pty, U)
  latest(pty, T) --frame T--> drop
  latest(pty, T) --next activation/PTY exit/provider teardown--> none(pty)

remote source ledger:
  frame-open --partial cumulative byte ACK-->
    frame-open(release exact byte delta; retain source mapping)
  frame-open --ACK reaches encoded frame end--> frame-settled(settle exact source ranges)
  old-token frame-open --contiguous strictly higher client+owner generation/new token-->
    old-token frame-open + new-token receiving
  receiving --stale/partial generation advance or identity discontinuity--> reject

remote projection replacement:
  live --reserve immutable spans + required SnapshotEnd seq--> transferring
  transferring --current generation SnapshotEnd covers required seq--> transferred
  transferring --stale/failure/disconnect--> live(rollback)
  transferring --authoritative span already reclaimed-->
    commit-rejected -> rollback(skip absent span, delete reservation)
  live|transferring --authoritative token already canceled--> detached(prune cached spans)

remote ACK-overflow recovery:
  overflowed --reserve snapshot-covered spans--> transferring(single-flight)
  transferring --snapshot publish + exact commit--> live(trim through snapshot seq)
  transferring --serialize/publish/commit failure--> detached(rollback first)
```

```ts
function reserveSshAdmissionAtomically(
  token: DeliveryToken,
  frame: TokenizedPtyData
): SshAdmissionReservation {
  const model = runtime.reservePtyData(frame)
  let span
  let projection
  try {
    span = token.ledger.reserveContiguous(frame, model)
    span.require('model')
    addConsumerObligationsFromCurrentPolicy(span)
    projection = projectionLedger.reserve(toDesktopProjectionSpan(span))
    return { model, span, projection }
  } catch (error) {
    projectionLedger.rollbackIfReserved(projection)
    token.ledger.rollbackIfUncommitted(span)
    runtime.rollbackPtyData(model)
    throw error
  }
}

function acceptSshFrame(frame: TokenizedPtyData): void {
  const token = validateActiveProviderToken(frame)
  let reservation
  try {
    reservation = reserveSshAdmissionAtomically(token, frame)
  } catch (error) {
    cancelTokenAfterAdmissionFailure(token, error)
    return
  }
  const { span, modelReceipt, projectionSpan } = commitSshAdmission(reservation)
  try {
    projectionLedger.publish(projectionSpan, frame.data)
  } catch (error) {
    transferDesktopToModelRestore(span, 'renderer-send-failed', error)
  }
  fanOutToCurrentRemoteConsumers(span)
  void modelReceipt.then(
    (receipt) => {
      span.settle('model', receipt)
      commitPendingProjectionTransfers(span)
      advanceObligationsTerminalEnd(token)
      queueCumulativeAck(token)
    },
    (error) => cancelTokenAfterModelFailure(token, span, error)
  )
}

function retireDesktopDisplayPrefix(id: string, processedDisplayChars: number): void {
  const selection = projectionLedger.reserveDisplayPrefix(id, processedDisplayChars)
  const transaction = ledger.reserveDesktopSettlement(selection.ranges)
  try {
    validateDesktopSettlement(selection, transaction)
    commitDesktopRangeAndLedgerAtomically(selection, transaction, 'renderer-parse')
  } catch (error) {
    ledger.rollbackDesktopSettlement(transaction)
    projectionLedger.rollback(selection)
    throw error
  }
  advanceObligationsTerminalEndForPty(id)
  queueCumulativeAckForPty(id)
}

function replaceDesktopProjection(id: string, reason: string): void {
  for (const obligation of ledger.openDesktopObligations(id)) {
    obligation.beginTransferTo('model-snapshot', reason)
  }
  scheduleModelRestoreAfterReceipts(id, reason)
  commitTransfersWhoseModelReceiptsExist(id)
  advanceObligationsTerminalEndForPty(id) // pending transfers remain ineligible
  queueCumulativeAckForPty(id)
}

function onAckWriteSettled(token: DeliveryToken, endSu: number, result: SinkWriteSettlement): void {
  if (!result.ok) {
    closeProviderAfterAckWriteError(token, result.error)
    return
  }
  token.ackPublishedEndSu = Math.max(token.ackPublishedEndSu, endSu)
  reclaimPublishedPrefix(token)
  maybeCloseSealedDelivery(token)
}

function onRelaySourceAck(record: RelayDelivery, ack: SourceAck): void {
  requireExactDeliveryIdentity(record.identity, ack)
  const pendingEnd = record.pendingSend?.span.sourceEndSu
  if (ack.creditedEndSu > record.sentEndSu) {
    require(ack.creditedEndSu === pendingEnd)
    record.reservedAckEndSu = pendingEnd
    return
  }
  applyCommittedBoundaryAck(record, ack)
}

function retryRelaySourceSend(record: RelayDelivery): SendReservation | null {
  const requiredEnd = record.reservedAckEndSu
  return requiredEnd === null
    ? reserveNextWindowSlice(record)
    : reserveExactSameTokenBoundary(record, requiredEnd)
}

function finishRecovery(candidate: RecoveryCandidate, fence: RecoveryComplete): void {
  const expectedStart = candidate.checkpointSourceEndSu
  const recoveredEnd = validateExactContiguousQuarantine(candidate.frames, expectedStart)
  if (recoveredEnd !== fence.recoveryEndSu) {
    cancelReplacementTokenOnly(candidate.identity, 'recovery-coverage-mismatch')
    return
  }
  commitQuarantinedRecovery(candidate)
  installLiveStartAnchor(candidate.identity, fence.recoveryEndSu)
}

async function rollbackProvisionalActivation(lease: ReceiveLease): Promise<void> {
  lease.dropHeldDataAndRestoreActivePredecessor()
  const proved = await cancelExactTokenThroughOriginatingMux(lease.identity)
  if (!proved) throw executionOwnerUnavailable()
}

function acknowledgeRemoteBytes(stream: RemoteStream, ackedEndByte: number): void {
  const delta = stream.validateAndAdvanceCumulativeByteAck(ackedEndByte)
  stream.byteBudget.release(delta)
  for (const frame of stream.completeFramesThrough(ackedEndByte)) {
    settleExactSourceRanges(frame.sourceRanges)
  }
}

function replaceRemoteConsumer(stream: RemoteStream, requiredSeq: number): void {
  const reservation = remoteRanges.reserveImmutableSpans(stream, requiredSeq)
  publishSnapshotEnd(stream).then(
    (publication) => {
      if (!remoteRanges.commitIfCurrentAndCovered(reservation, publication)) {
        remoteRanges.rollbackSkippingReclaimed(reservation)
      }
    },
    (error) => remoteRanges.rollback(reservation, error)
  )
}

async function cancelTimedOutExit(exit: ExitBarrier): Promise<void> {
  const proof = await requestCancellationProofWithoutMutation(exit.identity)
  if (!exit.isCurrentGeneration()) return
  transferPublishedProjection(exit.identity)
  commitCancellationProof(proof)
  prepareExitOnce(exit.identity)
  if (!exit.isCurrentGeneration()) return
  finalizeExit(exit.identity)
  if (!exit.isCurrentGeneration()) return
  closeProjection(exit.identity)
}

async function recoverAckOverflow(stream: RemoteStream): Promise<void> {
  const snapshot = await serializeBudgetedSnapshot(stream)
  const reservation = reserveCoveredRemoteSpans(stream, snapshot.seq)
  try {
    require(publishSnapshotFrames(stream, snapshot).published)
    require(commitExactSnapshotReplacement(reservation, snapshot.source, snapshot.seq))
    trimQueuedOutputThrough(stream, snapshot.seq)
  } catch (error) {
    rollbackSnapshotReplacement(reservation, error)
    detachRemoteStream(stream)
  }
}
```

Token/span validation, charged admission, and every membership obligation occur
before asynchronous model execution. Desktop/remote fan-out may begin after
the admission budget owns the frame, but the model obligation settles only
after the emulator callback. Admission wait leaves it open and pauses reads at
the charged limit; rejection triggers token cancel rather than acknowledging
data the model did not own. Renderer progress is always display-side input to
the range queue and is never interpreted directly as source units.

## Incremental frame decoding

The actual main transport contract is extended as follows:

```ts
type MultiplexerTransport = {
  write(data: Buffer, onSettled: (result: SinkWriteSettlement) => void): SinkWriteResult
  writableLength(): number
  writableHighWaterMark(): number
  onWriteDrain(cb: () => void): () => void
  onData(cb: (data: Buffer) => void): () => void
  onClose(cb: () => void): () => void
  pauseReads(): void
  resumeReads(): void
  close(): void
}
```

`waitForSentinel` constructs these hooks from the real `ClientChannel`:
`channel.stdin.write(buf, callback)`, writable length/high-water mark, and
`on('drain')` for output, plus
`channel.pause()/resume()` for relay stdout. This covers ssh2 and
`SystemSshCommandChannel`, whose stdout-facing channel implements the same
Readable contract. WSL child stdin/stdout exposes the same metrics,
callback/drain, and pause/resume adapter. The startup residue is delivered once
before later data.

`SshChannelMultiplexer` also owns one main-to-relay writer with exactly three
bounded FIFO lanes:

1. `liveness` for the coalesced probe, including the one saturated-epoch
   bypass;
2. `control` for source ACK, cancellation, exit, RPC request, and response
   frames;
3. `ordinary` for `pty.data`, including PTY input/paste traffic.

The scheduler rechecks priority after every frame and whenever drain reopens
the writer. Liveness wins first. Control wins over queued ordinary traffic
until four control frames have been selected while ordinary remains queued;
the next selection must be one ordinary frame and resets the counter. FIFO is
preserved within each lane. All non-bypass writes still wait for their
per-write callback and `onWriteDrain` after saturation. Producer-side bulk
shaping and fixed filesystem-frame admission remain with their existing
owners; they do not create a fourth mux-writer lane. Thus control cannot remain
behind an old ordinary backlog after drain, ordinary input cannot starve under
a sustained control stream, and V1 ACK settlement has a concrete write fence.

On the relay, the initial client uses `process.stdin.pause()/resume()` and each
accepted Unix-socket/named-pipe client uses `socket.pause()/resume()`.
`attachClient` accepts those hooks; `detachClient` releases them. Handshake
decoders retain synchronous first-frame behavior and transfer both exact
residue and pause ownership to the dispatcher.

Both protocol copies then use this state machine:

1. `feed()` appends buffer views without copying and charges bytes.
2. Drain at most 64 frames or 4 ms.
3. If another complete frame remains, acquire one idempotent decoder pause
   epoch and continue with `setImmediate`.
4. Release the pause only when complete-frame backlog and queued bytes fall
   below low water.
5. `reset`, handshake `drain`, transport close, and dispose cancel the
   continuation and release exactly the epoch they own.

Main model-pressure mode is the one bounded exception to immediate read pause.
It may classify complete frames into the charged 1 MiB/64-frame data
quarantine while dispatching only eligible control/liveness frames, then
either drains data and token-ordering fences in original order or closes the
provider at the deadline. Exit, recovery completion, and activation cannot
overtake a preceding quarantined frame for the same token. It does not scan
past an incomplete or oversized frame and cannot expand the ordinary decoder
input cap.

Handshake consumers require the first complete frame synchronously. Preserve
that behavior, then yield before later frames. `drain()` must cancel a scheduled
continuation and return all unread handshake residue in exact byte order so the
next consumer receives it once.

The decoder permits one advertised valid 16 MiB frame plus 1 MiB input slack.
A partial valid frame keeps reads enabled until that cap; exceeding it closes
the offending transport rather than retaining back-to-back maximum frames.
Oversized payloads are discarded incrementally without full retention.
Sender-side finite PTY bursts and the reserved control lane bound how far a
keepalive/control frame can sit behind PTY data. While paused by this decoder,
the mux suspends both dead-link conjuncts. Resume rebases `lastReceivedAt` and
all outstanding header-ACK timestamps exactly like the existing wake-gap
handler; outgoing keepalives still run.

In `SshChannelMultiplexer.handleFrame`, clamp header `ack` to
`nextOutgoingSeq - 1` and delete only keys already present in
`unackedTimestamps`. Never iterate a dense integer range toward an untrusted
32-bit value. This remains independent from PTY credit.

## Cleanup and reconnect

Every dispatcher client has a generation, and the negotiated session owner has
a separate transferable owner generation. Socket close/error,
`attachClient`/`detachClient`, and dispose invalidate or advance the client
generation atomically. Unexpected disconnect retains the owner generation and
lease through grace; only a proved replacement increments it, and grace expiry
invalidates the lease so a later election starts a new generation. Each
transition:

- cancel read-pause epochs, writer callbacks, and scheduled work;
- reject queued liveness, control, and ordinary mux frames, clear lane heads,
  and reset the four-control fairness counter;
- roll back uncommitted receive-activation leases to their exact prior
  active predecessor, drop lease-private data, and await cancellation of only
  the provisional token through its originating mux;
- after a validated recovery contract transfers the lease, retain held frames
  only in that attempt's bounded quarantine and let cancellation proof or
  provider-generation close own failure cleanup;
- on exact exit, seal the private lease, wake its fence, and either admit the
  held contiguous prefix or validate cancellation against the highest exact
  frame observed before retention/restore decisions;
- fail closed on the exact provider generation when a current recovery cannot
  publish cancellation or validate its proof; provisional spawn rollback
  failure instead surfaces execution ownership as unavailable;
- retain canceled `restoreRequired` relay deliveries until their response
  settlement callback, then delete only the exact still-current record;
- clear or transfer one recovery-completion attempt and its capacity listener;
- move active PTY cursors to reconnect grace or cancel them;
- preserve sealed-unsettled suffixes until the relay applies their ACK, exact
  transfer, or cancellation/generation-close proof;
- retry or cancel queued cumulative ACK state without collapsing
  `obligationsTerminalEndSu`, `ackQueuedEndSu`, and `ackPublishedEndSu`;
- retain or cancel an exact early-ACK send boundary with its owning token;
- roll back uncommitted desktop reservations and transfer committed
  projection IDs before clearing renderer queues;
- cancel uncommitted terminal-fact publications, restore their prior scanner
  snapshots, and transfer committed projection scanner state exactly once;
- roll back any remote snapshot replacement before clearing ACK-overflow state;
- preserve partial remote byte watermarks while retaining covering source
  frames, and prune cached mappings whose authoritative spans were reclaimed;
- reject and remove exit barriers plus cancellation/preparation ownership on
  provider-generation close so late proofs cannot publish final exit;
- close each per-generation model-migration gate after its settlement, remove
  its per-PTY fence and timer exactly once, and retain any earlier outstanding
  per-PTY fence across an overlapping reconnect;
- on migration-owned callback failure, release only that PTY's admission
  charge, timer, and tracked completion before reset/restore; do not close the
  shared provider or sibling admissions;
- replace the latest canceled-token record per PTY on ordered cancellation and
  clear it on exact next activation, PTY exit, or provider teardown;
- release shared spans no longer referenced;
- recompute native PTY pause state;
- expire pending RPC ownership.

Unexpected loss of the session-owner generation with active PTY tokens creates
one `reconnect-grace` cursor per PTY for 30 seconds. It retains at most
512 Ki su and 2 MiB charged bytes per PTY; reaching either cap pauses that PTY
instead of dropping more output. A valid owner resume atomically installs the
new owner generation, transfers each cursor to a new token, and returns only
activation and recovery-range metadata. Source-ranged `pty.data` then drains
before the completion fence and live activation. Expiry invalidates the owner
lease,
emits `pty.deliveryCanceled` when possible, releases the gap, resumes the PTY,
and records restore-required/data-gap telemetry. Ordinary subscriber loss or
no-subscriber state outside owner grace retains only the existing replay tail.

`SshRelaySession.reattachKnownPtys` waits for session-grant readiness and each
PTY's model-migration fence, then runs at most eight attaches concurrently.
Each PTY has its own 10-second attempt deadline and `try/catch`; one failure
cannot abort later PTYs. `notFound` and identity mismatch keep their existing
stale-lease behavior. Other errors are recorded, retried once with bounded
jitter while the same reconnect attempt is current, then surfaced per PTY
without tearing down successful siblings. Time-to-last-reattach is therefore
bounded by waves rather than `N × RTT`.

Reconnect and replay always create new tokens even when IDs are reused. Old
ACKs and callbacks fail generation/token checks. The attach response declares
the exact checkpoint and recovery end; ordinary source-bearing `pty.data`
proves the gap and the completion fence establishes the live boundary, so main
never double-ingests old obligations. Replace
`SshRelaySession.forwardReattachReplay` with this tokenized intake and delete
`RECONNECT_REPLAY_DUPLICATE_WINDOW_MS`/`shouldForwardReattachReplay`: a
wall-clock fingerprint can suppress legitimate identical output, while the
source checkpoint is authoritative. Exit before reattach may still synthesize
`code: -1` after `notFound`; retaining remote exit tombstones is a separate
behavior change and is not required for the memory bound.

Recovery receipt is transactional. Main retains quarantined recovery `pty.data`,
the candidate mux, token, checkpoint, and `recoveryEndSu` until the exact
completion fence validates. It commits no partial body to the model. On
failure it requests cancellation only through the candidate mux and accepts
only matching proof; a stale attempt may not touch current mux state. A
quarantine-only attempt may not yet have a main-intake token identity, so
`SshRelaySession` first requires `canceled: true`, finite safe cumulative
ends, `creditedEndSu` equal to the recovery checkpoint, and `sentEndSu`
covering the highest exact-token source range observed privately. Only then is
the intake's no-identity application an intentional no-op; malformed,
under-covering, or checkpoint-mismatched proof fails closed. A
current attempt whose cancellation publication or proof rejects closes the
exact provider generation and its registered resources once, rather than
leaving ambiguous authority. After a successful empty recovery it keeps
`recoveryEndSu` as a live continuity anchor until the first live frame arrives.
A proved recovery failure marks the existing PTY lease detached and retryable
rather than deleting ownership or terminating the physical process.

For an operation-ID spawn replay, physical result lookup completes first; the
current request then creates and fences a new subscription as specified above.
Disconnect after physical commit/before response leaves the PTY retained but
no stale token.

PTY shutdown and natural exit cancel native pause state before disposing
node-pty. Natural exit may still leave a charged sealed-unsettled delivery
record; only its native process is gone. Relay disposal generation-closes those
records and clears scheduler/exit timers before walking PTYs. A folder
workspace removal follows the same PTY teardown path; no design step assumes a
Git worktree.

### SSH producer-pause intent

Negotiated V1 implements `SshPtyProvider.pauseProducer` and `resumeProducer`
with a token/generation-scoped `pty.setDeliveryPaused` request; window size is
not renegotiated to zero. Relay marks that owner delivery ineligible and pauses
the native PTY only when all required deliveries are ineligible, while another
healthy subscriber may continue. Resume restores eligibility under the
original window. `setPtyBackgrounded` is a separate token-scoped scheduling
hint; it does not itself drop source data or silently convert a lossless model
obligation into keep-tail behavior.

For V1, desktop pending-cap pressure transfers the recoverable projection and
does not call producer pause. Model-admission or required-lossless pressure and
explicit background policy may call it. Local, daemon, and legacy provider
behavior remains unchanged. Update the provider-interface and IPC comments
that currently assume SSH has an independently bounded pending queue.

## Budgets

Every limit has one unit. Source-flow limits use `su`; heap/transport limits use
bytes measured at the point that owns the memory.

| Resource                        |                                 High limit |           Low/flush point | Action                                      |
| ------------------------------- | -----------------------------------------: | ------------------------: | ------------------------------------------- |
| Legacy publications per client  |                                      2 MiB |                     1 MiB | pause affected PTYs; release on drain       |
| Legacy publications per relay   |                                     32 MiB |                    24 MiB | pause affected PTYs                         |
| Legacy producer-held PTY frame  |                                    128 KiB |            next admission | hold one; pause before another              |
| V1 data frame                   |                            16 Ki su target |                         — | scalar-safe slice/coalesce                  |
| Encoded PTY frame               |                                    128 KiB |                         — | reduce source slice before publish          |
| Token outstanding credit        |                                  256 Ki su |      64 Ki su newly freed | stop send / eager ACK                       |
| Sealed-unsettled suffix         |    token window; 30 s timer per subscriber | ACK/transfer/cancel proof | retain ledger; cancel stalled token         |
| Recovery `pty.data`             |                            16 Ki su target |                 next turn | normal source lane before completion        |
| Reconnect-grace source          |                          512 Ki su per PTY |                         — | pause at cap                                |
| Retained live data per PTY      |                                      2 MiB |                     1 MiB | pause source owner                          |
| Retained live data per relay    |                                     64 MiB |                    48 MiB | pause affected source owners                |
| Replay tail                     |               existing 100 Ki su × 50 PTYs |                         — | source-range trim; bytes charged globally   |
| Liveness/control writer reserve |        25% of high water, capped at 64 KiB |                     drain | producer lanes cannot consume               |
| Minimum PTY sink capacity       |                   8 KiB non-reserved empty |                         — | reject PTY subscription                     |
| Metadata control response       |                                     64 KiB |                         — | body must use producer stream               |
| Control queue                   |                         256 frames / 1 MiB |                     drain | close subscriber; owner reconnect           |
| Reshapable bulk producer frame  |         current non-reserved sink capacity |                next frame | slice, admit, recheck priority              |
| Fixed filesystem frame          |               existing 256 KiB raw payload | empty producer/sink epoch | admit one unchanged, then await settlement  |
| Decoder                         |                 16 MiB frame + 1 MiB slack |       no complete backlog | pause/close at hard cap                     |
| Decoder turn                    |                          64 frames or 4 ms |                 next turn | `setImmediate`                              |
| Header-ACK timestamp entries    |                          4095 + 1 reserved |                ACK/resume | stop ordinary writes; coalesce liveness     |
| Main receive-activation hold    |  256 Ki su / 2 MiB per token; 64 MiB total |        recovery completes | pause aggregate; close provider on cap      |
| Main model admission per PTY    |                          256 Ki su / 2 MiB |         128 Ki su / 1 MiB | pause mux admission                         |
| Main model admission global     |                        12.5 Mi su / 64 MiB |          8 Mi su / 48 MiB | pause mux admission                         |
| Main blocked-intake slot        |                          one 128 KiB frame |           model low water | hold blocked frame                          |
| Main pressure control reserve   |                          1 MiB / 64 frames |  10-second close deadline | quarantine data; service control            |
| Main model migration fence      |                                 10 seconds |                         — | reset generation / restore required         |
| Main desktop in-flight          | existing 512 Ki su per PTY / 8 Mi su total |             existing lows | transfer/restore policy                     |
| Lossless remote send ledger     |                2 MiB/stream, 16 MiB global |        1 MiB/12 MiB bytes | stop send; explicit detach transfers/closes |
| Activation/exit/owner grace     |                                 30 seconds |                         — | token cancel/gap policy                     |

Retained strings are charged once as
`max(Buffer.byteLength(value, 'utf8'), 2 * value.length) + 128`; encoded buffers
use exact `Buffer.byteLength`; ledger/cursor entries charge 128 bytes. Shared
strings are not multiplied by subscriber count, but each cursor is charged.
Sent-but-uncredited source units are not described as retained memory.

The table is arithmetically reachable:

- 256 Ki ASCII su charges at most about 512 KiB plus records.
- 256 Ki BMP/CJK su at three UTF-8 bytes each charges about 768 KiB.
- 256 Ki su of surrogate-pair characters has 128 Ki scalar values and about
  512 KiB UTF-8/UTF-16 storage.
- A 512 Ki-su ordinary reconnect backlog is at most about 1.5 MiB for valid JS
  strings; 32 16-Ki-su span records keep it below the 2 MiB per-PTY cap.
  Highly fragmented transformed records bind the charged 2 MiB cap earlier.
  Recovery is streamed and never compared with the 1 MiB control queue.
- JSON control-character escaping can reach six encoded bytes per su, so a
  16 Ki-su frame is below 96 KiB plus envelope and the separate 128 KiB cap.
- A transformed span with `rawLength !== data.length` consumes source credit
  by `rawLength` and heap/wire budgets by its actual retained/encoded bytes;
  neither value is converted into the other.
- Fifty PTYs cannot each reach 2 MiB because the 64 MiB relay cap binds first;
  the independent 48 MiB global low water prevents immediate resume thrash.
- Model admission charges captured strings and queue records before a Promise
  link owns them. Its 64 MiB global high water matches the relay retained-data
  cap and its 12.5 Mi-su high equals 50 token windows, while each
  256 Ki-su/2 MiB per-PTY high covers one full token window; the separate
  128 KiB blocked slot covers the decoder frame that triggered pause without
  hiding it in the model budget.
- Encoded lossless-remote bytes remain charged until full frame-boundary ACK or
  atomic transfer; the ledger's source units are never estimated from bytes.

One re-entrant native callback after `pause()` is a charged transient overshoot.
The callback may cross a retained-memory high cap by at most one charged native
chunk, but it is never admitted past token credit: splittable source is trimmed
to remaining window and an indivisible transform waits. If retained memory
crosses a hard cap, stop publication, mark restore-required, and retain only
the already-owned bounded state. Module constants allow test overrides; Linux
Docker heap/RSS plateaus validate allocator slack before release.

## Telemetry

Expose aggregate counters in existing relay/main diagnostic snapshots without
logging terminal contents or raw PTY IDs:

- active/activating/recovering/closing tokens, owner generation/election/resume
  outcomes, and PTY-subscribing clients;
- paused and reconnect-grace PTYs, grace bytes, recovery/fence latency, exact
  gap ranges, completion retries, expiries, and gap outcomes;
- client writer state, lane depths, reserved-byte denials, and activation-fence
  latency/cancellation, split bulk bytes, and per-priority wait;
- current/peak retained bytes and outstanding su by redacted client/PTY;
- pause count and total paused milliseconds;
- sink saturation count and duration by stdout/socket;
- slow-client detach and control-overflow counts;
- ACK accepted, duplicate, regression, over-credit, malformed, and stale-token
  counts, early-boundary reservations/retries, plus ACK frames/second,
  entries/frame, and encoded bytes/second;
- span obligations opened, transferring, settled, transferred, canceled,
  duplicate-terminal, and oldest-open/oldest-transferring age by consumer
  class;
- per-token obligations-terminal, ACK-queued, and ACK-published ends plus their
  deltas; sealed-unsettled count, suffix size/age, exit-published state, and
  timeout cancellation proof;
- desktop projection reservations, commits, rollbacks, model transfers, stale
  identity rejects, and outstanding source/display ranges;
- model-admission current/peak bytes per PTY/global, blocked duration,
  emulator completion/failure/cancellation, migration-fence latency/timeout,
  late-generation rejects, and low-water resumes;
- lossless-remote encoded bytes, partial/frame-boundary ACKs, mapped source
  ranges, generation rejects, ACK-overflow snapshot reserve/publish/commit/
  rollback, and transfer/cancel outcomes;
- decoder queued bytes, yielded turns, maximum frames/turn, and maximum
  callback duration, read-pause duration, liveness-timeout suppression,
  header-ACK timestamp depth/cap denials, and keepalive coalescing;
- exit-barrier timeout count;
- closed provider-generation range count and active gaps;
- reconnect attach wave latency, per-PTY retry/failure, token supersession,
  relay-initiated cancellation proof, and time-to-last-success;
- same-build V1 grants, capability omissions from legacy clients,
  method-not-found fallbacks, unsupported manual version skew, and discovered
  orphan prior-version daemons, keyed by relay build/version rather than
  legacy ACK traffic.

Rate-limit warnings by connection and reason. Log thresholds and state
transitions, never data. Add an E2E-only snapshot request so tests can assert
plateaus, obligation conservation, pause/resume, and zero false reconnects
without parsing logs.

## Incremental implementation map

This PR implemented the design as the independently testable layers below,
without replacing local/daemon protocols or claiming live evidence for every
deployment topology. The slices remain useful review boundaries even though
they ship in one PR.

### Slice 1: hostile-header and accounting hardening — implemented

- In `src/main/ssh/ssh-channel-multiplexer.ts`, clamp header ACKs and delete
  only present timestamp keys; cap retained timestamps.
- Add focused unit tests for `ack=0xffffffff`, concurrent ACK/timeout cleanup,
  and liveness rebasing.
- No relay, daemon, runtime, or provider protocol change.

### Slice 2: bounded decoder turns — implemented

- In both relay protocol decoders, bound frames and time per turn, preserve a
  synchronous first handshake frame, pause reads during continuation, and
  transfer exact residue on reset/drain.
- Adapt ssh2, system SSH, WSL child stdio, relay stdin, Unix sockets, and
  Windows named pipes behind their existing transport constructors.
- No PTY credit or session negotiation; prior-version peers keep the same
  frame format.

### Slice 3: one drain-aware legacy writer — implemented

- Add a concretely named dispatcher writer owning ordinary, bulk, control,
  sentinel, residue, and `--connect` bridge bytes.
- Route existing `RelayDispatcher.notify`, `notifyBulk`, fs/Git producers, and
  `runConnectMode` through its bounded lane admission; stop after
  `write(false)` until callback/drain.
- Preserve fixed `fs.streamChunk` size/offset compatibility in an exclusive
  empty-sink `fixed-bulk` lane; slice only reshapable bulk and PTY output.
- Because legacy `notify` is synchronous and broadcast, add a bounded
  transport-only publication record containing one encoded frame and the set
  of client generations that have not accepted it. A client returning
  `write(false)` leaves that set because Node accepted the frame; a saturated
  client is retried only for that client, and close cancels its membership.
  This is delivery bookkeeping, not source credit.
- Return producer admission to `PtyHandler`. Until a publication is admitted,
  retain it in the existing PTY pending-output owner; at its hard byte cap
  pause node-pty, then resume below low water. Cap per-client and aggregate
  publication bytes. Before Slice 5a establishes authenticated roles, treat
  every subscribed connection equally: any retained subscriber may pause that
  PTY, and only transport close cancels its membership. Do not infer or detach
  an “additional” client by constructor or connection order. Authenticated
  slow-subscriber eviction begins only after Slice 5a. Never silently drop a
  legacy PTY frame.
- Preserve the current 8 ms/1 ms PTY cadence and current replay semantics. The
  replay tail stays the chunked `RecentPtyOutputBuffer` added in
  `79ec57d04`; `PtySourceReplayIndex` now indexes it without replacing it with
  the former per-append rolling string.
- This slice bounds relay writable queues for legacy main, WSL, direct SSH,
  and detached relay socket/named-pipe clients without changing the wire. The
  separate local terminal daemon is not exercised or changed.

### Slice 4: bounded main SSH intake — implemented

- Make `SshRelaySession.wireUpPtyEvents` hand each event exactly once to a
  main-only intake under `src/main/ipc/`; SSH no longer bypasses the existing
  pending-output authority.
- Meter model admission and its emulator callback chain, reserve before
  capture, pause decoder reads at the cap, and return completion/failure
  receipts.
- Introduce transactional projection admission with a legacy immutable
  admission ID, provider generation, PTY incarnation, display interval, and
  existing sequence/`rawLength`; it has no V1 token or source-credit
  coordinate. Slice 5b extends that record to `DesktopProjectionSpan`. Keep
  local and daemon providers on their existing intake until a shared migration
  is separately justified.
- Preserve current main's ordered terminal side-effect facts and dropped-output
  DEC mode 2031 scanner snapshots across admission, salvage, rollback, transfer,
  and explicit gaps. Preserve `terminal-stream-byte-length.ts` UTF-8 accounting
  and flush boundaries for remote streams; never reuse it as source credit.
- Extend the existing Docker ACK-stall test only for behavior this slice
  implements: direct SSH/deployed relay/desktop intake and active typing.

### Slice 5a: SSH session semantics — implemented for SSH

- Add the transport-neutral `PtyConsumerSession` state machine and only the SSH
  readiness adapter decision above.
- Implement authentication, generation, capability intersection, activation
  fence, close cleanup, exact sentinel/residue transfer, and legacy fallback.
- Carry the endpoint credential through split-SFTP per-launch namespace
  mapping, with secure canonical shell-path generation when no marker exists.
- Local in-process, daemon hello, and remote-runtime adapters reuse semantics
  only when their own changes need it; they are not prerequisites for SSH V1.

### Slice 5b: direct SSH source credit — implemented

- Add the relay immutable span ledger/scheduler and tokenized cumulative ACKs
  for one direct SSH desktop/model consumer path.
- Return exact `sourceActivation` metadata and install its provisional receive
  lease synchronously in mux `beforeResolve`; commit only after provider and
  exit-race validation.
- Reserve reentrant ACKs only at the exact pending same-token boundary and
  retry that boundary after failed send settlement.
- Reuse Slice 4's projection identities and transactional admission. Separate
  obligations terminal, ACK queued, and ACK published state from the first
  implementation.
- Offer V1 on every new session while retaining bounded legacy compatibility
  for capability-omitting clients and method-not-found relays.

### Slice 5c: exit, reconnect, and replay — implemented

- Implements sealed-unsettled exit, cancellation proofs, owner reconnect grace,
  token replacement, and exact transfer.
- Carries recovery as contiguous source-bearing `pty.data` from checkpoint to
  recovery end; fence live output with single-flight, capacity-retryable
  `pty.recoveryComplete` writer settlement.
- Adds a bounded source-range index beside the current
  `RecentPtyOutputBuffer`, preserving its append performance and legacy
  output.
- `SshPtyOutputModelMigration` freezes exact generation/PTy admission,
  `SshRelaySession` awaits the returned per-PTY Promise before constructing
  `sourceRecovery`, and `OrcaRuntimeService` detaches only the failed PTY's old
  headless model before snapshot-backed restore.
- `SshPtyModelAdmission` retains generation-fatal callback handling except when
  the exact key is actively migrating; `SshPtyOutputIntake` uses the same key
  to keep provider close from escaping that migration owner.
- Reconnect always re-offers V1; its late-ACK, timeout, supersession, and
  generation-close deterministic oracles pass.

### Slice 5d: required remote consumers — deterministic seam implemented

- Map remote `terminal.multiplex` encoded-byte ACK frames to accepted source
  ranges without changing its transport authentication or granting it an SSH
  owner lease.
- Add `ackOutputSourceRanges: 1` and an opaque echoed stream generation;
  preserve `ackOutput: 1` delta semantics for old clients and best-effort
  streams.
- Make ACK-overflow snapshot recovery reserve, publish, commit, then trim;
  rollback before detaching on any failure.
- Keep mobile notification replay epochs/watermarks outside terminal stream
  identity and ACK mapping; neither can settle a PTY source range.
- Extend the extracted `terminal-output-frame-chunks.ts` seam with immutable
  composite mapping input while preserving `694363805`'s code-unit scanner,
  allocation profile, sequence rounding, and equivalence benchmark.
- Live headed paired-server and headless `orca serve` validation remains
  required before claiming those topologies; neither is inferred from Docker
  SSH.
- Keep best-effort remote streams outside upstream obligations.

### Slice 5e: adversarial lifecycle reconciliation — implemented

- Retain canceled invalid-checkpoint deliveries through exact
  `restoreRequired` response settlement, then retire only the current record.
- Fail closed on the exact provider generation when a current recovery
  cancellation cannot publish or its proof rejects; release generation-owned
  resources once without clearing physical PTY ownership.
- Allow partial cumulative remote byte ACKs to release byte budget without
  settling an incomplete source frame, and admit only contiguous strictly
  higher client/owner generations with a new token.
- Make encoded snapshot replacement commit idempotent; reject reclaimed-span
  commits and make rollback, settle, and detach prune absent spans safely.
- Split main-to-relay writes into liveness/control/ordinary FIFO lanes, select
  control first after drain, and guarantee ordinary progress after four
  controls.
- Hold provisional activation data until provider/claim/exit validation
  commits for spawn, or until a validated reconnect contract installs its
  private quarantine; rollback owns pre-transfer failure, while cancellation
  proof or generation close owns post-transfer failure.
- Acquire exit cancellation proof before projection transfer and proof commit;
  prepare/finalize once and fence every post-proof step by provider generation.
- Keep timeout cancellation authority operation-local and compact monotonic
  closed provider generations into exact merged ranges without weakening stale
  event rejection.
- Seal private recovery on exact exit, retain rollback authority through a
  stale transfer, and include every exact-token private frame in the
  cancellation-proof watermark.
- Replace process-lifetime per-token blocking state with one latest ordered
  cancellation record per relay PTY, cleared only at an exact lifecycle
  boundary.

### Slice 5f: remaining topology validation and adapters — deliberately deferred

- Local in-process and daemon hello remain unchanged; neither adopts SSH
  framing or source credit in this PR.
- WSL, Windows ConPTY/named-pipe, local daemon/provider, folder workspace,
  mixed-version, and prior-version-orphan live evidence remains separate.
- Promote reliability-gate provider coverage only for topologies with recorded
  executable evidence.

Keep new lifecycle ownership out of already-large modules where a concrete
domain file is clearer. Do not add max-lines disables, generic helper modules,
native dependencies, or a per-file lint exception.

## Tests

The checklist below is the normative matrix, not a claim that every physical
topology or the current shared-worktree diff ran. Implemented seams and prior
recorded evidence include:

- shared session negotiation, grant publication, stale-owner recovery, source
  ledger, ACK queue/publication separation, and cancellation proof contracts;
- relay writer admission/drain/liveness, zero-display source publication,
  operation-ID retry activation, fixed-size filesystem compatibility,
  capacity-aware Git/PTY slicing, decoder caps, and token rotation;
- main model admission, desktop identity/rollback, exit barriers, remote
  reserve/commit/rollback, token cancellation, exact recovery continuity,
  eight-wide reconnect, retention budgets, unconditional negotiation, and
  deployment;
- current-working-tree restore-response retirement, fail-closed recovery cancellation,
  partial remote ACK, higher-generation token rotation, reclaimed-span
  idempotence, three-lane mux fairness, provisional claim gating, and
  generation-fenced exit proof ordering plus bounded exact generation closure;
- the four-test Docker OpenSSH/deployed-relay suite for source-window plateau,
  concurrent typing, fixed-size filesystem/Git churn, and owner reconnect.

The earlier rebased checkpoint at
`38fbf3520741ce4ccd86410f7cea9ff8217a7834` passed:

- frozen dependency setup, full lint, full typecheck, `git diff --check`, and
  the 52-gate reliability manifest validation;
- all Linux, macOS, Windows, and WSL relay build targets plus
  `electron-vite build --mode e2e`;
- 24 focused SSH/source-credit files with 354 tests;
- 14 watcher/daemon/package/glibc-adjacent files with 409 tests;
- a 57-file deterministic changed-surface sweep with 1,186 tests;
- the joined renderer/headless snapshot seam with 59 tests and its broader
  focused slice with 180 tests;
- the relay recovery and fixed-size filesystem/Git slice with 105 tests.

That checkpoint's Docker OpenSSH/deployed-relay run passed all four tests in 1.0 minute:
direct typing median/worst was 107.7/113.6 ms; ACK-stalled typing was
3.6/107.3 ms at an exact 262,144-source-unit plateau; fixed-size filesystem/Git
churn was 148.1/161.1 ms with 93 bulk reads; owner reconnect completed in
15.7 seconds. These measurements are direct SSH/deployed Linux relay evidence
only.

The four-case Docker results predate the final adversarial lifecycle
reconciliation and are not current-head proof for those races. On the earlier
working tree, a deterministic test reproduced recovery completion becoming
visible at source unit 4 while lease-held recovery ended at 8. After the
validated contract began private quarantine ownership before awaiting the
body, seven provider/session files passed 94 tests and the isolated deployed
Linux relay/direct-SSH reconnect case passed in 17.7 seconds with 256 recovery
frames plus post-reconnect terminal/filesystem proof. Against the same
private-transfer artifact, the final four-case run passed in 1.1 minutes:
direct typing was 6.2/7.4 ms median/worst; ACK-stalled typing was 5.5/16.3 ms
at exactly 262,144 held source units; fixed-size filesystem/Git churn was
141.2/151.5 ms with 95 bulk reads; reconnect completed in 16.0 seconds. All
other live topologies remain separate.

After the exact-PTY migration-failure containment fix and current-main merge,
`electron-vite build --mode e2e` and `pnpm run build:relay` produced the exact
artifact hashes recorded above. The four-case Docker command then passed in
56.7 seconds without a source-credit override: direct typing was 5.3/108.9 ms
median/worst; ACK-stalled typing was 4.8/107.6 ms at exactly 262,144 held source
units; fixed-size filesystem/Git churn was 152.0/173.3 ms with 84 bulk reads;
reconnect completed in 14.3 seconds. This is direct SSH/deployed Linux relay
evidence only.

At the implementation commit above, the source/intake slice passed 12 files and 205
tests, the provider/session slice passed 16 files and 192 tests, and this
complementary lifecycle slice passed 13 files and 150 tests:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/relay/relay-pty-source-restore-retry.test.ts \
  src/main/ssh/ssh-relay-session-recovery-races.test.ts \
  src/main/runtime/rpc/terminal-source-range-ledger.test.ts \
  src/main/runtime/rpc/terminal-multiplex.test.ts \
  src/main/ssh/ssh-multiplexer-transport-writer.test.ts \
  src/main/ssh/ssh-channel-multiplexer-backpressure.test.ts \
  src/main/providers/ssh-pty-notification-routing.test.ts \
  src/main/providers/ssh-pty-source-delivery-ledger.test.ts \
  src/main/ssh/ssh-pty-retired-source-deliveries.test.ts \
  src/main/providers/ssh-pty-provider-agent-session-create-operation.test.ts \
  src/main/providers/ssh-pty-provider-exit-race.test.ts \
  src/main/ipc/ssh-pty-output-exit-deadline.test.ts \
  src/main/ipc/ssh-pty-remote-source-range-consumers.test.ts --reporter=dot
```

The deterministic recovery seam specifically covers an empty recovery followed
by a gapped live frame, overlapping reconnect attempts, late frames after
cancel, exact exit during private recovery, stale-transfer rollback authority,
capacity-rejected and post-restore proof watermarks, typed stale-owner retry,
response-settled `restoreRequired` retirement, completion arriving before
lease-held body frames, and fail-closed exact-generation cleanup. A separate
10,000-rotation oracle proves canceled-token retirement remains one record per
PTY. Transferred recovery data remains private until body/fence validation,
and a proved token-local failure causes no physical PTY shutdown, ownership
delete, or lease expiry.
The model-migration failure oracle uses two PTYs in one provider generation:
one raw callback rejects under an active fence, returns
`checkpointUnavailable`, resets one model, and releases its charge and timer;
the sibling checkpoint, provider mux, filesystem/Git transport, and another
provider generation remain live. A paired admission oracle proves the same
failure without an active migration still closes the generation and rejects
its sibling receipt.
The remote-consumer seam covers partial cumulative ACK, safe higher-generation
token rotation, and token cancellation followed by late detach/replacement
commit, proving reclaimed span IDs reject commit, preserve rollback ownership,
and are then cleaned up idempotently.

### Normative unit and property matrix

- accept monotonic cumulative ACKs and reject duplicates, regressions,
  over-credit, invalid numbers, wrong clients, wrong PTYs, and stale tokens;
- prove with generated span/ACK sequences that
  `sentEndSu - creditedEndSu <= windowSu`; at `window - 1`, slice a
  splittable frame to one source unit and hold an indivisible transform;
- generate merge, split, remainder, salvage, thinning, empty-transform, and
  interactive-bypass queue operations and prove ledger conservation;
- split DEC mode 2031 subscribe and withdraw sequences across chunks, then
  inject pending-cap salvage, rollback, transfer, reconnect, and source gaps;
  prove fact order, exact scanner restoration/reset, no duplicate reply, and no
  source settlement from projection metadata;
- put two clients at different display/source offsets in one shared span and
  prove no resend, skip, or early reclamation;
- cover ASCII, BMP/CJK, surrogate pairs, unpaired surrogates, JSON-escaped
  controls, and transformed spans where `rawLength !== data.length`; assert the
  budget arithmetic and reject transformed frames without valid `rawLength`;
- run the shared semantic state-machine suite and the implemented SSH
  socket/named-pipe adapter suite; local and daemon V1 adapters remain
  unimplemented, direct-stdio/WSL has deterministic common-transport evidence
  only, and remote-runtime source mapping is implemented at a deterministic
  seam but unexecuted in a live paired topology;
- verify every new SSH session and reconnect offers V1 and every same-build
  relay advertises and grants it; separately verify a capability-omitting old
  client remains token-free and the narrow method-not-found relay fallback is
  bounded; cover invalid/stale credential or lease rejection, 30-second lease
  expiry, and atomic reconnect generation transfer through POSIX sockets and
  Windows named pipes; prove constructor stdout, WSL child stdio, and an
  unproved plain socket are never elected, and cover POSIX `0600` plus Windows
  current-user ACLs;
- verify split shell/SFTP home discovery, per-launch marker creation under the
  held install lock, credential write before lock release, canonical shell-path
  fallback, system-SSH bypass, and unconfirmed teardown lock retention;
- verify token rotation on spawn, attach, reconnect, provider replacement, and
  same-client duplicate attach/spawn; replacement must cancel the old token
  once, report its exact remaining span, and transfer only matching recovery
  coverage while canceling the already-checkpointed prefix without re-ingest,
  duplicate output, or an open cursor;
- keep one lossless remote stream attached across an unsettled old-token frame
  and a contiguous new-token frame; require strictly higher client and owner
  generations, the same provider/incarnation, a new token, and reject every
  stale or partially advanced identity;
- verify metadata response callbacks precede source-ranged recovery and live
  data in V1, including saturation with older control; use multi-frame
  all-control-character gaps to prove source bodies remain ordinary
  producer-owned `pty.data` rather than control responses;
- feed response, recovery, completion fence, and first live data in one decoder
  turn; prove synchronous `beforeResolve` installs a provisional cursor at
  `checkpointSourceEndSu`; deliver completion before lease-held frames, then
  prove validated reconnect transfers those frames only into private
  quarantine, routes ranges through `recoveryEndSu`, and projects them once
  only after exact body/fence validation. Pre-transfer rollback drops held
  data, restores only the active predecessor, and awaits exact
  token-cancellation proof;
- reject wrong-incarnation checkpoints and checkpoints below old credit or
  beyond retained live end; require a token-free `restoreRequired` response
  with no partial recovery or forward clamping; retain the canceled record
  through response settlement, retire only the exact current record, then
  prove retry mints a fresh token and publishes one live source frame;
- send identical recovery `pty.data` for distinct tokens within one second and
  prove token/range identity, not a wall-clock fingerprint, controls admission;
- retry an operation-ID spawn after commit/before response from a new client;
  prove it receives a fresh subscription and the stale client cannot ACK;
- assert `write(false)` admits exactly one frame, preserves the control reserve,
  and admits no ordinary later frame before drain;
- queue ordinary PTY input before source ACK, cancellation, exit, request, and
  response frames; after drain require liveness/control selection first, FIFO
  within all three lanes, and one ordinary selection after four controls;
- deliver a cumulative ACK reentrantly before the source writer callback;
  reserve only the exact same-token pending boundary, then prove successful
  settlement applies it and failed settlement permits only an exact retry;
- inject asynchronous Node write-callback errors for session grants, token
  activation, recovery completion, exit, and ACK publication; prove none
  advance state and the client generation closes with exact cancellation;
- reject one `pty.recoveryComplete` admission, fire repeated capacity signals,
  and prove one bounded retry is admitted; hold its callback and prove no live
  output or duplicate completion passes before successful settlement;
- reject a PTY subscription whose empty non-reserved sink capacity is below
  8 KiB; prove every admitted transformed span remains writable;
- saturate relay fs/Git bulk; preserve fixed 256 KiB `fs.streamChunk` frames in
  the exclusive empty-sink lane, slice only reshapable bulk/PTY data, and bound
  cancellation, keepalive, ACK, immediate echo, and control latency;
- assert sentinel, handshake residue, and connect-mode socket data use one
  stdout writer in FIFO order under saturation;
- assert close, error, detach, invalidate, replacement, reset, and dispose
  settle/cancel each callback, token, and pause epoch exactly once;
- cover every lifecycle-table row and reject any
  `received != open + transferring + settled + transferred + canceled` state;
- require `pty.deliveryCanceled` or generation-close proof for every
  relay-initiated cancel and reject stale cancellation notifications;
- delay headless-emulator callbacks indefinitely; prove per-PTY/global model
  queues and the one-frame intake slot plateau, upstream credit stops, low-water
  resume is exact, and emulator rejection cancels rather than credits;
- while model admission is blocked, place cancellation/control behind a
  bounded PTY burst; prove the 1 MiB/64-frame reserve services it without
  reordering data, and prove reserve exhaustion pauses reads then closes the
  provider at the deadline with cleanup proof;
- under the same pressure, inject `data -> pty.exit` and
  `recovery pty.data -> pty.recoveryComplete`; prove both lifecycle fences
  remain behind their token's quarantined data, while a same-token cancellation
  proof bypasses only after atomically canceling that prefix;
- reject recovery cancellation publication and local proof application while
  the attempt is current; prove the exact provider generation, mux, provider,
  publishers, transferred activation, and registration close once, while
  unrelated generations and physical PTY ownership remain untouched;
- prove renderer ACK/heal/write-off on V1 settles/transfers via display ranges
  and emits no legacy `acknowledgeDataEvent` wire delta;
- admit interleaved spans from two token generations and prove every desktop
  operation resolves the immutable span ID, PTY incarnation, delivery token,
  source/display interval, and transform metadata; inject model-reservation,
  projection-admission, send, merge/split, salvage, reload, and replacement
  failure at each transaction boundary and prove rollback or exact transfer;
- generate remote UTF-8, JSON-escaped, transformed, split, and composite frames;
  keep legacy `ackOutput: 1` delta ACKs outside source obligations; negotiate
  `ackOutputSourceRanges: 1`, then apply partial, excessive, and stale-generation
  cumulative ACKs and prove a partial ACK releases only its exact byte delta,
  retains the covering source frame, and settles source only at recorded frame
  boundaries, with send-stop without auto-transfer at the cap and atomic
  mapping transfer on an explicit reconnect/detach;
- overflow ACK-pending remote output and inject snapshot serialization,
  publication, exact-generation commit, and rollback failures; prove covered
  chunks trim only after commit and recovery remains single-flight; after
  cancellation proof reclaims a reserved span, require commit rejection,
  idempotent rollback, and safe late settle/detach pruning;
- feed current mobile notification epochs and watermarks into terminal ACK
  handlers and prove they are rejected without changing any source obligation;
- extend `terminal-output-frame-chunks-equivalence.test.ts` so composite source
  identity preserves the current code-unit chunk text, encoded bytes, sequence
  rounding, and allocation/performance contract;
- retain `terminal-stream-byte-length.test.ts` equivalence at its native-call
  floor and over-limit boundary so transport byte accounting and batch flushes
  cannot silently become source-unit accounting;
- hold desktop parse ACKs while a lossless mobile/web consumer advances; prove
  desktop transfer to model restore allows upstream credit to continue;
- cover pause/resume hysteresis and re-entrant output/exit callbacks;
- drive `SshPtyProvider.pauseProducer`/`resumeProducer` through
  `pty.setDeliveryPaused`; prove token/generation scoping, idempotency, native
  pause when all required deliveries are ineligible, and continued progress
  for a healthy additional subscriber;
- run one slow and one healthy client, verify only the slow client is detached;
- run no clients, verify no live pending data, bounded replay, and an unpaused
  producer outside reconnect grace;
- verify exit follows data and never bypasses the window; after the exit write
  callback, keep the sealed token and uncredited suffix live, accept a late
  cumulative ACK, advance main `ackPublishedEndSu` only from its write callback,
  and close the relay record only after it applies that ACK; separately prove
  timeout publishes cancellation or uses generation-close proof and affects
  only the stalled PTY token;
- receive exit with queued and in-flight emulator writes plus desktop and
  remote mappings; prove main delays `runtime.onPtyExit`, renderer exit, model
  disposal, and subscription cleanup until prior owners settle/transfer, and
  prove deadline first acquires cancellation proof, transfers published
  projections, commits proof, prepares/finalizes once, and rejects late
  generation callbacks; close the generation while proof is pending and prove
  no final exit publishes, then separately make proof fail while current and
  prove only then the provider closes;
- close 2,048 sequential provider generations and prove one retained exact
  closed range rejects early, middle, and latest stale events; close out of
  order and prove an unclosed older generation remains admissible until its own
  close merges the gap;
- verify round-robin progress across 50 continuously active PTYs;
- verify spans are freed only after all divergent cursors advance, cancel, or
  transfer;
- test every source-unit and byte budget at limit minus one, limit, and plus
  one, including global low-water hysteresis and legacy per-client/relay byte
  publication caps plus their drain-owned low waters;
- verify decoder order, synchronous first frame, bounded yields, transport
  pause/resume through ssh2, system SSH, WSL child stdio, stdin, Unix socket,
  and named-pipe adapters, reset cancellation, partial 16 MiB frames, input-cap
  close, oversized discard, and exact handshake residue;
- keep an unacked header across decoder/read self-pause and writer saturation;
  prove resume rebases both health clocks, coalesces keepalives, caps timestamp
  entries, and gives a full timeout window;
- feed hostile `ack=0xffffffff` and prove work is proportional to pending map
  size, never the numeric ACK range;
- prove terminal obligations advance `obligationsTerminalEndSu` before any ACK
  write, coalescing advances `ackQueuedEndSu`, callbacks alone advance
  `ackPublishedEndSu`, and cleanup waits for the published end; cover failed
  writes, cumulative retries, at most 64 entries, 8 ms/64 Ki-su flush rules,
  and input fairness;
- fuzz frame boundaries, JSON sizes, reconnect timing, transport data during a
  decoder continuation, and scalar-safe Unicode splits;
- exercise unconditional same-build V1 negotiation, old-client capability
  omission, and method-not-found fallback; reject a manually mismatched
  `.version`, and identify—but do not adopt or kill—an orphaned prior-version
  daemon;
- verify the session grant rejects unrequested versions and zero, negative,
  excessive, non-finite, or unsafe windows.

Use a deterministic fake sink that records accepted frames separately from its
saturation signal. Use a fake native PTY whose `pause()` can synchronously emit
one last chunk to prove the transient overshoot bound.

### Integration and E2E

`tests/e2e/ssh-docker-relay-perf.spec.ts` now contains V1 evidence for the
implemented Linux SSH/deployed-relay path. The test harness exercises the
normal deployment and connection path with no override and:

1. stalls desktop ACK and observes an exact 256 Ki-source-unit negotiated
   plateau while a second SSH PTY remains responsive;
2. preserves fixed `STREAM_CHUNK_SIZE` filesystem semantics and completes Git
   churn without corruption while active typing stays within budget;
3. reconnects the negotiated owner lease and proves the existing SSH
   workspace terminal remains usable;
4. retains the direct typing latency control.

Writer `write(false)`/drain, callback failure, liveness bypass, decoder
scheduling, sealed exit, stale ACK, exact recovery, and remote replacement are
proved at deterministic unit/service seams. The Docker suite does not force
the main-to-relay sink to remain saturated beyond the health deadline, does
not prove paired-runtime behavior, and must not be cited for those claims.

Docker SSH proves the Linux SSH provider/relay path only. It must never be
reported as headed paired-server, headless `orca serve`, remote-runtime
lossless subscription, macOS node-pty, Windows ConPTY/named pipe, or WSL
evidence.

The Slice 5d mapping is implemented, but live paired-runtime coverage remains
a separate promotion requirement:

| Topology                                       | Required oracle                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Headed paired desktop server + separate client | host-owned PTY identity, source mapping, client ACK/restore, reconnect, and cleanup         |
| Headless `orca serve` + same client flow       | identical source settlement plus headless model admission/startup ownership                 |
| Direct Docker SSH                              | deployed relay transport, main desktop intake, real remote process, writable/drain behavior |
| WSL child stdio                                | sentinel/residue, read pause, writer drain, no POSIX-path assumptions                       |
| Windows native                                 | ConPTY pause/resume and named-pipe callbacks/drain                                          |
| Local daemon                                   | authenticated paired hello and exact-version legacy fallback                                |
| Local provider                                 | direct semantic instantiation with no relay framing                                         |

Each topology also runs in a folder workspace fixture with no `.git`; source
identity and cleanup never depend on worktree metadata. Prior-version daemons
remain version-scoped legacy processes: report them, do not negotiate V1,
adopt their PTYs, or claim the new main bounds their memory. Keep any new
native artifact compatible with Ubuntu 20.04/glibc 2.31; this design itself
adds none.

The
`terminal-performance.output-backpressure-budget` reliability gate remains
`experimental` and `partial`. Its `coveredProviders: ["ssh"]` means the
deterministic direct-SSH contracts plus the macOS-hosted Docker
OpenSSH/deployed-relay run described above. It does not cover every SSH host
platform and does not mark local, daemon, remote-runtime, headed, headless,
WSL, Windows, folder-workspace, prior-version, mixed-version, or Ubuntu 20.04
packaging topologies as executed. The WSL stdin write/callback/drain contract
is deterministic adapter evidence only, not a physical WSL run.

## Compatibility and release validation

Every new SSH session and automatic reconnect offers V1. Every relay from the
same build advertises and grants V1, so the normal deployment path always uses
source credit. Sink drain, the reserved writer lane, stdout serialization,
bounded decoder work, bulk admission, and hostile header-ACK hardening are
also unconditional.

Compatibility behavior is explicit:

1. An old client that omits the V1 capability remains token-free and uses the
   bounded legacy writer.
2. A new main may use bounded legacy delivery only when the same-build
   compatibility check accepts JSON-RPC method-not-found for
   `pty.openClient`.
3. A successful `pty.openClient` response without the offered V1 grant, an
   invalid grant, or another request error fails closed rather than silently
   downgrading.
4. Disconnect performs normal token-scoped cancellation and exit cleanup; it
   never rotates a live V1 token into legacy mode in place.
5. A prior-version orphan remains governed by its own version-scoped binary and
   cleanup. The new main reports but does not adopt, kill, or claim to bound it.

Implementation and validation status:

1. Slices 1-4 are implemented under legacy-compatible framing with narrow
   reliability oracles.
2. Slices 5a-5c implement unconditional V1 offer/advertisement, source credit,
   exit, and reconnect with unit/service contracts and direct Docker SSH
   evidence.
3. Slices 5d-5e implement remote source-range transactions and the final
   lifecycle reconciliation at deterministic main/runtime/provider/relay
   seams. Live headed paired, headless, WSL, Windows, local-daemon,
   local-provider, and folder-workspace evidence remains future work before
   those topologies are marked covered.
4. Current-working-tree deterministic reconciliation and focused integrated-fix checks
   are complete. The isolated reconnect and final four-case direct-SSH Docker
   runs, full repository typecheck, and full lint/reliability suite are green;
   final exact-implementation-head architecture and transport reviews found no
   code blocker, and the transport review's stale-provenance finding is closed
   by the exact artifact record above.

Release criteria:

- no unbounded increase across 30-minute desktop-only, slow-model, and required
  lossless-consumer floods;
- relay and main stay within the documented budgets plus 25% allocator slack;
- active echo p95 remains below 100 ms under a background flood;
- exact logical output sequence after resume;
- no leaked obligations, writer callbacks, drain waiters, cursors, tokens,
  decoder tasks, or paused PTYs;
- no false dead-link reconnect across a 30-minute saturated/self-paused run;
- bounded time-to-last-reattach with one injected per-PTY failure;
- unconditional same-build V1 negotiation, bounded legacy compatibility,
  manual mismatch rejection, orphan reporting, and Linux/macOS/Windows/WSL
  smoke tests pass.

## Calibrated findings and non-goals

- The liveness risk is real for transport saturation and self-paused decoding.
  A renderer-only stall is absorbed by bounded projection transfer/restore
  while required-model credit continues. A stalled model admission or
  negotiated lossless remote consumer exhausts its window and pauses the
  native PTY; tests keep these distinct.
- V1 uses logical priority lanes and reserved writable capacity, not a second
  SSH channel. Adding a physical control channel would widen handshake,
  reconnect, system-SSH, and legacy compatibility scope without being required
  once PTY bursts and decoder pauses are bounded.
- There is no arbitrary 16-socket cap. Additional PTY projections are bounded
  and isolated by their own writer/publication capacity; short-lived remote CLI
  clients remain independent.
- A 60-second watchdog may warn about an old open obligation, but it cannot
  force-credit data. Recovery must use a proven transfer or token cancellation.
- Reconnect-grace data is a bounded live-delivery owner, not an expansion of the
  100 Ki replay-tail contract. Expiry is an explicit data gap, never silent
  truncation.
- Content-hashed endpoints make mixed production binaries unreachable. The
  real upgrade skew is an orphaned prior-version daemon outside the new main's
  startup-gated endpoint; V1 reports but cannot adopt, cancel, or retroactively
  bound it.
- Preserving the real exit code for a PTY that exits before any new client
  reattaches would require attach-visible tombstone retention. V1 documents and
  tests the existing synthetic `-1` fallback instead of coupling that separate
  product change to backpressure.

## Reference-commit assessment

Retain from `1500a92904` the useful concepts of generation tokens, client
isolation, pause/resume, targeted dispatcher sends, cleanup of stale credits,
and slow-client eviction.

Do not reproduce these behaviors:

- ordinary notifications continuing to write after `write(false)`;
- delta ACKs without cumulative token scope;
- automatic live broadcast to every connected client;
- force-flushing final PTY output beyond the credit window;
- per-client windows without aggregate retained-memory budgets;
- synchronous all-frame draining;
- assuming `256 Ki × 50 PTYs × N clients` is itself a safe memory bound.

This design makes writable-drain state, application credit, retained memory,
and decoder CPU four explicit and independently enforced bounds.

## Platform and workspace requirements

The relay can run on a native macOS, Linux, Windows, or WSL host reached over
SSH. Use Node stream APIs and runtime platform checks; do not assume POSIX file
descriptors, path separators, signals, or Unix sockets. Windows uses ConPTY and
named pipes, while POSIX uses node-pty and Unix sockets, but both must expose
the same idempotent pause/resume and sink state contract.

Network latency changes ACK cadence but not the window invariant. A
high-bandwidth/high-latency SSH link may need later window tuning based on
telemetry; it must not receive an unbounded adaptive window. SSH disconnects
are normal lifecycle events, not exceptional shortcuts around cleanup.

No part of subscription identity or cleanup may depend on `.git`, a worktree
ID, or a Git provider. Folder workspaces use the same connection, PTY, and
client generations as Git worktrees. Bulk Git changes only slice and schedule
existing response frames; they add no Git command, provider-specific behavior,
or requirement beyond the Git 2.25 core-workflow baseline.
