# Design: make "Start a new terminal" a replacement, not a spawn

Supersedes the mechanism in `PR-13326-SESSION-HANDOFF-2026-08-12.md` §"Approved bounded redesign".
Keeps its **properties**; replaces several of its **mechanisms** with smaller ones, and adds the
thing it was missing — a way to actually run the decisive test.

## 1. The defect, stated once

"Start a new terminal" is routed through a path whose job is *"resolve this pane's owner and attach
it; spawn only if there is none."* Creation is that path's fallback, not its purpose. The pane's
durable binding still names the old shell at click time, so the path resolves it and adopts it.

I confirmed this first-hand earlier in the branch: commit `ab6ce176f3f` detects adoption after the
fact (`freshPtyId === sessionId`) and stops the callback from unbinding the live shell. Its own
message records that suppressing the adoption itself was left undone. So the adoption is real, and
the current code only contains its worst consequence.

## 2. Why every previous fix leaked

Each attempt expressed "do not adopt" as **another condition inside the adopting path**. Conditions
are forgettable and order-dependent, and this branch has three shipped proofs of that failure mode:

- a guard centralised into a publisher that returned `void`, so four callers paired a conditional
  publish with an unconditional `return`;
- the same rule applied to the tombstone branch and missed on the liveness branch beside it;
- the incarnation fence sent on the pane-driven route and not on the reconnect route.

Every one was "the rule exists, but this path does not ask it." A fourth condition in the same path
is the same bet again.

## 3. The design, and why it removes the defect

### P1 — Replacement is a separate operation that cannot adopt

Add a main-owned entry that performs replacement only. It contains **no owner-resolution call**: it
does not read a stable-pane owner, does not accept `sessionId`/`attachOnly`, and constructs provider
options from a narrow main-owned allowlist (dimensions + validated pane/workspace identity).

*Why this fixes it:* adoption stops being a branch that must be avoided and becomes code that is not
present. A function with no owner-resolution cannot adopt for the same reason a function with no
socket cannot make a network call. This converts "remember to skip adoption" (liveness) into "there
is nothing here to adopt with" (structure).

*Falsifiable by:* route the action back through generic spawn — the oracle in P0 must redden.

### P2 — Ownership moves in one durable commit, keyed on exact incarnation

One Store method mutates and flushes once: exact-CAS the old binding and the old active lease,
install the new binding + incarnation + attached lease, expire the exact old lease **without
touching its process**, bump the topology/lease versions, flush.

*Why:* ownership lives in the durable binding and the lease. Moved separately, there is a window
where a racing reconnect sees a half-moved pane and restores the predecessor. One commit means the
window does not exist rather than being narrow.

*Why exact incarnation:* the relay reissues `pty-N` from 1 after a reset, so any CAS keyed on ptyId
alone can match a different process. This branch already proved that and already carries the
primitive: host-attested `SshRemotePtyLease.incarnationId`, the relay-side `expectedIncarnationId`
fence, and `isRelayAttestedPtyIncarnationId` filtering synthesised values.

*Falsifiable by:* split the commit in two flushes and drive a reconnect between them.

### P3 — Ambiguity leaks, never kills

Provider/relay shutdown identifies a PTY by id only. After a dispatched spawn whose outcome is
ambiguous, we cannot prove which incarnation a shutdown would reach. So: clean up a failed new shell
only when its exact incarnation is provable; otherwise leave it running and unbound for the existing
cleanup surface to reap.

*Why:* the costs are asymmetric. Leaking costs an orphan shell that a user can already list and
terminate. Killing the wrong incarnation destroys a live agent session — the exact harm this whole
program exists to prevent.

*Falsifiable by:* make the ambiguous path call shutdown; the oracle asserting zero kill RPCs on an
unprovable outcome must redden.

### P4 — The successor is invisible until it is the owner

Spawn the replacement hidden and install its output handlers only after P2 commits.

*Why:* a new shell reusing the old raw id could otherwise deliver bytes into the predecessor's
model. Ordering removes the window without a new quarantine subsystem.

### P5 — Stale renderer work does nothing

Guard every completion on: not disposed, current transport identity, current action generation. A
stale callback must not clear a binding, republish the card, or kill a result. Main owns the durable
transition, so the renderer never clears the old binding on success.

## 4. What I am deliberately NOT building, and the risk of each

The handoff prescribes more machinery. I judge these unnecessary for this defect; each is a
reversible decision if an oracle shows otherwise.

| Prescribed | Decision | Reasoning | Risk if I am wrong |
|---|---|---|---|
| Opaque ticket bound to ~11 fields (sender, both generations, worktree, tab, leaf, pane key, both ids, both incarnations, expiry, 5-state machine) | **Replace** with an operation id + expected-owner `{ptyId, incarnationId}` CAS | The renderer is not a trust boundary — it can already open terminals. The ticket's real jobs are staleness and idempotency, which the CAS and op id give directly. Eleven bindings add eleven invalidation paths, and invalidation bugs are the same class we are trying to leave | A forged/stale request creates one blank shell for a pane the user owns — recoverable, and the CAS still refuses to move ownership off an unexpected incumbent |
| A new shared owner mutex | **Reuse** `paneSpawnReservationsByOwnerKey` (already per-pane) and the runtime pane-create claim | Serialisation already exists at exactly this granularity; a second lock invites lock-order bugs | Two operations interleave on one pane; the P2 CAS still refuses the loser |
| A quarantine subsystem for provider output | **Reuse** hidden spawn + install-after-commit ordering | Achieves the same property with existing options | Bytes reach the wrong model; caught by the P4 oracle |

