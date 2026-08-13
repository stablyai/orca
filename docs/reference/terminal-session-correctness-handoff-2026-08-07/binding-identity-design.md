# Design: one authoritative binding identity

Status: **superseded by the shipped server-side fence.** Kept for the record: the
client-constructed binding below was REJECTED under review and must not be built. Written 2026-08-08 by the engineer who took
the program over. Supersedes nothing until reviewed.

## The problem, stated once

Every defect this program has touched is the same defect: **identity compared
with the wrong key, or not compared at all.**

| Defect                 | Mechanism                                                               |
| ---------------------- | ----------------------------------------------------------------------- |
| STA-3077 RC1           | lease keyed `(targetId, ptyId)`; pane fields present but not in the key |
| STA-3077 RC3           | reattach used a _creating_ store write                                  |
| #12474 (live on main)  | `runtimeWorktreeIdsEqual` strips the folder-workspace instance suffix   |
| Local exact operations | `pty:write/resize/signal/kill` take `{ id }` — no binding to compare    |
| `restoreRequired`      | classified as expiry, so a live shell read as gone                      |
| `hasPty`               | `boolean` — an empty inventory could not say "unknown"                  |

The prior redesign failed because it built a _second_ identity system beside
the first instead of fixing the first. It reached +60,903 production LOC and
fixed none of RC1–RC3.

## The rule

**A mutating terminal operation must name the binding it intends to affect, and
the compiler must reject a bare id.**

Not a new subsystem. A type, one comparison, and a signature change.

## 1. `PtyBinding` — one branded type

```ts
declare const bindingBrand: unique symbol

export type PtyBinding = Readonly<{
  hostId: ExecutionHostId // exists — LOCAL_EXECUTION_HOST_ID | ssh:<target>
  worktreeId: WorktreeId // exists — `${repoId}::${path}[::workspace:<uuid>]`
  paneKey: PaneKey // exists — `${tabId}:${leafId}`, already branded
  ptyId: string // exists
  incarnationId: PtyIncarnationId // exists — already branded
}> & { readonly [bindingBrand]: true }
```

Every field already exists and is already persisted. Nothing is invented.

Construction is the whole point: `PtyBinding` is producible **only** by
`bindingFromAuthority()` — reading the durable store, a spawn result, or an
attach reply. There is no public constructor from loose strings, so a caller
cannot fabricate one, and `as PtyBinding` is banned by lint.

## 2. Mutating IPC carries the binding

Today, on the local path:

```ts
pty: write({ id, data })
pty: resize({ id, cols, rows })
pty: signal({ id, signal })
pty: kill({ id })
```

There is no fence to test because there is nothing to compare. That is a
production gap, not a test gap.

After:

```ts
pty: write({ binding, data })
pty: resize({ binding, cols, rows })
pty: signal({ binding, signal })
pty: kill({ binding })
```

The handler resolves the binding against the authoritative record and rejects a
mismatch — the same compare-and-swap `persistPtyBinding` already performs for
`expectedBinding`. A stale renderer cannot reach a successor pane or a reused
PTY id, which is invariants 1–4 of the original design, enforced rather than
asserted.

**Compatibility:** the ID-only channels stay for one release behind the existing
capability negotiation, since clients and hosts update independently. They are
marked deprecated, are not reachable from authoritative paths, and are deleted
in the release after — that deletion is where the LOC comes back.

## 3. One comparison, not twenty-six

```ts
export function bindingsEqual(a: PtyBinding, b: PtyBinding): boolean
export function sameNamespace(a: PtyBinding, b: PtyBinding): boolean
```

Delete the hand-rolled comparisons. `runtimeWorktreeIdsEqual` — the #12474 bug —
is one of them; ~26 repeat a host-id/namespace-id comparison inline. Each
hand-rolled copy is a future drift, and #12474 proves drift already happened.

## 4. Three-valued liveness

Landed (`5369479be29`). `hasPty: boolean | null`, `null` never authorizes
destruction.

## What this deletes

| Target                                                            | Est. LOC |
| ----------------------------------------------------------------- | -------: |
| ID-only IPC channels + handlers (release after next)              |     ~250 |
| Hand-rolled identity comparisons (~26 sites)                      |     ~180 |
| `pty-source-replay-index.ts` (done)                               |      201 |
| Inference sites that exist only because a binding was unavailable |     ~200 |

Net direction is negative once the deprecated channels go. It is net-positive in
the release that adds the type, and the recorded G6 decision permits that when
justified.

## What this deliberately does not build

No durable journal, no per-consumer cumulative cursors, no cryptographic device
principals, no parallel authority service. Verified against mature prior art:
bounded replay plus lifecycle-in-the-attach-reply is what shipping systems use,
and their entire persistent-terminal subsystem is ~6,500 LOC.

If a reviewer can name a concrete event sequence where bounded replay loses or
double-applies an outcome, that conclusion changes. Nobody has yet.

## How each claim gets falsified

| Claim                                    | Oracle                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| A stale op cannot reach a successor pane | Send a captured binding after the pane is recreated; must be refused   |
| A stale op cannot reach a reused pty id  | Same, after incarnation change                                         |
| Same-path workspaces do not collide      | The 5 skipped tests in `workspace-namespace-terminal-identity.test.ts` |
| Reattach never creates                   | Proven, discriminating (`ed10a467883`)                                 |
| Unknown never destroys                   | Revert three-valued `hasPty`; daemon spec reddens                      |

