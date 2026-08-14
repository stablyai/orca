# Terminal session behavior contract

Properties every terminal-session change must preserve. They describe
observable behavior, not mechanism, so a test written against them stays valid
under any implementation.

Oracles for the STA-3077 properties live in
`src/main/ssh-reattach-pane-cardinality.test.ts`.

## Why this exists

Reconnecting an SSH-backed workspace used to add panes the user never opened,
and the remote host accumulated shells nobody was using — one report went from
2 to 19 to 20 relay PTYs across three reconnects. The failures in this class
share one shape: **something absent was treated as something dead**, or a
reattach was allowed to create what it should only have bound.

## A. Unknown is not dead

A disconnect, timeout, absent inventory entry, or failed inspection means
_unresolved_. None of them may terminate a PTY, release a binding, or authorize
cleanup.

**A5** — a timer may never be the _sole cause_ of a destructive action. A timer
that bounds a wait or triggers re-verification is fine; a timer that kills is
not. Retry count never decides identity or liveness.

This is deliberately weaker than "no timers". Recovery budgets and scratch-file
age-gates are correct code and must stay.

Two patterns make a retention bound safe, and both beat shortening it:

- measure **process time**, not wall clock, so a suspended laptop does not
  burn the budget;
- gate aggressive reclamation on an **independent observation** — a second
  consecutive scan, or another client completing a handshake — so the clock
  bounds a wait while evidence authorizes the act.

**B** — respawn requires proof. A failure that does not prove the session is
gone is unresolved: leave the shell running and keep the binding. An
unrecognized failure must never become a respawn, because a duplicated shell
is worse than a stalled one.

## B. Attach binds; it never creates

An ambiguous, unavailable, or rejected attach does not spawn a shell and does
not grow topology — no minted tab, no minted leaf, no split root, no minted
layout. Only an explicit create for a fresh pane may spawn.

Corollary: after a recovery, keystrokes cannot land on a different shell than
the one that was visible before it.

## C. Exact-binding fencing

Mutating operations name the binding captured before the first await and are
rejected when any component no longer matches. A stale operation cannot reach a
later pane generation, a later PTY incarnation reusing the same id, or a
restarted owner. Output and exit arriving under a stale binding are dropped.

The store already enforces this via `persistPtyBinding`'s `expectedBinding`
compare-and-swap and the per-repo topology revision fence.

## D. Cardinality

One pane owns at most one live PTY binding, and one PTY incarnation belongs to
at most one pane. Lease identity must therefore include the pane, not just the
transport id — keying on `(targetId, ptyId)` alone is what let predecessors
accumulate.

Superseding a lease marks it expired; it does not kill the remote process,
because losing a lease is not proof the shell died.

## E. Ordering and loss

Output is delivered in PTY order. A gap is resolved by resnapshot, never by
silently continuing. A correctness-bearing effect (exit, command completion,
review link, bell) is neither lost while the renderer is unmounted nor applied
twice after a replay.

Bounded replay plus idempotent application by event key satisfies this. A
durable per-consumer delivery cursor is not required, and is not currently
used.

**Lifecycle is state, not an event.** An exit that happens while nothing is
attached is not recovered from a delivery channel — it is read during the
attach handshake. The attach reply should carry whether the session is alive
or exited, its exit code, and the resume offset. That is what removes the need
to guarantee delivery of an exit _event_, and it is why no journal is required
here.

Where a resume offset cannot be served, advance the offset explicitly by the
size of the gap and persist the running total, so "output was lost here" stays
a queryable fact rather than a silent discontinuity.

## F. Isolation

A failure on one host cannot affect another host; a failure in one workspace
cannot affect another on the same connection. There is no process-wide failure
fence.

## G. Liveness

Every fail-closed path needs a bounded, user-reachable recovery. A workspace
must never reach a state that permanently refuses terminal operations with no
operator escape — in particular, backpressure from a consumer that is gone
forever must be releasable without that consumer's cooperation.

Unavailable transports retry with bounded backoff and bounded memory.

## H. Compatibility

Clients and hosts update independently. A capability is negotiated or the newer
side degrades; a required operation is never silently dropped. New stream
opcodes must be capability-negotiated, because decoders drop unknown opcodes
silently. Nothing is gated on an app build id.

See [`remote-wire-compatibility.md`](./remote-wire-compatibility.md).

## I. Cost

No new work on the input hot path and none per output frame. Pane create and
close latency must not regress, including over a high-latency SSH link. No
startup-blocking probe of a host nothing has asked for.

---

## Test the call site, not the capability

A guard that exists and is never passed is indistinguishable from no guard.
`mayCreate` was added to `persistPtyBinding`, was correct, and had no
production caller for several commits — every store-level test passed the whole
time, because they called the store directly.

So for anything that refuses a destructive action, pin the **caller**: assert
that the reattach path passes the refusal, not merely that the store honours it
when asked. The same applies to a classifier — assert the branch that consumes
its verdict is reachable, since a guard behind an unreachable `catch` is dead.

## Deliberately not required

A durable event journal, per-consumer cumulative delivery cursors, and
cryptographic device principals are **not** required by any property above.
Each would need to earn its place by being the only way to satisfy one of them.

Principals, in particular, exist only to key cursors: without cursors there is
nothing for them to key.