## 5. The part the previous session was missing: the decisive test can now run

`tests/e2e/ssh-disconnected-pane-affordance.spec.ts` holds the decisive case at `test.fixme` because
**the state was not inducible**: it needs the SSH target CONNECTED while exactly one pane's
`pty.attach` fails with an error that does not prove the shell gone. Host faults tried (SIGSTOP the
relay) take the whole connection down and produce the connection overlay instead.

That state is now inducible, by a mechanism this branch added for another reason. The relay refuses
an attach whose `expectedIncarnationId` names a different shell, with
`PTY "<id>" identity mismatch` — per-pty, connection healthy, and explicitly not proof of death
(`SSH_PTY_IDENTITY_MISMATCH` never grounds a respawn).

So the test can seed the pane's lease with an incarnation that is not the host's, reconnect, and get
exactly the state the banner needs — deterministically, with no timing fault.

**This is the highest-value item in the plan and it comes first.** The previous session looped
because every claim was adjudicated by reading code; with the oracle running, the design is
*demonstrated* instead of argued, and a regression reddens instead of being found in review.

## 6. Goalposts

Each is a behaviour with a stated mutation that must redden it. G1 is a prerequisite for believing
any of the others.

| # | Goalpost | Mutation that must redden it |
|---|---|---|
| **G1** | The decisive E2E runs unskipped: with the target connected, one pane unreachable, clicking "Start a new terminal" yields exactly one new remote shell, the pane count is unchanged, and the host transcript shows no second agent launch | Remove the induction; the test can no longer reach the banner |
| **G2** | The action never adopts: the pane's shell id/incarnation after the click differs from before, and the new shell has no command, resume metadata, launch token, agent, or startup delivery | Route the action back through generic `pty:spawn` |
| **G3** | Ownership moves atomically: a reconnect racing the replacement cannot restore the predecessor; binding and lease agree at every observable point | Split the durable commit into two flushes |
| **G4** | Ambiguity never kills: on an unprovable spawn outcome, zero shutdown RPCs are issued and neither process dies | Call ID-only shutdown on the ambiguous path |
| **G5** | The successor is silent until it owns the pane: no provider bytes reach the predecessor's model, including when the raw id is reused | Install output handlers before the commit |
| **G6** | Stale renderer work is inert: a disposed or superseded callback clears no binding, republishes no card, kills no result | Drop the generation guard on the completion path |

## 7. Sequence

0. Remove the rejected six-file WIP (targeted edits, not a broad restore — the worktree is dirty).
1. **G1** — induction + un-`fixme`. Nothing else is believable until this runs.
2. **G2** — the separate replacement operation.
3. **G3** — the single durable commit.
4. **G4/G5/G6** — ambiguity, ordering, staleness.
5. Adversarial review on both models, then push.

## 8. Stop conditions

- If G1 cannot be made to run, stop and report. Building 2–6 without it repeats the previous loop.
- If exact cleanup cannot be achieved within existing local/provider contracts, take the leak (P3).
  Do **not** add `expectedIncarnationId` to remote shutdown — that is a separate, capability-
  negotiated wire change with its own review.

---

## 9. Findings from running the gate (2026-08-13)

The oracle in §5 works: the state is inducible and the card appears reliably. Running it found
three things that reading had not.

**Fixed — the card's buttons were unclickable.** `TerminalErrorToast` renders at `z-50` in the same
bottom strip and was suppressed only for the connection overlay, not for the pane's own card. In
the one state this affordance exists for, both actions were covered. `TerminalPane.tsx` now also
suppresses it while the active pane shows the card.

**Fixed — a session id is the instruction to attach.** "Start a new terminal" was still sending the
pane's recorded `sessionId`, which routes straight to reattach before any pane-owner logic runs, so
the action attached the very shell it could not reach and created nothing. Skipping owner
resolution in main was NOT enough on its own; the id had to be dropped at the last gate before the
IPC (`admittedSessionId` in `pty-transport.ts`).

**OPEN — the action produces no spawn at all.** With both fixes in, the measured result after
clicking is still `visible=true launches=1 shells=1`: the card clears briefly, no shell is created,
and the card returns. The main log over the same window shows only the pane's own restore retries
(three `spawn() called with sessionId=…` → `identity mismatch`), never a fresh spawn.

The evidence points at the action closure rather than the spawn path: the pane retries its restore
while the card is up, each retry republishes the card, and the button the test clicks appears to
belong to a superseded connection whose `startFreshSpawn` no longer does anything. That is the
"stale renderer work" hazard from the original handoff, showing up as a dead button rather than as
a wrong write.

**RESOLVED.** Instrumenting handler, transport and main in one correlated run disproved the
closure hypothesis: the handler ran, the connection was live, and the renderer half was already
correct — it sent no session id and asked for adoption to be refused. Main re-derived the id anyway.

The rule had been applied at the two places an owner is PRODUCED and missed at the one place it is
CONSUMED: `spawnForStablePane` turns an owner into `sessionId` for the provider, which is what makes
an attach an attach. Gating there — `if (args.owner && !args.refuseAdoption)` — closes it for every
producer at once, present and future.

The gate now passes, and reverting that single condition reddens it.

Lesson worth keeping: this rule leaked at three sites in a row (early owner resolution, the
transport's session id, the owner consumption). Each fix was necessary and none was sufficient. The
one that finally held was the one placed where the value is USED rather than where it is derived.
