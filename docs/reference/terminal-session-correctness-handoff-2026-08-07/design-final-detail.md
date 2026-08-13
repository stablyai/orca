FINAL DESIGN — one leaf-keyed ownership record; pane identity deleted from the attach path; death proved only by the relay process that spawned the shell

=====================================================================
D0. SCOPE AND THE ONE RULE EVERYTHING FOLLOWS FROM
=====================================================================
Problem (from the brief): SSH reconnect grows pane cardinality (2 -> 19 -> 20, STA-3077); a coding agent gets resumed twice into one transcript (RC2); one PTY's failure can drop a whole host connection (RC3, out of scope — Plane 1).

One rule, applied without exception:

Ownership ("which shell does this pane own?") is DURABLE, CLIENT-LOCAL, and read
synchronously from disk while offline. Evidence about a shell's FATE is
NON-DURABLE, HOST-LOCAL, and must be REPORTED by the host, never INFERRED by the
client from timing, from the absence of an entry, or from the shape of an error
string.

Every defect found across three review rounds is one violation of the second clause. The design's job is to remove all of them, not to add an authority layer.

SCOPE DECLARATION (grok, low): the record is host-agnostic (`hostId` is a field). The _death rule_'s row 2 is relay-specific. Local and daemon panes reach `terminated` only through row 1 (an exit observed in-process, which is how they already work) and never through row 2. That is stated rather than left implicit.

=====================================================================
D1. THE DURABLE RECORD
=====================================================================

```ts
/** Main-owned. TOP-LEVEL in PersistedState — never inside WorkspaceSessionState. */
type PaneShellOwnership = {
  leafId: string // PRIMARY KEY. Terminal-layout leaf UUID.
  hostId: ExecutionHostId // FIELD: 'local' | 'ssh:<target>' | 'runtime:<id>'
  worktreeId: string // FIELD. Opaque FULL string incl. any `::workspace:<uuid>` suffix.
  ptyId: string // RELAY-NATIVE form for SSH (toRelaySshPtyId). One namespace, always.
  incarnationId: string // REQUIRED. Relay mints one per pty (relay/pty-handler.ts:1525).
  relayInstanceId?: string // The relay PROCESS that owned it, as reported at bind time.
  state: 'attached' | 'detached' | 'terminated'
  createdAt: number
  updatedAt: number
  lastAttachedAt?: number
  lastDetachedAt?: number
}
// Storage: PersistedState.paneShellOwnershipByLeafId: Record<string, PaneShellOwnership>
```

Note what is NOT here: no `tabId`, no `paneKey`, no `hostEpoch`, no `resumed`, no second (pty-keyed) record.

WHY `leafId` AND NOT `paneKey`. `makePaneKey(tabId, leafId)` returns `${tabId}:${leafId}` and the repo states at src/shared/stable-pane-id.ts:47-49 that "only the leaf UUID is remint-stable pane identity (the tab half changes on pane break-out)" — which is why `isEquivalentPaneKey` exists at :50-57. The mutation is a shipping gesture: `detachTerminalPaneToTab` (src/renderer/src/components/terminal-pane/terminal-pane-tab-detach.ts:245-310) moves a LIVE pane and its ptyId into a new tab via `createTab(..., initialPtyId)` while explicitly not killing the PTY (:275-276). `leafId` is a UUID and is never remapped once it is one (src/main/persistence.ts:1858-1872 skips ids already passing `isTerminalLeafId`). Keying by the leaf deletes the transfer problem instead of managing it.

