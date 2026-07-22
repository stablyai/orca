# Remote agent-session host authority

Status: implemented single-PR v1 design for issues #8878 and #9352; deterministic validation complete.

## Reliability contract

- **Invariant (`agent-session.remote-host-authority`):** one provider-session identity has at most one live PTY owner and canonical host surface on every claim-capable route; exact exit retires that incarnation durably.
- **Failure source:** issues #8878 and #9352, including concurrent remote clients, ambiguous replies, exit-before-publication, and stale client snapshots.
- **Oracle:** the focused ownership/lifecycle matrix and `pnpm test:repro:remote-agent-session` prove one physical spawn, canonical retry adoption, exact exit retirement, stale-publication rejection, and no restart resurrection.
- **Gate:** the experimental `agent-session.remote-host-authority` entry in `config/reliability-gates.jsonc`.
- **Coverage:** deterministic macOS local/daemon/remote-runtime evidence plus SSH/relay fault-injection; Linux, Windows, WSL, and live SSH remain explicit gaps.
- **Performance budget:** no polling or terminal-output work; admission-only provider reconciliation is inflight-deduped, and operation state is capped and expiring.
- **Diagnostics:** structured RPC error codes, PTY incarnation IDs, owner generations, operation dispositions, and the repro artifact distinguish fallback, adoption, conflict, and retirement failures.
- **Residual gaps:** durable fresh-operation journaling, automatic sleep checkpoints, verified nested-SSH namespaces, and multi-process profile coordination are documented under Future extensions.

## Summary

A remote Orca host, not an attached renderer, decides whether a provider agent
session already has a live PTY. Clients send structured intent (fresh launch or
explicit provider identity); the host returns one canonical terminal surface.

This fixes two related failures:

- A paired client could consume its own persisted sleep record and launch a
  second TUI while the remote host still owned the first one (#8878).
- An exited host terminal could remain in `session.tabs.list` as a handle-less
  placeholder, get persisted by clients, and return as a ghost tab (#9352).

The v1 protocol deliberately fails closed after authority side effects begin.
At mixed-version boundaries the host may return
`agent_session_legacy_required`, but only after a read-only execution-owner
check and before trust, claim, spawn, or any retained replay fence. The client can then run
its retained exact legacy request, so upgrading any subset of clients, hosts,
daemons, or relays does not remove workflows that worked before the upgrade.

## Scope and guarantees

This change guarantees:

1. Runtime-owned worktrees always queue renderer sleep records into the normal
   transport. A fully capable route turns that intent into an authoritative
   ensure/adoption; mixed-version routes preserve the legacy wake behavior.
2. On capable hosts, known provider sessions resume through a structured
   `terminal.ensureAgentSession` request.
3. On claim-capable execution routes, concurrent or repeated ensures for the
   same canonical provider identity return one execution owner and one
   canonical terminal surface.
4. A fresh launch uses `terminal.createAgentSession` with a caller-scoped
   operation ID. Stable runtime surface identity, daemon session identity, and
   relay operation identity prevent response-loss retries from creating a
   second process while their respective owner remains alive.
5. New hosts continue accepting agent-bearing legacy terminal-create RPCs, so
   old clients behave exactly as they did before the host upgrade.
6. Structured explicit resume returns `agent_session_legacy_required` before
   side effects when a daemon is old or an SSH route cannot attest its execution
   namespace. A claim-capable route still fails closed on malformed,
   conflicting, or unknown ownership after dispatch.
7. Natural or explicit PTY exit retires only the exact PTY incarnation and
   terminal surface from both `terminal.list` and `session.tabs.list`, repairs
   active/group topology, and removes durable host persistence.
8. New clients use structured authority only when advertised. Capability
   absence or a transient read-only probe failure selects the exact legacy
   payload; protocol incompatibility remains blocked.

The following are not v1 guarantees:

- automatic resume of an intentionally sleeping remote agent;
- fresh-launch exactly-once behavior across a full runtime process restart;
- host-authoritative deduplication of resumes through an unverified
  direct/nested SSH execution namespace (those launches retain legacy behavior);
- supervising a provider process after its owning PTY exits;
- coordinating multiple independent Orca main processes for one profile;
- preventing a nonconforming new client from deliberately sending the same
  legacy wire request as an old client; authenticated request-level capability
  negotiation does not yet exist, so the server cannot distinguish them.

Those constraints are explicit so future work can extend the protocol without
weakening the v1 safety boundary.

## Authority model

There are three layers:

| Layer                             | Responsibility                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| Client/renderer                   | Sends structured intent and mirrors host snapshots                                      |
| Runtime/controller                | Resolves worktree and provider identity, signs a claim, publishes the canonical surface |
| Execution owner (daemon or relay) | Atomically claim-or-spawn, prove liveness, and recover live claims from listings        |

The execution owner is the lowest process that can atomically answer “is there
already a live PTY for this agent identity?” Keeping the registry there closes
the race between multiple runtime calls. The controller also keeps a registry
above providers so separate local/SSH routes cannot independently claim the
same identity.

## Structured requests

### Explicit resume

`terminal.ensureAgentSession` accepts only a supported agent and normalized
provider identity:

```ts
{
  kind: 'explicit'
  worktree: string
  agent: ResumableTuiAgent
  providerSession: {
    key: 'session_id' | 'conversation_id'
    id: string
    transcriptPath?: string
  }
  agentArgs?: string | null
  launchPreferences?: { model?: string; effort?: string; mode?: string }
  presentation?: 'focused' | 'background'
  placement?: { tabId?: string; leafId?: string }
}
```

The host canonicalizes the provider identity, binds it to the execution
namespace and canonical worktree, and signs a digest claim. Raw resume commands
do not cross a claim-capable boundary; compatibility-selected legacy and
unverified nested SSH paths retain their prior opaque command behavior.

The execution owner performs one atomic operation:

```text
claim absent  -> reserve -> spawn -> publish live owner -> created
claim live    -> prove PTY liveness -> return canonical owner -> adopted
claim unknown -> fail closed; do not spawn
claim conflict -> fail closed; do not spawn
```

Only an adopted owner may override the requested tab, leaf, handle, or PTY ID.
A fresh provider result must match the surface requested by the host.

### Fresh launch

`terminal.createAgentSession` accepts structured agent, prompt-delivery mode,
launch preferences, optional explicit agent arguments, and a cryptographically
random client operation ID. Draft prompts remain drafts; submitted prompts use
the normal startup-delivery path. Omitted agent arguments preserve host
defaults, while an explicit string is preserved as a client override and an
explicit null/empty value clears host argument defaults. Free-form client
environment variables are deliberately not accepted because PATH, loaders, and
other process authority remain host-owned.

The runtime reserves the caller-scoped operation before any asynchronous
workspace or capability preflight, then fingerprints the host-resolved request
under the authenticated device identity:

- same caller + operation ID + same fingerprint returns `replayed`;
- same caller + operation ID + different fingerprint fails;
- malformed, future-dated, expired, or over-capacity operations fail closed.

The operation ledger is memory-bound and retained for 24 hours. Pre-spawn
failures release the entry for a safe retry. Once PTY creation commits, or the
provider reports an unknown physical outcome, the same rejected promise remains
as the replay fence. This handles response loss and ordinary reconnects to the
same running host. It does not claim exactly-once creation after the runtime
process itself restarts.

Physical commit is the native-spawn boundary, not listener registration or
surface publication. The in-process provider reports it immediately after
`node-pty` returns; daemon and relay paths report it when their lower owner
returns from spawn/create-or-attach. Commit reporting is one-shot across these
layers. Any later error retains the operation fence because the PTY may already
exist even if publication failed.

The runtime derives the execution-operation ID, tab ID, leaf ID, and terminal
handle deterministically from the authenticated operation. A daemon-backed
spawn derives a legacy-length session ID from that execution operation, so
`createOrAttach` returns the same PTY after a lost response without shrinking
the accepted worktree-ID boundary or skipping first-spawn setup. An SSH
provider performs a bounded read-only relay probe before structured work:

- a relay advertising `agentSessionCreateOperationVersion: 1` receives the
  operation ID and replays one successful spawn result for 24 hours;
- an older, malformed, or temporarily unreachable relay makes the host return
  `agent_session_legacy_required`, after which the client sends its unchanged
  legacy payload;
- negative relay capability results are not pinned, so an in-place upgrade is
  observed on the next request.

Relay operation-owned PTYs survive stale request contexts so the retry can
recover the same PTY and incarnation. Ordinary stale shell spawns keep the
existing cleanup behavior.

## Claim identity

The claim contains no raw provider session ID. A host-only signer hashes:

- normalized agent/provider identity;
- canonical worktree scope;
- execution machine and principal;
- container/runtime namespace;
- a conservative provider-root bucket. The v1 implementation deliberately
  merges account roots for an agent, which can produce a safe conflict but
  cannot authorize duplicate execution.

The wire binding includes a key ID, digest version, identity digest, worktree
scope digest, and agent kind. Owner state adds a random generation, PTY ID, and
canonical surface.

Generation and PTY-incarnation guards prevent a late exit or liveness result
from releasing, retiring, or adopting a replacement owner that reused the same
PTY ID.

## Recovery and failure semantics

Before every claimed ensure, the controller stages complete listings from local
and registered SSH providers, validates every owner, and atomically replaces
the authoritative portion of its registry. Absent owners are pruned only for
providers whose listing is authoritative; disconnected scopes retain their
fence. Active reservations survive reconciliation. Valid metadata also rebuilds
PTY-to-provider routing.

Controller-owned in-process fallback claims are intentionally not serialized
in ordinary local process listings. Their listing absence is therefore not
authoritative: the controller keeps the claim while the exact PTY incarnation
remains listed and releases it through the normal exit path. Daemon routers and
degraded providers likewise advertise listing authority only for a proven
PTY-to-provider route; an unknown ID never falls through to an unrelated
current/fallback provider for this decision.

Recovery is fail closed:

- owner PTY differs from the listed session: `agent_session_ownership_unknown`;
- two listings disagree about an identity or generation:
  `agent_session_conflict`;
- the recorded provider is disconnected or unregistered:
  `execution_owner_unavailable`;
- a claim-bearing spawn reaches a daemon/relay without execution-owner claim
  protocol v2 (including PTY incarnation proof):
  `agent_session_claim_unavailable`. Nested SSH routes that cannot construct a
  claim are selected into legacy behavior before this boundary.

Unknown liveness never means dead. A transient relay outage therefore retains
the claim and cannot authorize a replacement agent.

Daemon adoption is attach-only. If the owner exits between liveness proof and
attach, the request fails rather than falling through to a new unclaimed shell.

Serialized relay shell state intentionally omits provider claims. Spawn-based
revival creates a new shell and cannot inherit authority from the old process.

## Renderer behavior

Runtime-owned worktrees queue cached resume evidence through the same mounted
pane transport regardless of capability-cache timing. A capable host adopts or
creates one canonical owner; an old host or execution owner receives the exact
legacy launch. A cold or expired cache therefore cannot bypass authority or
remove the pre-change workflow.

AI Vault resumes use provider metadata for agents with a structured identity,
including Antigravity conversation IDs and Pi transcript/session paths. If
metadata or host capability is absent, Orca preserves the prior opaque legacy
resume request instead of blocking the user.

Background launches, quick launches, and mounted remote panes use
`terminal.createAgentSession` on capable hosts. Otherwise each call site sends
the exact pre-change `terminal.create` or `session.tabs.createTerminal` payload.
The common router calls legacy after only these safe outcomes: the host capability
is unavailable before dispatch; the structured RPC returns the stable
pre-side-effect `agent_session_legacy_required` code; or a replaced old host
returns `method_not_found`, proving it never recognized the structured request.
Timeouts, malformed results, and every other structured error never downgrade.

Structured create/ensure responses record an exact
environment/worktree/provisional-tab to canonical-host-tab handoff. Snapshot
reconciliation removes a provisional pane only when its requested tab ID is
mirrored or that explicit handoff points to a host tab in the snapshot; agent
kind alone is never identity. This prevents an unrelated Claude/Codex session
from deleting a same-agent automatic-resume pane. The matched pane's pending
startup and automatic-resume claim are removed atomically, and the client
re-accepts the current host snapshot in case it arrived before the response.

Every structured result is host-owned. If snapshot handoff destroys the
provisional transport while create/ensure is in flight, late completion cannot
close the canonical PTY even when reconciliation is still catching up.

After the host accepts creation, a later tab-move or snapshot-refresh failure
still returns `created`. Reporting the launch as failed would invite a retry
with a new operation ID and could duplicate the fresh agent.

## Exit and persistence lifecycle

PTY exit is terminal authority. A generic persisted `sleeping` row is not a
reason to preserve a surface. Only an exact, runtime-owned stop transaction may
temporarily preserve the intentional handle-less surface. Otherwise the
runtime:

1. verifies the PTY incarnation and identifies the exact worktree/tab/leaf;
2. removes that leaf from the host snapshot;
3. removes an empty parent tab;
4. repairs split groups, active group/tab, recent order, and layout;
5. removes the terminal binding from the persisted host workspace session and
   advances that repo's host topology revision;
6. synchronously flushes that retirement before publishing the in-memory
   absence;
7. rebases later renderer writes onto the host's current terminal membership,
   so metadata and layout edits remain writable but missing/live panes cannot
   be added or removed by a stale client.

The durable fence is one monotonic revision per affected repo, not one record
per historical close or deleted worktree. Its storage is therefore proportional
to repos plus current terminal surfaces. A real host-admitted spawn advances
the revision when it adds a tab or leaf, allowing fresh terminals after a
retirement while an older renderer snapshot remains unable to revive the old
surface. Legacy per-pane tombstones are accepted for mixed-version recovery
and collapsed into the repo revision on the next normalized write.
The revision remains private to each execution host: renderer hydration and
writes omit it, avoiding collisions when different hosts contain the same repo
ID. Each host preserves the revision while rebasing client session writes.

An exit can also beat initial terminal registration. The runtime records that
PTY/incarnation before any surface exists, rejects registration of the same or
unproven incarnation before mutating provider/output sequence, execution
context, ownership, lease, binding, handle, terminal, or tab state. The native
callback or successful lower-owner return still reports physical-spawn commit
before this admission check so a lost provider response cannot authorize a
second fresh agent. A proven different incarnation, or an explicit new local
lifecycle for a provider that cannot report incarnation identity, clears the
fence. When registration rejects the recorded incarnation, that specific
caller's fence is released after rejection so repeated early-exit failures do
not accumulate process memory.

Registration intent is explicit: the controller marks the expected PTY before
dispatch and clears that intent on every success or failure path. Surface
absence is never treated as evidence that registration is still in flight.
SSH and daemon providers also settle an attach/create response against any exit
that arrived in the same transport batch before returning control upward. This
keeps response/exit ordering and incarnation comparison at the layer that can
observe both events.

“Explicitly killed” is treated as a normal terminal-gone lifecycle outcome in
the remote transport, not as an unexpected product-error toast.

## Protocol and compatibility

The runtime protocol remains v3, with minimum compatible client and server v2.
This change adds optional RPCs and fields, so a protocol fence would make a
rolling upgrade worse without providing an authorization boundary. The runtime
advertises `agent-session.host-authority.v1`; clients negotiate that capability
before choosing a launch path.

| Client | Host | Result                                                                                                   |
| ------ | ---- | -------------------------------------------------------------------------------------------------------- |
| New    | New  | Structured authority is enabled when the resolved execution owner also supports it.                      |
| New    | Old  | The client selects legacy before spawn, or falls back on safe `method_not_found`; behavior is unchanged. |
| Old    | New  | The host still accepts legacy agent-bearing terminal creates; behavior is unchanged.                     |
| Old    | Old  | Unchanged legacy behavior.                                                                               |

Capability probing is read-only. A transient probe failure may select legacy,
because no structured side effect has started. A real protocol compatibility
block is still surfaced and never bypassed. A capable host then checks the
resolved daemon or relay. Only `agent_session_legacy_required`, emitted before
trust, claim, spawn, or any retained replay fence, permits legacy; every later error stays on
the structured path. The other post-dispatch exception is `method_not_found`
from an old host, which proves the method could not have started. Host and
lower-owner unsupported verdicts are not pinned, and observing a new runtime ID
invalidates a predecessor's positive verdict, so rolling upgrades and process
replacement re-probe promptly. The SSH probe is bounded below the client RPC
timeout, concurrent callers have independent cancellation, successful
structured creates require PTY and incarnation identity, and request
cancellation is checked at the real provider seams: after asynchronous
capability/connection preflight and immediately before local native spawn,
daemon `createOrAttach`, or SSH `pty.spawn`. Once SSH dispatch begins, an
operation failure is treated as an unknown physical outcome rather than a safe
fresh retry.

The same monotonic rule applies below the runtime:

| Runtime/controller | Execution owner  | Result                                                                                                        |
| ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| New                | New daemon       | Stable operation-derived session ID makes retry attach to the same PTY.                                       |
| New                | Old daemon       | The host returns `legacy_required` before side effects; the client sends its exact old resume/create request. |
| New                | New relay        | Relay operation ledger replays the same PTY and incarnation.                                                  |
| New                | Old relay        | The host returns `legacy_required` before side effects; the client sends its exact old spawn request.         |
| Old                | New daemon/relay | New optional fields are absent, so pre-change behavior is unchanged.                                          |

This contract is monotonic: upgrading any subset never removes a workflow that
worked before. The bug fix activates only where every authority layer required
for that specific path can prove support.

## Deterministic reproduction harness

Run:

```sh
pnpm test:repro:remote-agent-session
```

The harness builds Orca, starts a real headless Electron `orca serve` process on
an ephemeral port, and connects independent Node client processes over the
normal encrypted WebSocket pairing path. It creates and registers a real Git
repository in an isolated profile and uses the real daemon claim registry with
a controlled agent subprocess. No installed agent, external service, fixed
port, timing race, or Docker daemon is needed.

It asserts:

- two clients race the same structured resume;
- exactly one daemon subprocess is spawned;
- both clients receive the same canonical handle, tab, pane, and PTY;
- a retry that may have lost its earlier response adopts that owner;
- a real `terminal.close` produces PTY exit and both `terminal.list` and
  `session.tabs.list` omit the surface;
- a stale layout publication cannot recreate the retired surface;
- restarting the serve process with the same profile cannot resurrect the
  terminal or tab.

Lower-level tests separately cover daemon attach races, controller recovery,
provider disconnects, conflicting listings, old SSH relays, malformed SSH
claim results, cancellation at physical provider seams, pre-publication native
spawn failures, exact provisional handoff, early exit before registration, and
exit-driven durable retirement.

## Future extensions

### Host-owned automatic sleep checkpoints

Automatic remote sleep/resume should be added only as a host transaction:

1. persist a random, generation-bound checkpoint before stopping;
2. publish a non-connectable transition state;
3. stop and verify the exact owner;
4. commit sleeping state only after the owner is gone;
5. consume the checkpoint atomically during ensure.

Until this exists, renderer-local records may trigger resume intent but cannot
authorize a second owner on a claim-capable route. Compatibility-selected
legacy mode keeps the pre-change behavior.

### Durable fresh-operation journal

If fresh-launch exactly-once behavior must survive runtime restart, replace the
memory ledger with a profile-scoped durable journal. It must persist the caller,
operation ID, request fingerprint, canonical result/tombstone, and retention
deadline before returning success. Capacity must reject rather than evict an
unexpired tombstone.

### Verified SSH execution namespaces

Direct or nested SSH agent-session authority requires relay-attested machine,
principal, container, and provider-root identity plus a separately versioned
claim capability. Connection labels or target aliases are not proof. Until
that attestation exists, the host requests exact legacy fallback before spawn;
v1 does not claim deduplication for that route.

### Multi-process coordination

Supporting multiple Orca main processes against one profile requires an
OS-held coordinator lease around claim and journal mutation. The current v1
contract coordinates clients of one runtime/controller process and its daemon
or registered relays.