Every row must fail with its guard removed, verified under an isolated
`TMPDIR` — the e2e harness keys its seeded-repo pointer on a machine-global
tmpdir path, so a shared machine can both fabricate and mask a red.

---

# Post-review record (2026-08-08)

## The proposal above was rejected, correctly

Verified against the code, three load-bearing claims in it were false: there is
no `WorktreeId` type; `PtyIncarnationId` is a bare `string` alias, not branded;
and `incarnationId` is optional in the store and never reaches the renderer, so
the side asked to construct the binding cannot. It was also a _second_ identity
comparison beside `resolveStablePaneOwner` (`src/main/ipc/pty.ts:647`), which
already resolves pane ownership against runtime and store and already throws
`terminal_pane_owner_conflict` — with 9 call sites, all on spawn/adopt, none on
a mutating handler. The fence existed; it was not being called.

## What shipped instead

`isSupersededPtyId` in `src/main/ipc/pty.ts`, consulted by `pty:write`,
`pty:writeAccepted`, `pty:resize` and `pty:signal`. Main keeps `ptyPaneKey` and
`paneKeyPtyId` in lock-step, so their disagreement is proof the caller's id was
superseded. No wire change, no renderer change, nothing added to the input
payload. `pty:kill` is deliberately exempt: a superseded PTY is orphaned and
reclaiming it is the point.

## Peer review of that shape

Four comparable agent IDEs were studied. The verdict was to keep this shape.
None sends a composite identity per keystroke; the one that fences keystrokes
sends a single opaque server-minted scalar. The best peer formulation is _keep
the id as the sole lookup key and make the second field a rejection predicate,
never a key component_ — which is what this does, with the owner read from
authority rather than accepted from the caller.

## Known gap, stated precisely

**The fence compares a binding, not an incarnation.** If a pane respawns under
the _same_ ptyId, `paneKeyPtyId.get(paneKey) === ptyId` still holds and a write
composed for the dead shell passes.

The obvious remedy — mint a fresh ptyId on every spawn — is wrong here.
`ptySessionIdForAgentCreateOperation` (`src/main/daemon/pty-session-id.ts:26`)
is deterministic _by design_ so a replayed agent-create is idempotent rather
than spawning a second shell. Randomising it would trade this narrow gap for a
duplicate-spawn bug, which is worse.

So the residual exposure is one path: an agent-create PTY dies, the same
operation is replayed, the id is reproduced, and a caller holding a pre-death
reference writes into the successor. Closing it needs the caller to carry the
incarnation — the rejected proposal — or a per-attachment token, which is a wire
change. Neither is justified by evidence today. Recorded rather than hidden.

## Adopted from the peer review

- The "no binding recorded" branch is an explicit, commented decision (permit),
  not an accident — an omitted guard on an optional field is exactly how one
  peer reintroduced this defect class.
- A classifier's default must be non-destructive: unknown resolves to reattach,
  and only a positive "session not found" authorises a respawn.

## Not yet adopted, ranked

1. Typed end-reason recorded at end time (`detached` vs `terminal-exited`), so a
   user quit is not a resume candidate. Aimed squarely at duplicate resume.
2. Compare-and-swap before any _delayed_ destructive write. Three-valued probes
   stop us acting on unknown; CAS stops us acting on stale-known.
3. Derive the pane inventory from the authority snapshot rather than merging into
   a local store. A projection cannot grow; an accumulator can — which is what
   2 -> 19 -> 20 was.
4. Durable intent-to-kill, since kill is the reclamation path for orphaned leases
   and a one-shot renderer broadcast should not be its only chance.

---

# Duplicate agent resume: why I did not add the fix I recommended

Adoption item 1 was a typed end-reason recorded at end time — `detached` (the
user quit; not a resume candidate) versus `terminal-exited` (it died under the
agent; resumable) — on the grounds that a boolean `ended` cannot express the
difference, which is why systems keep resuming things they should not.

I went to implement it and stopped, because the codebase already contains that
idea three times over.

`SleepingAgentSessionRecord` (`src/shared/agent-session-resume.ts`) carries:

- `origin?: 'worktree-sleep' | 'quit' | 'live'` — added so worktree activation
  would not launch a tab that a warm reattach had already restored (#5232);
- `restoreOnTabOpenOnly?: boolean` — added so a mobile wake would not background
  mount every slept tab and respawn the workspace the user just slept (#11598);
- `automaticResumeBlockedBy?: 'legacy-orchestration-worker'` — added so a
  relaunch could not race a durable orchestration assignment.

Three fields, three incidents, one defect: something resumed that should not
have. They are consulted at 22 non-test sites. A fourth flag — however well
typed — is the fifth containment cycle, which is the failure pattern this
program exists to break.

The peer designs that do not have this bug do not have a better flag. They have
a different shape:

1. **Nothing resumes automatically.** Resume is a button. On click it resumes
   into a _brand-new terminal id_, re-points the pane, then kills the old
   terminal — so two live agents for one pane never exist even transiently.
2. **Two-agents-in-one-terminal is unrepresentable.** The terminal id is the
   agent binding's primary key with a cascade to the session row, and live reads
   inner-join on the session being active — so a dead terminal's agent cannot
   appear in a read no matter how the terminal died.

Neither is a 30-line change here, and (1) is a product decision about whether
automatic resume stays a feature. That belongs to the user, not to me.

What is safe to say: the next duplicate-resume incident should not be answered
with a fourth predicate on this record. The record already proves that approach
does not converge.