WHY NO `tabId` AT ALL (this is the round-3 change). A stored tabId is either frozen (and then it names a tab the leaf no longer lives in) or updated (and then it desynchronizes from the relay's frozen copy). Both are live production failures — see D2. The tab is LOCATION, derived from the live layout at the moment it is needed; it is never stored and never trusted.

WHY TOP-LEVEL. `session:set` / `session:set-sync` (src/main/ipc/session.ts:13, :31) accept a whole `WorkspaceSessionState` from a renderer with no revision or fencing token; the clobber guards at src/main/persistence.ts:6379, :6384-6476 exist only because of that. `sshRemotePtyLeases` is already top-level. The KEY is shared with the layout; the STORAGE LOCATION is not.

UNIQUENESS. At most one non-terminal record may name a given `(hostId, ptyId, incarnationId)`, enforced on write through a reverse index. Not ptyId alone: leases store the relay-native id (`getRelayPtyIdForSshLeaseStorage` -> `toRelaySshPtyId` strips the connection scope, src/main/persistence.ts:6641-6643, src/shared/ssh-pty-id.ts:58-67) and relay ids are `pty-${this.nextId++}` with `nextId = 1` per relay PROCESS (src/relay/pty-handler.ts:356-357, :1440-1443), so `pty-1` recurs on every host after every relay restart. Round 1's rejection ("a cross-target collision on ptyId is impossible") is withdrawn; it is guaranteed, not impossible.

=====================================================================
D2. DELETE PANE IDENTITY FROM THE ATTACH PATH (the largest round-3 change)
=====================================================================
Both reviewers independently attacked the attach-time identity comparison. Verified, and it is worse than either stated: the apparatus is simultaneously over-strict and under-strict, and it is a live duplicate-agent bug today.

VERIFIED FACTS

- The relay compares frozen strings: `attachIdentityMismatches` (src/relay/pty-handler.ts:334-339) does full-string `expected.paneKey !== managed.paneKey || expected.tabId !== managed.tabId`; `attachIdentity` is captured once at spawn from `ORCA_PANE_KEY`/`ORCA_TAB_ID` (:1512-1517, :1446). On mismatch it throws `PTY "<id>" not found (identity mismatch)` (:1616-1626).
- `isSshPtyNotFoundError` is a message regex `/PTY ".+" not found/i` (src/main/providers/ssh-pty-errors.ts:12-15), so it is TRUE for the mismatch string. `reattachSshPtySession` re-emits it as `SSH_SESSION_EXPIRED: <id> SSH_PTY_IDENTITY_MISMATCH` (src/main/providers/ssh-pty-session-reattach.ts:218-226).
- The renderer's `isProvenSshSessionGoneError` returns TRUE for anything containing `SSH_SESSION_EXPIRED` and for the raw not-found regex, and IGNORES the mismatch marker (src/renderer/src/components/terminal-pane/reattach-failure-classification.ts:24-30). Its two call sites then clear the binding and call `startFreshColdRestoreAgentResume` (pty-connection.ts:8839-8847, :9086-9097) — a second shell and a SECOND AGENT RESUME while the original shell keeps running. That is RC2, on a live process, reachable from a shipped gesture.
- The spawn-path reattach builds the expected identity from the CURRENT options (`args.options.paneKey ?? env.ORCA_PANE_KEY`, ssh-pty-session-reattach.ts:66-68), i.e. the current tab — so after a detach it mismatches. The connect-path reattach builds it from the lease's stored tabId (`expectedIdentityForLease`, src/main/ssh/ssh-relay-session.ts:190-210, consumed at :2201-2210), which is never re-keyed on detach — so it matches, attach succeeds, and then `persistPtyBinding(tabId = old tab, mayCreate:false)` refuses because the leaf is no longer in that tab's layout (src/main/persistence.ts:6821-6877 sets `terminalMembershipChanged` and returns false), leaving the shell running unbound (ssh-relay-session.ts:2513-2521). Grok's "scissors" is confirmed on both blades.
- The apparatus does not even do its own stated job ("generation resets can reuse PTY IDs; reject conflicting identities", pty-handler.ts:1615): after a relay restart that recycles `pty-3` for the SAME pane, paneKey and tabId both match and a different shell is accepted.

RESOLUTION — delete the comparison; do not replace it with another comparison.

1. Relay: delete `attachIdentity`, `attachIdentityMismatches`, the `params.expectedPaneKey`/`expectedTabId` handling and the `(identity mismatch)` throw. `ManagedPty.paneKey`/`tabId` STAY — they are documented as separate from attach identity (pty-handler.ts:139-143) and are used by the exit listener (:765) and, newly, by listProcesses reporting (D4). paneKey stops being an authorization INPUT and becomes a reported HINT.
2. Main: delete `ExpectedPtyIdentity`, `expectedIdentityForLease`, `expectedIdentityByPtyId`, the `expectedIdentity` parameter threaded through `attachPtyWithRetry`, `isSshPtyIdentityMismatchError`, `SSH_PTY_IDENTITY_MISMATCH_ERROR`, the marker append, and the mismatch branch at ssh-relay-session.ts:2628-2634.
3. Renderer: `isProvenSshSessionGoneError` keeps only proofs. (After step 1/2 the mismatch string ceases to exist; the renderer fix ships FIRST and independently, because it must protect users running against relays that have not been redeployed.)
4. Recycled-id rejection moves to two places that already hold exact data:
   (a) PROCESS GATE, once per connection: if the owner grant reports a `relayInstanceId` different from the one recorded on a record, that record's ptyId is not attachable at all. One comparison covers every pty on the host. Within a single relay process ids never recycle (`nextId` is monotonic), so this is complete against new relays.
   (b) PER-ATTACH GUARD, zero wire change: EVERY `pty.attach` success path already returns `incarnationId` (src/relay/pty-handler.ts:1646, :1653, :1668, :1676), and the client already parses and remembers it (`requestSshPtyAttach` -> `rememberPtyIncarnation`, ssh-pty-session-reattach.ts:74-100). Compare it to `record.incarnationId`; on mismatch, throw — the existing `activationLease.rollback()` already runs on a thrown error — and classify `detached`, never death. `RecentPtyOutputBuffer.read()` is explicitly non-mutating (src/main/runtime/recent-pty-output-buffer.ts:75-85), so abandoning a wrongly-attached shell does not consume its replay.
   This is strictly stronger than the frozen-string check (a per-pty UUID vs a pane label), needs NO new request field, and works against OLD relays — which a new `expectedIncarnationId` request parameter would not.
5. The reattach BIND resolves the tab from the live layout: find the tabId whose `terminalLayoutsByTabId[*].root` contains this `leafId`. If no layout contains it, refuse exactly as today (leave the shell running unbound, "no durable pane owns this"). `mayCreate:false`'s guarantee is preserved; its dependence on a stored tabId is deleted.

ONE IDENTITY RULE, EVERYWHERE: the leaf is identity; the tab is derived location; the incarnation is shell identity; the relay instance is process identity. There is no fourth.

=====================================================================
D3. THE DEATH RULE — two rows, one new field
=====================================================================
`resumed` and `hostEpoch` are deleted and must not be built.

- `resumed: replaces !== null` (src/shared/pty-consumer-session.ts:275); `expireOwner()` nulls the incumbent after `PTY_CONSUMER_OWNER_GRACE_MS = 30_000` (:281-287, contract :2), after which admission takes `if (!current) return this.newOwner(...)` (:215-216) and `resumed` is false regardless of proof. Unreachable for quit, sleep, overnight, reboot — the normal case. Its own contract comment says it means "the client's checkpoints for the previous claim no longer apply" (pty-consumer-session-contract.ts:49-52): a delivery-checkpoint flag, not liveness.
- `hostEpoch = Date.now() - os.uptime()*1000` under exact equality is a reconstructed estimate; second-granularity uptime, NTP steps and suspend/resume make it differ on an unrebooted host, and "differs" was the grant-YES row — it fails OPEN toward respawn. Repo precedent settles it: `readCurrentDaemonReadyIdentity` reads `/proc/sys/kernel/random/boot_id` on Linux only and returns bare `{ startedAtMs }` elsewhere (src/main/daemon/daemon-ready-identity.ts:11-13).

THE ONE NEW GRANT FIELD: `relayInstanceId?: string` on `PtyConsumerSessionGrant` (src/shared/pty-consumer-session-contract.ts:43-59) — a `randomUUID()` minted once at relay process start (`randomUUID` is already imported at relay/pty-handler.ts:6). It is genuinely new information: the grant's existing `serverBuildId` is `launchVersion` (src/relay/relay.ts:694-696), a build string that is identical across restarts of the same build.

| Condition                                                                          | Transition   | Respawn grant        |
| ---------------------------------------------------------------------------------- | ------------ | -------------------- |
| PTY exit observed on a live attached stream                                        | `terminated` | yes                  |
| attach returns not-found AND the grant's `relayInstanceId` EQUALS the recorded one | `terminated` | yes (subject to E-1) |
| attach returns an incarnation different from the recorded one                      | `detached`   | no                   |
| `relayInstanceId` absent on either side, or differing                              | `detached`   | no                   |
| any other error (today's `restoreRequired` path, ssh-relay-session.ts:2612-2620)   | `detached`   | no                   |

Row 2 is sound and UNBOUNDED IN TIME: `this.ptys` is the relay process's only store (pty-handler.ts:356) and entries are deleted on exit, so "the same process that minted this pty no longer has it" means it exited. It is sound on Windows too, because the relay OBSERVED the exit — unlike any rule that reasons from a relay restart. A restarted relay reports a different id and we correctly claim no knowledge.

SHIP GATE (grok H4): row 2 grants a respawn on a not-found detected by a message regex. One shared normalization helper (`toRelaySshPtyId`) must be applied on every attach / mark / record / comparison path, and the record stores exactly one namespace (D1), so a namespace mismatch cannot manufacture a false not-found. Row-2 grant-yes does not ship until E-1 is green.

STOP FABRICATING THE EXIT. `handlePtyReattachFailure` currently sends `pty:exit { code: -1 }` (ssh-relay-session.ts:2643-2647) plus `clearProviderPtyState` + `deletePtyOwnership` + `markSshRemotePtyLease('expired')` on a plain not-found. On every `detached` row this is a lie about a process the client knows nothing about. Remove the whole block and route the unknown case into the branch that ALREADY EXISTS three lines above it: `pending.restoreRequired = 'reattachAttemptsExhausted'` + `wakeRecovery` (:2612-2620), which is non-destructive by construction. This is a branch COLLAPSE, not a new signal — which is also the answer to the objection that removing only the send turns a wrong signal into no signal.

=====================================================================
D4. ORPHANS — a connect-time projection, never an authority
=====================================================================

```
orphans(host) = successful listProcesses(host)
                MINUS { (ptyId, incarnationId) named by a non-terminal record on this host }
```

Computed at connect/reattach, held in memory for the connection's life, discarded on disconnect. No durability, no migration, no rollback.

WHAT `listProcesses` IS: it iterates only `this.ptys` (pty-handler.ts:1894-1911) — the current relay process's Map. No durability, no OS scan. It is therefore (i) the cleanup-UI source and (ii) a SUPPLEMENT to the reattach work list, never the sole discovery authority. The work list stays `getPtyIdsForConnection(target) UNION` the non-terminal records (today's `leasedPtyIds` shape, ssh-relay-session.ts:2211-2219).

ABSENCE IS NEVER AUTHORITATIVE. The repo already adjudicated this with an issue number: `pty:listSessions` documents "Absence is authoritative only from a provider that serializes claims — otherwise it is 'unknown', never 'absent' (#8459)" (src/main/ipc/pty.ts:7343-7347), and `SshPtyProvider.hasPty` returns `null` before a completed listing "a miss there is ignorance about the host, not a dead PTY" (src/main/providers/ssh-pty-provider.ts:308-312). The only aggregating caller launders every remote failure with `provider.listProcesses().catch(() => [])` (ipc/pty.ts:7333), and `PtyProcessListAdmission.admit` throws on capacity and on `agent_session_ownership_unknown` (src/main/providers/pty-process-list-admission.ts:60-99). So: a rejected or truncated listing yields orphans = UNKNOWN (empty UI, no claims, no retirement), never orphans = everything.

THE ONE NEW RESPONSE FIELD: `PtyProcessSummary` gains optional `paneKey`. The relay already holds it (`ManagedPty.paneKey`, pty-handler.ts:1446, :139-140) and omits it from the summary (:1899-1908). Additive optional response field — safe under docs/reference/remote-wire-compatibility.md, no opcode, no negotiation. It does NOT reach the client for free: `PtyProcessInfo` has no `paneKey` (src/main/providers/pty-process-info.ts:4-16) and `admit` REBUILDS an allowlist (pty-process-list-admission.ts:106-115). Three edits — relay summary, `PtyProcessInfo`, allowlist — and the oracle asserts survival THROUGH `admit`. `incarnationId` and `worktreeId` already traverse that whole chain, which is what makes the incarnation-scoped subtraction free.

ADOPTION matches `parsePaneKey(reported.paneKey)?.leafId` — never the full string, because the relay's copy is frozen at spawn and names a tab the leaf may have left. Because the record is leaf-keyed this is a direct lookup, not fuzzy equivalence; `isEquivalentPaneKey` is not imported here. Adopt is a CAS: write `leafId -> (ptyId, incarnationId)` only if no non-terminal record exists for that leaf AND none on this host names that `(ptyId, incarnationId)`. Exactly one of two concurrent adopts wins; the loser gets a typed refusal.

KILL POLICY (replaces the "owned elsewhere" classification, which is DELETED). Both reviewers attacked `worktreeId`-based classification from opposite directions and both are right, because `worktreeId = <repoId>::<path>` and `repoId` is a client-local `randomUUID()` minted at repo add (src/shared/worktree-id.ts:15-28; src/main/runtime/orca-runtime.ts:18729). So "unknown worktreeId" means "not in this install's current state file": it wrongly EXEMPTS the user's own shells after a repo re-add, profile transfer or state reset, and it wrongly INCLUDES another device's shells whenever the two installs share state. One rule replaces it: the orphan list never auto-kills, never bulk-kills, and never kills as a side effect of any reattach or cleanup pass. Kill is an explicit per-shell user action, with cwd, title, worktreeId and reported paneKey shown. No classifier, no new field, and it is safe in both directions.

OLD-RELAY DEGRADATION: a relay that omits `paneKey` yields unclassified orphans that are listed and never killed — exactly today's behavior.

=====================================================================
D5. RECORD LIFETIME — three exits, none of them "absent from a list"
=====================================================================

1. RETIRE (delete). The record reached `terminated` (row 1 or row 2 of D3, or explicit user close via `retireExitedPty`, ssh-relay-session.ts:2153-2172). Terminal records are garbage-collected after a bounded retention (long enough to serve any surviving grant window) so they cannot mask a recycled `pty-1`. There is NO retire-on-absence clause: the case it was written for (shell exited during a disconnect, relay still up) is already covered by row 2 — the attach itself proves the exit — so deleting the clause costs nothing and removes a direct contradiction with #8459.
2. RELEASE (keep the shell, drop the claim). Fired ONLY from the explicit pane-close and tab-delete code paths — never from "this publish did not contain the leaf". Detach is not atomic across layouts: `createTab` installs an empty layout, then `setTabLayout(sourceTabId, ...)` removes the leaf, then `setTabLayout(tab.id, ...)` adds it (terminal-pane-tab-detach.ts:298-300), so between the last two no layout contains the leafId, and any `session:set` flush in that window would look like a durable removal. Released records are cleared to a non-claiming state: the shell becomes orphan-eligible (visible, adoptable) and is deliberately NOT `terminated`, so it can never authorize a respawn.
3. EXPLICIT USER CLOSE -> `terminated`, and the record dies with the shell.

RESIDUAL, STATED HONESTLY: a shell that died while the relay ALSO restarted leaves a `detached` record with no proof available. It stays restorable until the user acts. That is the conservative direction and it is bounded by the affordance below, not by a timer.

PRODUCT AFFORDANCE, REQUIRED IN THE SAME PR. A `detached` pane renders as disconnected with two explicit actions — "reattach (retry)" and "start a new shell" (the latter retires the record). Nothing infers death, nothing auto-spawns. Per AGENTS.md this must follow docs/STYLEGUIDE.md. COPY CONSTRAINT: the UI must never assert that a shell is dead. The claim "after a relay crash the shells are almost certainly dead" is REMOVED from this design: it rests on POSIX master-fd close SIGHUPing the foreground group, and on Windows the relay is deliberately launched through WMI because "Windows sshd kills the exec channel's process tree on close" (src/main/ssh/ssh-relay-deploy.ts:1805), with ConPTY and no SIGHUP. No rule in this design concludes anything from a relay restart, so the design is correct either way; only the copy had to change.

=====================================================================
D6. HISTORICAL — one partition per (target, pane). SUPERSEDED.
=====================================================================
This migration proposal was rejected. The shipped containment keeps the existing persistence
planes and gives the pane binding one local home; see [S4](./new-design-goalposts.md#s4--one-partition-per-target-pane--proven).

SSH pane bindings live in two partitions today. Readers and writers that consult ONLY `ssh:<target>`: `resolvePersistedStablePaneOwner` (src/main/ipc/pty.ts:676-677), `retirePersistedStablePaneOwner` (:760-761, :783), the CAS write `persistPtyBinding(..., expectedBinding)` (:833), and the two spawn upserts (:5108, :6493). Against that, the relay reattach write has no hostId (ssh-relay-session.ts:2500-2511 -> `resolveHostId(undefined)` -> `LOCAL_EXECUTION_HOST_ID`, persistence.ts:6243-6246) and the renderer keeps SSH worktrees in `local` deliberately (workspace-session-host-persistence.ts:167-173). `durablyBoundPtyIdForPane` hedges ssh-first-then-local (persistence.ts:7269-7277), so `supersedeSiblingLeasesForPane` early-returns when the bound pty differs (:7229-7232) — supersession silently no-ops and both leases stay live. That is the STA-3077 mechanism itself.

FIX: one accessor `sessionForSshPaneBindings(connectionId): WorkspaceSessionState` returning the `local` partition, routed through by EVERY reader and EVERY writer above, flipped in a single atomic PR — not five write-site edits. `local` wins because the only publisher of pane membership writes there and `mayCreate:false` is evaluated there. A one-time fold moves `ssh:<target>.terminalLayoutsByTabId[*].ptyIdsByLeafId` and `tabsByWorktree[*].ptyId` into `local`, preferring `local` on conflict; the loser is NOT demoted to orphan-candidate by ptyId alone (recycled ids collide) — it carries `incarnationId` or is dropped.

=====================================================================
D7. HISTORICAL — one bind producer. RESOLVED.
=====================================================================
The shared `bindPaneShell` producer now serves relay reattach and both spawn handlers; see
[S5](./new-design-goalposts.md#s5--the-superseded-pane-fence-is-live-on-the-reattach-path--proven).

`rememberPaneKeyForPty` (ipc/pty.ts:517-525) has two callers, both spawn (:5222, :6668). `restoreReattachedPtyRuntime` calls `runtime.registerPty` instead (ssh-relay-session.ts:2523), and `isSupersededPtyId` returns `false` for an unrecorded id by design (:284-296) — so the shipped superseded-PTY fence is INERT on the path it was built for. Collapse to one `bindPaneShell({ hostId, worktreeId, leafId, ptyId, incarnationId, relayInstanceId })` that, in one call, (a) resolves the current tab containing the leaf (refusing if none), (b) writes the durable record, (c) writes the in-memory `ptyPaneKey`/`paneKeyPtyId` fence maps using the paneKey composed from the CURRENT tab, (d) calls `registerPty`. All three paths call it and nothing else.

=====================================================================
D8. COLLAPSE THE RESTORABLE FORK — and the offline/synchronous path
=====================================================================
`setLocalWorkspaceSession` forks on whether the INCOMING layout map is empty (persistence.ts:6450-6473): empty -> `isRestorablePtyBinding` (absence of a lease implies restorable, :6620-6631); partial -> `hasRestorableSshRemotePtyLease` (requires a live lease, :6670-6685). They disagree on the absent-record case, so whether a binding survives depends on whether a SIBLING LEAF had one.

One predicate replaces both: RESTORABLE IFF `paneShellOwnershipByLeafId[leafId]` exists with state `attached` or `detached`.

OFFLINE / SYNCHRONOUS ACCESS PATH (refutation B, honored exactly). `setLocalWorkspaceSession` is a synchronous `void` method invoked on every renderer publish including during quit (persistence.ts:6465, :6287, :6351). The loop at :6448-6462 already iterates `priorLayout.ptyIdsByLeafId` and therefore already holds a `leafId`, so the new predicate is a DIRECT map lookup on a top-level, main-owned, in-memory-mirrored disk record: no key composition, no lease-array scan, no `incomingHasAnyBinding` branch, no mux, no RPC, no host. It works with the host down and during quit — which is precisely what refutation B says cannot be replaced by asking the host.

=====================================================================
D9. THE REATTACH ALGORITHM (SSH, on connect)
=====================================================================

1. Obtain the consumer owner grant. Read `grant.relayInstanceId` (may be absent — old relay).
2. Work list = `getPtyIdsForConnection(target)` UNION `{ r.ptyId | r.hostId === 'ssh:'+target and r.state !== 'terminated' }`, every id normalized through `toRelaySshPtyId`.
3. PROCESS GATE. For each record: if both `grant.relayInstanceId` and `r.relayInstanceId` are present and differ, do not attach by that id. Set `detached`. Its shell, if any, is rediscoverable only through step 5.
4. For each remaining id, call `pty.attach { id, cols, rows }` — with NO expectedPaneKey and NO expectedTabId.
   4a. SUCCESS -> if a record exists and `response.incarnationId !== r.incarnationId`, throw (activation lease rolls back), set `detached`, no grant, no exit. Otherwise call `bindPaneShell(...)`: resolve the current tab containing `leafId`; if none, log and leave the shell running unbound (today's refusal, preserved); else write record (`attached`, `relayInstanceId = grant.relayInstanceId`), fence maps, `registerPty`.
   4b. NOT-FOUND -> if `grant.relayInstanceId` is present and equals `r.relayInstanceId`: `terminated`, retire, grant authorized (gated on E-1). Otherwise: `detached`, no grant, and route into the existing `restoreRequired = 'reattachAttemptsExhausted'` branch. No `pty:exit -1`, no `clearProviderPtyState`, no `deletePtyOwnership`.
   4c. ANY OTHER ERROR -> `detached` via the same existing branch.
5. Call `listProcesses` best-effort. If it REJECTS or admission truncates it: orphans = unknown; do nothing. If it RESOLVES: orphans = returned MINUS `(ptyId, incarnationId)` named by non-terminal records on this host. For each orphan with a reported `paneKey`, look up `parsePaneKey(paneKey)?.leafId`; if that leaf exists in the live layout and has no non-terminal record, CAS-adopt it via `bindPaneShell`. The rest are listed in the cleanup UI, never auto-killed.

=====================================================================
D10. MIGRATION, SEQUENCING, ROLLBACK
=====================================================================
ORDER — each its own PR, each independently revertible:

|     | Step                           | Contents                                                                                                                                                                                                                                                          |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Identity-mismatch is not death | Renderer: `isProvenSshSessionGoneError` stops treating the mismatch marker as proof. Relay+main: delete the whole attach-identity apparatus (D2). Pure bug fix, no design dependency, ships FIRST; the renderer half must ship even before relays are redeployed. |
| E-0 | Stop lying about exits         | Collapse the plain-not-found branch of `handlePtyReattachFailure` into the existing non-destructive `restoreRequired` branch (D3). Ships with, or immediately followed by, the D5 disconnected-pane affordance.                                                   |
| P   | Single partition               | D6: one accessor for every reader and writer, plus the fold migration, atomically.                                                                                                                                                                                |
| F   | Single bind producer           | D7: `bindPaneShell`; makes the shipped fence live on the reattach path; introduces tab-from-layout resolution.                                                                                                                                                    |
| E-1 | Prove the grant executes       | Production-id-shape oracle for `recoverTerminalPane`; record the actual behavior.                                                                                                                                                                                 |
| E-2 | Death rule                     | `relayInstanceId` on the grant + the D3 table. Conditional on E-1.                                                                                                                                                                                                |
| W   | Projection                     | `paneKey` through relay -> `PtyProcessInfo` -> admission allowlist; incarnation-scoped subtraction; explicit-only kill (D4).                                                                                                                                      |
| K   | Re-key                         | The leaf-keyed record + D8 + D5 lifetime + `reassignSshTargetId` field rewrite + porting all lease readers.                                                                                                                                                       |

E-1 CONTEXT (why E-2 is conditional). The chain `not-found -> expired -> 30s grant -> createTerminal` has one spawn-authorizing caller, `recoverTerminalPane` (src/main/runtime/orca-runtime.ts:16449-16490), gated on `getRecentExpiredSshLease(...)`, whose comparison is raw `lease.ptyId === ptyId` with no normalization (:6310). `lease.ptyId` is relay-native (persistence.ts:7184) while the graph's `pty.ptyId` is app-form `ssh:<conn>@@pty-N` (ssh-relay-session.ts:2523), so for a real SSH pane they can never be equal, and the branch also cannot be reached by a local pane (it requires an SSH lease). The covering test seeds both sides as `'pty-expired'` and registers with a NULL connectionId (orca-runtime.test.ts:1350-1370, :2932-2940) — a shape production cannot produce. Do not build grant-arbitration machinery before E-1 shows the branch executing.

FORWARD MIGRATION AT K, per `SshRemotePtyLease`:

- has `leafId` -> one record. `state`, `createdAt`, `updatedAt` copied VERBATIM (any surviving grace window reads `updatedAt`). `worktreeId` copied as an OPAQUE FULL STRING — the `::workspace:<uuid>` folder-workspace suffix must survive, since matching is full-string equality (persistence.ts:7239, orca-runtime.ts:6308) and issue #12474 was a comparator that stripped exactly that. `ptyId` stays relay-native. `tabId` is DROPPED (D1). `relayInstanceId` absent -> the record falls to `detached` on first reconnect with no ambiguity to resolve. `incarnationId` absent on a legacy row -> treat as adoption-eligible rather than as a subtracting claim, so it cannot mask a recycled id.
- no `leafId` -> no record; recovered at first reconnect by the leaf-half `paneKey` match, or listed as an orphan.
- ALSO synthesize a record from any live layout binding (`ptyIdsByLeafId`) whose ptyId has no lease, so a bound-but-unleased pane is not silently demoted.
- Sequence AFTER the legacy numeric-leaf remap (persistence.ts:1858-1872) so every record keys on a UUID.

PORT EVERY LEASE READER — the "write-only legacy projection" claim was FALSE and is corrected. Verified production readers of `sshRemotePtyLeases` outside persistence.ts:

- `getRecentExpiredSshLease` (orca-runtime.ts:6295-6316) with `ptyId` UNDEFINED, feeding `hasRecentExpiredSshLeasePane` (:6318-6323) -> the headless-mobile terminal-tab filter (:5290-5299 region, the `onlyRuntimeOwnedTerminals` filter) and `hasLiveOrPersistedServeOrSshOwnedPtyBinding` (:6355-6360). These are a live VISIBILITY signal for paired mobile/HUB clients and are NOT killed by the namespace bug, because they pass `ptyId` undefined. Port: "a non-terminal record names this leaf" replaces "an `expired` lease within 30s". Visibility becomes bounded by the D5 lifetime rule instead of a timer; that behavior change is deliberate and must be covered by an oracle.
- `ssh:terminateSessions` (src/main/ipc/ssh.ts:1282-1300) enumerates leases and distinguishes owned from expired (#2626). This is the EXISTING kill affordance; the D4 orphan UI FEEDS it rather than duplicating it. It is re-expressed over records: non-terminal records plus projection entries, with kill always explicit (D4).
- `ssh:resetRelay` (ipc/ssh.ts:1370-1385) marks every live lease `expired` after force-killing the relay. Ported to: mark records `detached` (never `terminated` — the client killed the relay, which proves nothing about the shells). BEHAVIOR CHANGE, flagged for the owner: a user-initiated relay reset stops silently re-showing panes for 30s and instead shows the disconnected affordance.
- `ssh-relay-session.ts:1914, :2197` internal lease reads -> record reads.

CROSS-VERSION READS. Pinned older builds read `sshRemotePtyLeases`. For ONE release the new writer emits a derived legacy projection of the array. It must emit RELAY-NATIVE ptyIds via `toRelaySshPtyId` — leaking app-form ids gives pinned builds leases matching nothing, a silent no-op that looks like a passing test. Because the record already stores the relay-native form, this is a copy, not a conversion. It carries no `tabId`-dependent semantics, so old builds that call `expectedIdentityForLease` simply get `null` and attach without an identity — which, after step A, is the correct behavior anyway.

PARTIAL WRITE / ROLLBACK. Reuse the existing discipline (persistence.ts:7346-7360): snapshot, mutate in memory, `flushOrThrow`, undo on failure. One record, so this is a single-record transaction. Rollback of K: the legacy projection lets an older build boot on new state; the one-way loss is leafId-less rows, which the old build also could not act on.

`reassignSshTargetId` (persistence.ts:7055-7086) today re-keys partitions, rewrites lease `targetId`s and drops recoveries. Because `hostId` is a FIELD and not part of the key, it only rewrites a field in place plus the reverse index; no re-keying.

=====================================================================
D11. ORACLES — each must redden under a stated mutation
=====================================================================

1. DETACH-TO-TAB OVER SSH, THROUGH THE REAL RELAY COMPARISON. Bind an SSH pane in tab A leaf L, run `detachTerminalPaneToTab` to tab B, disconnect, reconnect. Assert: exactly one shell on the host, no second agent resume, the pane reattaches and the ptyId lands in tab B's layout. THIS MUST BE RED BEFORE STEP A. If it is green today, the harness stubbed the relay comparison or omitted `ORCA_PANE_KEY`/`ORCA_TAB_ID` from the spawn env, and the whole detach oracle family is measuring nothing. Gate the program on it going red first.
2. Identity mismatch is not proof of death. Assert `isProvenSshSessionGoneError` is false for the mismatch string, no record reaches `terminated`, no grant. Mutation: restore `.includes(SSH_SESSION_EXPIRED)` as the sole predicate (reattach-failure-classification.ts:29).
3. Wrong-incarnation attach is abandoned, not adopted and not fatal. Relay returns a different `incarnationId` than recorded: assert no bind, no stream, `detached`, no grant, activation lease rolled back. Mutation: skip the response check.
4. Same-instance not-found is proof; different or absent is not. Two runs, recorded `relayInstanceId` equal -> `terminated` + grant; differing/absent -> `detached` + no grant. Mutation: flip the comparison.
5. Failed listing is not an empty listing. Make `listProcesses` reject, and separately make `admit` throw `agent_session_ownership_unknown`: assert zero records retired and zero orphans reported. Mutation: replace the failure with a resolved `[]` — must redden, proving the implementation does not reuse the `.catch(() => [])` shape at ipc/pty.ts:7333.
6. No fabricated exit on unknown. Drive `handlePtyReattachFailure` with a not-found and a differing `relayInstanceId`: assert `detached`, no grant, no `pty:exit -1`, and that provider state and ownership are NOT cleared. Mutation: restore the block at ssh-relay-session.ts:2641-2647.
7. Detach mid-publish does not release. Force a `session:set` flush between `setTabLayout(source)` and `setTabLayout(target)`: assert ownership is NOT released. Mutation: release on any publish missing the leaf.
8. Pane/tab delete releases. Delete a tab while its shell is live: assert the record is released, the shell IS an orphan, and no respawn is authorized. Mutation: remove the release rule — the shell must become invisible to both adopt and the cleanup UI.
9. Production id shapes in the recovery grant (E-1). Seed relay-native `pty-7`; register the runtime pty as `ssh:<conn>@@pty-7` with a NON-NULL connectionId; call `recoverTerminalPane`; assert the actual behavior. Mutation: swap either namespace.
10. E-2 false not-found. Same `relayInstanceId`, not-found caused by the wrong id form while the shell is in the Map under the correct id: assert NO `terminated` and NO grant. Mutation: skip `toRelaySshPtyId` on the attach path.
11. Projection is incarnation-scoped. Record `pty-1@incX`; restart the relay; it mints `pty-1@incY` for a different pane: assert the fresh shell IS an orphan and the stale record does NOT mask it. Mutation: subtract on ptyId alone.
12. `paneKey` survives `admit`. Mutation: remove it from the allowlist rebuild (pty-process-list-admission.ts:106-115).
13. Detached shell is still re-adopted. Seed a leafId-less lease whose relay-reported `paneKey` names a DIFFERENT tab than the live pane: assert the shell is attached exactly once and no second shell spawns. Mutation: match on full-string paneKey. This is the migration gate — green before K, re-run after.
14. Paired-client visibility survives the state rename. Record in `detached`, ptyId absent from every layout: assert `buildHeadlessMobileSessionTerminalTabs` still yields the tab. Mutation: drop the `expired`-equivalent — orca-runtime.ts:5964/:6290/:6322/:6359 must all be covered, not just the dead :16478 caller.
15. Cleanup UI reaches the user's own abandoned shells. Delete the repo row (new `repoId` on re-add) while shells run: assert they are offered for cleanup. Mutation: reinstate worktreeId-based "owned elsewhere" — must redden.
16. Nothing is killed implicitly. Any reattach/cleanup pass over foreign or unrecognized shells: assert zero kill RPCs. Mutation: auto-kill unclassified orphans.
17. One pane, one live shell across partitions. Two live shells for one `(worktree, tab, leaf)` with the binding only in `local`: assert exactly one is bound. Mutation: restore the ssh-first preference in `durablyBoundPtyIdForPane` (persistence.ts:7271).
18. P covers readers. Seed a binding only in `local`, call stable-pane resolve/retire with `connectionId` set: must find it. Mutation: revert either reader.
19. Adopt is exclusive. Two concurrent adopts of one orphan: one succeeds, the other gets a typed refusal.
20. Renderer cannot clobber ownership. Publish a stale full `WorkspaceSessionState` via `session:set`: assert the ownership map is byte-identical.
21. Offline quit path. Restorable predicate with store only and a null mux: must not throw, must not require an RPC (persistence.ts:6465).
22. Folder-workspace suffix. Two `::workspace:` instances on one path: a record for A must not reattach into B.
23. Target reassign carries ownership. `reassignSshTargetId(old, new)`: every record's `hostId` field and the reverse index follow, with no re-keying.
24. Windows/WSL relay kill. Assert the rules produce `detached`, never `terminated`, and that no UI copy asserts death. Mutation: assert-death — must redden on a Windows fixture even though it would pass on POSIX.
25. Old-relay degradation. `listProcesses` without `paneKey`, grant without `relayInstanceId`: projection non-empty, nothing killed, reattach falls back to the `getPtyIdsForConnection UNION records` work list, and the per-attach incarnation guard still rejects a recycled id.

=====================================================================
D12. RE-TEST AGAINST THE SECTION-3 REFUTATIONS
=====================================================================
REFUTATION A LEG 1 — "a lease must name a live shell no pane owns." SURVIVES. Discovery never was the lease's job: reattach builds its list from `getPtyIdsForConnection(target) UNION` the durable rows (ssh-relay-session.ts:2211-2219), and the connect-time projection adds host-reported shells on top. Leaf-keying does not weaken this. D5's RELEASE-vs-RETIRE distinction is REQUIRED BY this leg: a record whose leaf is gone must be released (shell stays discoverable and adoptable) rather than deleted (knowledge lost) or terminated (respawn wrongly authorized).

REFUTATION A LEG 2 — "a lease outlives the binding; expiry authorizes a 30s recreate." First clause survives exactly: `detached`/`terminated` are states on a main-owned, top-level record that persists after the layout binding is wiped. The recreate clause is PRESERVED AS A CONDITIONAL, not deleted: E-2 keeps a grant, gated on `relayInstanceId` equality, and only after E-1 shows the branch executes at production id shapes. Deleting the grant outright — proposed twice — is still refused as a simplification, because it dies to A leg 2 as written and rests on a read-not-run conclusion; it remains available as an E-1 OUTCOME. What does ship regardless is the user affordance, which covers every case a narrowed grant would drop.

REFUTATION B — "make the host authoritative." SURVIVES, and is honored more cheaply than before. Ownership stays on local disk, top-level, main-owned, read synchronously inside `setLocalWorkspaceSession` during quit with the host down (D8). Everything this design changes is the record's KEY and WHAT MAY TRANSITION IT — never where it lives or how it is read. The host is consulted only while connected, and only for "which shells are in your Map?", "is this the same shell I bound?" (incarnation) and "are you the same process?" (relayInstanceId) — three questions it answers from data it already holds. Critically, D4's deletion of retire-on-absence is what keeps refutation B intact under load: a design that retired durable ownership because a remote listing timed out would have made the host authoritative by accident.

REFUTATION C — a second authority architecture. Untouched, and this revision deletes more than the last: no decision table, no `hostEpoch`, no `os.uptime` math, no per-platform boot semantics, no paneKey transfer/alias layer, no attach-time identity apparatus, no orphan-ownership classifier, no second durable record.

WHERE THE CUT IS. Plane 1 (delivery identity, credit ledger, chunk-and-ack, binary payloads, loopback WebSocket) proceeds in parallel. The cut is DURABILITY SCOPE vs EVIDENCE SOURCE, and this revision now applies that rule to all four inferences the prior round left standing: an error string means dead (deleted, D2), absence from a list means dead (deleted, D4/D5), a delivery-checkpoint flag means alive (deleted, D3), an arithmetic clock means rebooted (never built, D3). What remains on the wire is two optional fields: `relayInstanceId` on the grant and `paneKey` on the process summary. RC3 is entirely Plane 1's.
