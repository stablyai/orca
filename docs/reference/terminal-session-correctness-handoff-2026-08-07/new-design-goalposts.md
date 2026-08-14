# New design — goalposts

Tracks the design approved on 2026-08-09 (`design-explained.html`, detail in
`counsel-design.html`). Updated as work lands. Progress in every status update
is reported against this file.

## How to read a status

| Status | Means |
| --- | --- |
| **PROVEN** | An oracle asserts the behaviour, removing the production guard **reddens** that oracle, and the mutation was verified to actually land before the result was believed. |
| **ORACLE RED** | The oracle is written and currently fails for the right reason. The production change is not written yet. This is the intended pre-implementation state. |
| **NOT STARTED** | No oracle. |
| **BLOCKED** | Waiting on another goalpost or an owner decision. |

A green test is **not** a status. This program shipped three guards that passed
their tests while sitting off the route production takes; "PROVEN" exists to
make that impossible to claim by accident.

---

## Scoreboard

| | Count |
| --- | --- |
| Step goalposts proven | **7 of 7** (one deleted as unreachable) |
| Global goalposts proven | **5 of 6** — G1 missed, see below |
| Scope removed by evidence | S7 (death rule) — never built |
| Oracle clauses green | 26 |
| Oracle clauses red (awaiting implementation) | 0 |
| Net production lines, correctness work | **+13** |
| Net production lines, incl. the approved affordance | **+83** |
| Net test lines | +2,578 |

**G1 is not met, and that is reported rather than smoothed over.** The design's
net-negative target assumed the remaining steps were collapses. Three were
(S3 −21, S8 −32, and the relay half of S5), but two genuinely add code: the
single `bindPaneShell` producer (+60, since one function replaces three
divergent call sites without those sites shrinking much) and the D1
disconnected-pane affordance (+70), which is a new product surface the owner
approved — a feature, not a refactor. Excluding the affordance the correctness
work is +13, i.e. roughly a wash. See "G1" below for the full accounting.

---

## Step goalposts

### S1 — An identity mismatch is never read as death · **PROVEN**

*Guarantee.* The relay reports a pane-identity mismatch by saying the pty was
not found. It found it — comparing is how it noticed. That must never reach a
respawn decision as proof of death.

- Oracle: `src/main/providers/ssh-pty-identity-mismatch-is-not-death.test.ts`,
  `src/renderer/src/components/terminal-pane/reattach-failure-classification.test.ts`
- Clauses: 7 + 3
- Mutations proven: restoring the destructive wrap reddens 2 clauses; deleting
  the classifier guard reddens 1 — clause-selective, each proven separately.
- Landed: `e2524b0472f`

### S2 — Pane identity is not sent on reattach · **PROVEN**

*Guarantee.* Moving a pane to another tab must never make its terminal
unreachable.

- Oracle: same file, `reattach does not ask the relay to police pane identity` (2 clauses)
- Also inverted an existing test that pinned the removed behaviour, so the new
  intent stays covered rather than silently dropped.
- Works against **already-deployed relays**: the relay's comparison is
  presence-guarded, so not sending the fields disarms it everywhere. No wire
  change, no redeploy.
- Landed: `c51be8072ba`

### S3 — A failed reattach never fabricates an exit · **PROVEN**

*Guarantee.* On an unproven not-found, the pane is not told the program exited,
ownership is not deleted, provider state is not cleared, and the lease is not
expired. The case routes into the non-destructive recovery branch that already
exists.

- Oracle: `src/main/ssh/ssh-relay-reattach-exit-proof.test.ts` — 8 green
- Mutation proven: restoring the destructive block reddens 6 of 8 clauses; the
  2 producer pins stay green, so the mutation is clause-selective.
