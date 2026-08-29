# SSH reconnect: why the pane retry gets a byte tail, and what would actually change it

Status: investigation result. The obvious follow-up to PR #14844 was traced and **rejected**, and
tracing it turned up the actual root cause: checkpointed source recovery has never run on an SSH
reconnect. Both are recorded here — the rejected shape so nobody re-proposes it, and the verified
cause with the fix it implies.

## The shape of the problem

A reconnect remounts the pane (`tab.generation` is its React key), so the xterm is disposed with its
buffer and something must repaint it. Today that is a **byte tail**: `reattachSshPtySession` sends
`requireReplay: true` and the relay returns `RecentPtyOutputBuffer.read()` — the last 100KB, read
non-destructively, with no notion of what this client already consumed.

Two costs follow. Main's `@xterm/headless` model never sees those bytes (the tail bypasses
`onPtyData`), so it is stale by exactly the outage — which is what forces
`sshReconnectPaintsFromModel` to restrict the grid repaint to the alternate screen. And a shell loses
outage output past 100KB permanently.

## The proposal that does not work

"Make the pane-retry path request source recovery like `reattachKnownPtys` does." Mechanically this
is trivial — `sourceRecovery` is already an optional `pty.attach` param the relay parses, Path C
already calls the same `requestSshPtyAttach` helper and already parses the response field. The
required checkpoint state also survives a transport drop, in the module-level `recoveryByTarget` map
(`ssh-pty-consumer-recovery.ts:17`), reachable from `connectionId` because `connectionId === targetId`.

It still fails, three ways:

1. **The relay answers `'existing'` before it looks at the recovery argument.**
   `relay-pty-source-publication.ts:99-109` short-circuits on a same-`clientId` attach, and a
   reconnected client presents the same id — see the root-cause section below, where this turns out
   to be the whole story rather than an obstacle specific to this proposal.
2. **A failed `reattachKnownPtys` deletes the checkpoint on purpose** (`ssh-relay-session.ts:3006-3007`)
   and detaches the lease (`:3008`). The pane retry runs _after_ that, so it would present
   `checkpointUnavailable`, which the relay converts to `restoreRequired`
   (`relay-pty-source-publication.ts:124-130`) and the provider converts to
   `SSH_SESSION_EXPIRED_ERROR` (`ssh-pty-provider.ts:103-107`). We would trade a blank-pane-with-tail
   for a **killed session**.
3. **Wrong payload shape.** Recovery replays only the post-checkpoint delta
   `(acceptedSourceEndSu → receivedEndSu]`. The byte tail is a screen snapshot for a _fresh, empty_
   xterm. Even a successful recovery returns roughly nothing in the common case, and the pane stays
   blank.

These two mechanisms answer different questions. Recovery keeps main's model whole; the tail repaints
a new terminal. Substituting one for the other is a category error.

## A correction worth recording

The motivating argument was "`requireReplay` is optional, so older relays ignore it and still show
blank panes." **That is wrong for the SSH relay.** The client deploys and launches its own relay
build into a version-scoped directory (`ssh-relay-deploy.ts:231`, `:594`), and `validateGrant`
rejects any grant whose `serverBuildId` differs from the expected one
(`ssh-pty-consumer-session.ts:58-65`, rationale in-code: _"client and relay ship in one build"_).
Client and SSH relay are version-locked; mixed versions do not occur on this channel. The
independent-update rule in `remote-wire-compatibility.md` still governs remote _runtime_ hosts — just
not this one.

So there is no old-host population to rescue, and the urgency that argument created was false.

## ANSWERED: checkpointed recovery never runs on an SSH reconnect

The question above was "does the reconnecting client present a new `clientId`?" It does not, and the
consequence is that the whole checkpoint mechanism is dead on this path. Every link verified:

1. **The client keeps its id.** A reconnect calls `Dispatcher.setWrite`
   (`src/relay/dispatcher.ts:149-157`), which reuses `this.primaryClient` — including its `id` — and
   replaces only the writer. The dispatcher refuses to detach the primary. This is already stated
   in-repo at `src/relay/pty-handler.ts:1736-1742`.
2. **So `activate()` short-circuits.** `relay-pty-source-publication.ts:99` tests
   `current?.clientId === context.clientId` and returns `'existing'` at `:108`. The `rotateDelivery`
   recovery path at `:118-142` is reachable **only** when the ids differ — i.e. never, here.
3. **So the relay returns no `sourceRecovery`.**
4. **So the client abandons.** `finishSourceRecovery` (`ssh-relay-session.ts:2766-2785`) fails its
   `!pendingRecovery` guard, calls `abandonPtySourceRecovery`, and returns false — which cancels the
   delivery and deletes the checkpoint (`:3006-3008`).
5. **So the pane retry opens fresh and gets the byte tail**, via the `requireReplay` fix.

The byte tail is therefore not a fallback. It is the only path that has ever run for an SSH
reconnect, and the flow-control/checkpoint machinery is inert on this path.

That also explains the original blank-pane bug exactly: the relay concluded "this client already
holds the stream" because, by its own identity rule, it does.

### The fix this implies

Give a reconnected primary a distinguishable identity — a transport generation on the client record,
bumped in `setWrite` — and have `activate()` compare it alongside `clientId`, so a reconnect takes
`rotateDelivery` instead of `'existing'`.

Why this is the tractable shape:

- **No wire change.** `RequestContext`, `setWrite` and the publication are all relay-internal.
- **No compatibility exposure.** Client and relay ship in one build and are version-locked.
- **It does not disturb the invariant that broke three earlier attempts.** Deliveries still outlive
  their clients; nothing retires on `onClientDetached`. The delivery is _rotated on re-attach_,
  which is what the recovery design already intends and what its tests already cover.

**UNVERIFIED and to be checked before implementing:** that `rotateDelivery`'s preconditions hold at
that moment (the checkpoint's `deliveryToken`, `clientGeneration`, `ownerGeneration` and
`ptyIncarnation` must match the live identity, `:124-128`); that `outputFlowControl` is granted on
the reconnected session; and what a rotation implies for the _renderer_, which still remounts with an
empty xterm and needs a screen, not a post-checkpoint delta. Recovery keeps main's model whole — it
does not by itself repaint a fresh terminal, so the tail may still be wanted for the pane even once
the model stops going stale.

## Do not start at `onClientDetached`

Three attempts failed there, each plausible until run:

- Retiring the delivery on `dispatcher.onClientDetached` **breaks checkpoint recovery** (10 tests).
  A delivery outliving its client is deliberate — it is what lets a client resume from a checkpoint.
- Retiring without `session.cancelDelivery()` orphans the credit ledger's one-upstream-owner slot;
  the next open throws `PTY source delivery already has an upstream owner`. Seen live as a toast and
  a blank pane.
- Comparing `record.identity.clientGeneration` to the request is impossible: that value is
  client-supplied via `pty.openClient`, and `RequestContext` carries no generation of its own.

## The lead that survives

`reattachRejectedPty` (`ssh-relay-session.ts:1957-2004`) is an existing **single-PTY** entry point
into the `reattachKnownPtys` machinery, taking `(relayPtyId, mux, providerGeneration, mode)` and
driving recovery with `targetedDeliveryRecovery`. If per-pane recovery is wanted, that is the hook —
and it does not involve the pane-retry path at all. Unverified whether it is reachable at the moment
the renderer retries.

## Preconditions, unchanged

The SSH e2e lane must be green and triggering on **source** changes before any of this is attempted.
It was skipping for 15 specs; four regressions reached a user during that window.

## Open: the pane behind a preserved tab does not always rebind

The merge now keeps a local tab the host has never been told about, so the tab and its title survive
a reconnect. The reattach behind it does not, reliably — measured at three runs in four against the
Docker-SSH lane. When it misses, the store holds the tab, the tab bar renders it, and the pane never
rebinds: the "frozen tab" shape the original report described, one layer down from the deletion that
used to cause it.

Deliberately NOT asserted in `ssh-reconnect-tab-destruction.spec.ts`. A one-in-four flake in the lane
that exists to catch this class costs more than it proves — the lane stops being trusted, which is
exactly how the earlier silent-skip failure happened. Tab survival is asserted there and is
deterministic; the liveness gap is recorded here instead.

Worth checking first, since it is the same shape as everything else in this file: the tab is absent
from the host snapshot, so whatever drives the per-tab reattach after an apply may simply not know to
reattach a tab the snapshot never mentioned.