- Two tests pinned the deleted premise ("attach verifies liveness before
  answering not-found") and were **inverted**, not patched.
- Shipped with the disconnected-pane affordance below, since panes now stay
  visible instead of silently respawning.
- Landed: `c19f1b386b4` (−21 production lines)

### S4 — One partition per (target, pane) · **PROVEN**

*Guarantee.* A pane that re-leases under a new relay id across reconnects ends
with exactly **one** live claim; the predecessor is superseded, not left live.

- Oracle: `src/main/ssh-pane-binding-partition.test.ts` — 7 green (one clause added)
- The highest-value goalpost: the mechanism behind the reported 2 → 19 → 20.
- Mutation proven as a **2×2**, because the two edits mask each other:

  | reader | load fold | result |
  | --- | --- | --- |
  | hedge (original) | off | 6 red — baseline |
  | hedge | off | 4 red — the 2 source-text clauses now green |
  | local-only | off | 1 red — the reader carries 3 clauses |
  | hedge | **on** | **all green** ← the fold masks the reader |
  | local-only | on | all green |

  That fourth row is why an **eighth clause was added**: with the fold shipping,
  the fold erases the divergent copy at boot, so the reader guard would have
  shipped unproven — precisely the failure mode G5 exists to catch. The new
  clause rewrites `ssh:<target>` mid-session (orphan adoption still writes
  there) and reddens when the hedge is restored, pinning the reader on its own.
- Five clauses in `ipc/pty.test.ts` pinned the two-partition shape and were
  **inverted** to the single home, each keeping an arity check so a re-added
  partition argument fails loudly.
- Side effect found while verifying: the renderer never hydrated the `ssh:*`
  partition (`listKnownRuntimeHostIds` filters to `runtime:*`), so the Issue
  #217 force-quit binding protection had never worked for SSH panes. It does now.
- Landed: `2733c59879b` (+9 production lines — the call sites shrank; the fold
  is new state repair)

### S5 — The superseded-pane fence is live on the reattach path · **PROVEN**

*Guarantee.* After a relay-driven reattach binds a pane, a stale write aimed at
the superseded predecessor is **refused**. It used to be permitted, because the
fence's bookkeeping was only written by spawn.

- Oracle: `src/main/ssh/ssh-relay-session-reattach-pane-fence.test.ts` — 4 green
  (one clause added)
- Collapsed to one `bindPaneShell` producer used by the relay reattach and both
  spawn handlers. Error policy stays at the call sites because it genuinely
  differs: a caller that just created a shell must clean it up on a failed
  durable write; a caller that merely reattached must not detach anything.
- Mutation proven, both sub-guards isolated:
  - drop the `rememberPaneKeyForPty` call → 3 clauses redden
  - prefer the stored `tabId` over the live layout → 1 clause reddens
- That second clause is **new**. Every pre-existing clause used one tabId on
  both sides, so a producer that simply forwarded `lease.tabId` would have gone
  green and shipped the moved-pane bug unnoticed. Only the leaf half of a pane
  key is remint-stable; `detachTerminalPaneToTab` moves a live pane and its PTY.
- Two source-text clauses were **strengthened**: they used to require the relay
  to hold a `persistPtyBinding` call and merely forbade an ssh-partition
  argument. The relay now has none, so they assert **zero** direct binding
  writes there — a second bind producer is exactly the defect being removed.
- Repaired a latent false green: the "persistence fails" case in
  `ssh-relay-session-reconnect-incarnation` was passing because a missing mock
  made the call throw a TypeError that happened to emit the asserted
  `console.error`. The failure is now injected at the producer.
- Landed: `0f409055d3f` (+60 production lines — the one step that grows)

### S6 — Settle whether the 30s recovery grant executes at all · **PROVEN — it is dead code**

*Result.* It cannot execute for a real SSH pane. Verified personally:

- The lease stores a **relay-native** pty id, normalized on write
  (`persistence.ts:7184`, comment: "app ids are global").
- The caller passes the **app-form** id (`orca-runtime.ts:16478` ← `toAppSshPtyId`).
- The comparison is raw `lease.ptyId === ptyId` (`orca-runtime.ts:6310`) with no
  normalization, so the two forms can never be equal.
- The branch is also unreachable for a local pane, since it requires an SSH lease.
- Its covering test seeds both sides as the same literal with a null
  connectionId — a shape production cannot produce.

### S7 — The death rule · **DELETED on S6's evidence**

Not built. The arbitration machinery existed to referee a branch that never
executes. Per the design: "if E-1 shows the grant branch unreachable, E-2 is
deleted and the marker simply never fires, which is the safe end state."

### S8 — Remove the dead recovery-grant path · **PROVEN**

*Guarantee.* Deleting it changes no behaviour, because it has none.

- Oracle: `src/main/runtime/ssh-pane-recovery-grant-reachability.test.ts`, written
  and green **before** the deletion, so inertness is demonstrated rather than assumed.
- It mints **both** id forms from the production helpers rather than as two
  hand-typed literals, so it tracks the real namespace split instead of
  restating it, and seeds a lease qualifying on every other predicate (state,
  worktree, tab, leaf, grace window). Anti-vacuity clauses pin that control
  actually reaches the gate rather than bailing out earlier.
- Mutation proven **before** deleting: normalizing the `lease.ptyId === ptyId`
  comparison makes the grant fire and reddens the oracle. That is the exact fix
  someone would reach for, so the oracle is pinned to unreachability, not to the
  throw.
- Deleted: the grant tail, the `terminalPaneRecoveryByIdentity` dedup map (whose
  only consumer was the grant), and the dead `ptyId` parameter.
- **Not** deleted, because over-deleting here breaks users: `getRecentExpiredSshLease`,
  `hasRecentExpiredSshLeasePane` and `SSH_PANE_RECOVERY_GRACE_MS` all stay. Their
  other two callers pass `ptyId` undefined, which short-circuits the broken
  comparison — those are live and feed headless-mobile terminal-tab visibility.
- Also **not** done: deleting only the gate while keeping the spawn. That would
  have granted a respawn to every disconnected pane — a change in the dangerous
  direction. The refusal is what stays.
- Three tests pinned the grant and were **inverted**; a fourth is now
  tautological and carries a comment saying so rather than being left hollow.
- Honest limit, recorded in the oracle: unreachable **by construction** for SSH
  panes; for a local pane, unreachable only up to a random-UUID collision.
- Landed: `7d44315437a` (−32 production lines)

### Product affordance (D1) — **SHIPPED with S3**

A pane that cannot be verified renders as disconnected with two explicit actions
— "Try again" and "Start a new terminal" — instead of silently respawning.

- No new IPC channel: the silent-respawn decision was always renderer-local.
  Both actions are things the code already did, moved behind a click.
- Copy constraint enforced **as an oracle**, not as a review note: the rendered
  text must match no death verb and show no wire token. STYLEGUIDE.md:236 already
  forbids result verbs without result data, and a failed attach is not result data.
- `TerminalRemoteRuntimeReconnectBanner` → `TerminalPaneDisconnectedBanner`; it
  now serves any transport. Existing i18n key strings kept verbatim so no shipped
  translation breaks; the SSH copy is additive.
- Landed: `5e1b57bb2f9` (+70 production lines)

---

## Global goalposts

### G1 — Net production code is negative · **NOT MET (+83 this phase)**

Counted from the pre-work merge base, production only. Reported as a miss rather
than reframed until it passes.

| Step | Net production |
| --- | --- |
| S3 — collapse the fabricated exit | **−21** |
| S4 — one partition | +9 |
| S5 — one bind producer | **+60** |
| S8 — delete the dead grant | **−32** |
| D1 affordance (new product surface) | **+70** |
| Banner rename (pure move, no behaviour) | +36 of the above, not real growth |
| **Correctness work only (S3–S8)** | **+13** |
| **Total this phase** | **+83** |

Why it missed. The target assumed the remaining steps were collapses. Three were.
Two were not, for reasons worth stating:

- **S5 (+60).** One producer replacing three divergent call sites only shrinks
  the code if those sites were duplicating the whole bind. They were not — they
  each did *part* of it differently, which is exactly the defect. The producer is
  net-new; the call sites shrank by 7 lines. Collapsing the two spawn handlers'
  surrounding logic as well would buy the difference back, but it would reorder
  side effects that existing ordering assertions pin, so it was left alone.
- **D1 affordance (+70).** A new user-facing surface the owner approved. Features
  add lines; counting it against a refactor budget would be the wrong pressure —
  the way to make this number go negative would be to delete the affordance.

Where the remaining slack is, if the goal is to be met later: steps P and K of
the design (the leaf-keyed record replacing `SshRemotePtyLease`, and the lease
readers ported onto it) are the deletions this phase deferred.

### G2 — No redeploy required for the user-visible fixes · **PROVEN for S1–S8**

Fixes must work against relays already installed on people's hosts. Every step
that landed is client-side only:

- S1, S2 — proven previously.
- S3 — deletes client-side reactions to a relay message; the relay is unchanged.
- S4 — client-local persistence layout only; nothing crosses the wire.
- S5 — client-local in-memory fence maps and the durable binding.
- S8 — deletes a client-side branch.
- D1 — renderer only.

**No relay redeploy is required for any of it**, which matters because the
reported failure is happening on hosts people have already deployed.

### G3 — Wire compatibility · **SATISFIED — nothing on the wire changed**

Clients and hosts update independently. This phase added **no** RPC parameter,
no stream opcode and no published field, so there is nothing to negotiate. The
orphan projection that would have added one optional field belongs to step W,
which is not in this phase.

One wire-adjacent behaviour change is worth naming for reviewers: `terminal.recoverPane`
(RPC) now always refuses for a disconnected pane. The method still exists and its
signature is unchanged, so older clients get a refusal rather than a
`method_not_found` — and the renderer already handles refusal, because that is
what the branch did in practice anyway.

### G4 — Cross-platform · **SATISFIED by construction**

macOS, Linux, Windows, WSL. No oracle added in this phase shells out, and none
uses `echo $$` or `ps` — they assert against persisted state, in-memory maps and
rendered text. No rule that landed concludes anything from a relay restart or
from whether a shell survives a hard relay death, which is the Windows-divergent
question the design deliberately refuses to depend on. The affordance copy holds
on every platform precisely because it never claims the shell died.

### G5 — Every guard is proven live on the production route · **PROVEN for S1–S8**

For each new guard, an oracle must redden when the **producer** is removed — not
only when the guard itself is removed.

This exists because it had failed three times here: an inert `mayCreate`, a
keystroke fence inert on reattach, and a respawn gate on a minority path. S5 is
the remediation of the second.

**It nearly failed a fourth time in this phase, and the rule caught it.** S4's
reader guard (`durablyBoundPtyIdForPane` reading one partition) initially showed
*no* mutation response: restoring the ssh-first hedge left all six clauses green,
because the load fold had already erased the divergent copy at boot. The guard
was correct and would have shipped unproven. The fix was an added clause that
rewrites the ssh partition **mid-session**, which reddens on the hedge and pins
the reader independently of the fold.

Two further near-misses found and closed the same way:
- S5's clauses all used one tabId on both sides, so "compose the paneKey from
  the current tab" was unpinned — a producer forwarding `lease.tabId` would have
  gone green. A moved-pane clause now pins it.
- A case in `ssh-relay-session-reconnect-incarnation` was a **latent false
  green**: it passed because a missing mock threw a TypeError that happened to
  emit the `console.error` it asserted. Now injected at the producer.

### G6 — No `max-lines` disables · **HOLDING**

Per AGENTS.md. No per-file bumps either.

---

## Definition of done

| | Criterion | Status |
| --- | --- | --- |
| 1 | S1–S5 and S7 PROVEN, or S7 deleted on S6's evidence | **MET** — S1–S6 and S8 proven; S7 deleted on S6's evidence |
| 2 | G1–G6 satisfied, each with evidence recorded here | **PARTIAL** — G2–G6 met; **G1 missed at +83**, accounted for above |
| 3 | The reported failures covered by an oracle that reddens without the fix | **MET.** Pane cardinality: S4's ten-reconnect clause, plus an E2E spec driving three real reconnects against a Docker relay (passes). Duplicate resume: the classification clauses, plus an E2E spec where the **host itself** records every shell launch (passes). Writing the second one is what exposed that RC2 was still live — see below |
| 4 | No guard shipped without a producer-side mutation proving it is reachable | **MET** — and it caught one guard that would otherwise have shipped unproven (see G5) |

### Found after the goalposts were met

Two defects surfaced *after* every step goalpost was proven, and both were invisible to the unit
oracles that had already gone green. Recorded because they are the most useful evidence in this
phase about where these oracles stop reaching.

**RC2 survived S3 — found by writing the E2E test.** `7cd7fef927f`.
The reported duplicate agent resume was not fixed. `reattachSshPtySession` maps every relay
not-found to `SSH_SESSION_EXPIRED`, and `isProvenSshSessionGoneError` returned true for it, so the
renderer's reattach arm still respawned. The E2E harness produced the shape directly: a stalled
relay is superseded by a fresh one with no memory of `pty-1`, while the old shells keep running
under the stopped process. The new relay answers not-found for a live shell.

A not-found proves an exit only if the relay process that minted the pty is the one answering —
design D3 row 2, gated on `relayInstanceId`, which step E-2 never built. `SSH_SESSION_EXPIRED` is
not independent evidence: its only producer is that same mapping, and the token's own doc comment
claimed "the host proved the session is gone", which it never did.

So `isProvenSshSessionGoneError` returns false. This is also what makes the D1 affordance
load-bearing rather than near-unreachable. The respawn tails are deliberately kept — the design
preserves the grant as a conditional for E-2 — with a clause pinning that nothing reaches them.

**The fold left half a fence behind — found by adversarial review.** `994733d8b1a`.
`persistPtyBinding` writes the binding and its incarnation into the same partition, and the
incarnation is what its CAS compares. The fold moved only `ptyIdsByLeafId`, so after upgrade the
guard stayed in the partition nothing reads and the CAS compared `undefined` against `undefined`.
Not data loss and not a wrong-shell bind, but a guard silently weakened by a migration is the exact
shape this program keeps finding.

### Residuals, stated rather than closed quietly

- **Orphan adoption still writes the `ssh:<target>` partition.**
  `adoptTerminalOrphansFromInventory` (via `tryGetWorkspaceSessionHostIdForWorktree`)
  writes pane bindings there. S4's reader ignores that partition, so supersession
  is unaffected and the guarantee holds — but the write now lands somewhere
  nothing reads. Harmless today, and a trap for whoever touches it next. Belongs
  with step W.
- **The load fold moves leaf bindings only.** It deliberately does not touch
  `tabsByWorktree[*].ptyId` in the ssh partition: that field is a tab-level
  pointer no supersession path reads, and nulling it without a local counterpart
  to move it to would be data loss. Narrowing the fold to what the defect
  actually requires is why `reassignSshTargetId` needed no inversion.
- **The main-side detached branch still has no renderer signal.** S3 made the
  main process stop lying; the affordance covers the renderer-initiated reattach
  arms. A relay-driven reattach failure remains silent to the user. Closing it
  needs a `pty:detached` channel — deferred deliberately, not overlooked.

## Deliberately out of scope

- The data-plane work (transport delivery guarantee, binary payloads, one credit
  ledger). Real and separately justified, but independent of these goalposts.
- Rebuilding the authority architecture rejected earlier at +60,903 lines.

## Owner decisions

| | Decision | Status |
| --- | --- | --- |
| D1 | An unverifiable pane becomes visibly disconnected with two actions, instead of silently respawning | **Approved 2026-08-09** (implicit in approving the design; flagged for correction if not intended) |
| D2 | Whether the older gate/journey framing is rescoped or retired now that this design supersedes it | **Open** |
