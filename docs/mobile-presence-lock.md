# Mobile Presence Lock for Desktop Terminal

Design doc for repurposing the existing "phone-fit" banner into a general
presence-based interaction lock between the desktop renderer and mobile
clients sharing a single PTY.

## Problem

The desktop and mobile clients share full read/write access to the same
underlying PTY. There is no synchronization between desktop's xterm `onData`
(which calls `provider.write(ptyId, bytes)` via the `pty:write` IPC) and
mobile's `terminal.send` RPC (which also calls `provider.write` through the
runtime). When both parties type at the same time, bytes interleave at the
TTY level — `ls<enter>` and `pwd<enter>` typed concurrently can produce
`lpws<enter>d<enter>` and execute unintended commands.

The same is true for resize: desktop `pty:resize` and mobile
`terminal.resizeForClient` both reach `provider.resize(ptyId, ...)` without
coordination. The renderer-side `safeFit` has a partial guard, but the
`pty:resize` IPC handler does not check the override server-side.

A teammate using the original mobile build reported "odd behavior using
laptop + mobile at the same time." The most visible symptom is the desktop
terminal jumping to phone dimensions; the more dangerous symptom is silent
input interleaving.

## Today's banner

The existing banner in `TerminalPane.tsx` is keyed on
`getFitOverrideForPty(ptyId)`:

- It only appears when mobile is in `auto`/`phone` display mode AND a phone
  resize actually happened.
- It says "Terminal resized for phone (W×H)" with a "Restore" button that
  calls `runtime:restoreTerminalFit(ptyId)`.
- That IPC handler sets the display mode to `desktop` and applies the
  display mode, which resizes the PTY back to desktop dims and clears the
  override. The banner unmounts.

In `desktop` display mode (mobile is subscribed but viewing at desktop dims)
there is no override and no banner — the desktop user has no idea mobile is
watching.

## Goal

Repurpose the banner into a general presence-based lock with this single
rule:

> At any moment, each PTY has exactly one *driver* — desktop, a specific
> mobile client, or nobody. While mobile drives, desktop input and resize
> are dropped; the desktop banner explains why and offers **Take back** to
> hand the floor over. While desktop drives, mobile keystrokes silently
> reclaim the floor (no mobile-side banner — see "Asymmetric UX" below).

The lock exists at two layers:

- **Renderer guard** (primary UX): `pty-connection.ts` drops xterm `onData`
  and `onResize` while a mobile client is the driver. Banner explains why.
- **Server-side defense** (defense-in-depth): the `pty:write` and
  `pty:resize` IPC handlers consult the runtime's driver state and drop
  desktop-side calls while a mobile client is the driver.

## Behavioral model

### Driver state machine

Instead of a binary lock, each PTY carries a tagged driver state. There is
exactly one driver per PTY at any moment, and transitions are atomic
(updated and emitted together from the runtime).

```ts
type DriverState =
  | { kind: 'idle' }
  | { kind: 'desktop' }
  | { kind: 'mobile'; clientId: string }
```

- `idle` — no mobile subscribers; desktop input and resize flow through
  normally. (We don't bother distinguishing "no one is here" from "only
  desktop is here" since they behave identically; `idle` is the catch-all
  for "nothing is currently locking the desktop out.")
- `desktop` — at least one mobile client is subscribed but the desktop has
  reclaimed the floor; desktop input and resize flow through.
- `mobile{clientId}` — `clientId` is the mobile actor that most recently
  drove this PTY. The banner is mounted on desktop; desktop input and
  resize are dropped.

Invariants:

- `currentDriver(ptyId)` is always exactly one of the three kinds.
- On the main process, a transition mutates `currentDriver(ptyId)` and
  emits `terminalDriverChanged(ptyId, driver)` in the same critical
  section. The renderer's mirror in `mobile-driver-state.ts` is updated
  only when the IPC arrives — there is a brief IPC-hop window during
  which the renderer's `getDriverForPty(ptyId)` returns a stale value.
  This is why the server-side `pty:write` / `pty:resize` defenses are
  **load-bearing, not redundant**: a desktop keystroke fired during
  that window passes the renderer guard and is dropped by the server
  guard.
- Only one driver per PTY at any moment. Multiple mobile clients can
  *subscribe* simultaneously (see "Multi-mobile subscriber model"), but
  only the most recent mobile actor is the driver.

### Transitions

| Current driver | Trigger | Next driver | Side effect |
|---|---|---|---|
| `idle` | mobile subscribes with `displayMode='auto'\|'phone'` (first client for this ptyId) | `mobile{clientId}` | banner mounts on desktop; PTY resizes to phone dims |
| `idle` | mobile subscribes with `displayMode='desktop'` (first client for this ptyId) | `desktop` | inner subscriber map populated; **no** banner; PTY stays at desktop dims |
| `idle` | desktop input or first PTY data after no subscribers | `idle` (no transition) | — |
| `mobile{A}` | desktop clicks **Take back** | `desktop` | banner unmounts; PTY snaps to desktop dims if at phone dims |
| `mobile{A}` | mobile A sends input/resize/setDisplayMode | `mobile{A}` (no transition) | — |
| `mobile{A}` | mobile B sends input | `mobile{B}` | (no banner change; both are "mobile") |
| `mobile{A}` | last mobile client unsubscribes | `idle` | banner unmounts |
| `desktop` | any mobile client sends input/resize | `mobile{thatClient}` | banner mounts; PTY snaps to phone dims if that client's mode is auto/phone |
| `desktop` | mobile sets `displayMode` to `auto` or `phone` | `mobile{thatClient}` | banner mounts; PTY snaps to phone dims (deliberate "I want to drive" gesture) |
| `desktop` | mobile sets `displayMode` to `desktop` | `desktop` (no transition) | — (already desktop-mode watching) |
| `desktop` | mobile subscribes-fresh with `auto`/`phone` | `mobile{thatClient}` | banner mounts; PTY snaps to phone dims |
| `desktop` | mobile subscribes-fresh with `desktop` | `desktop` (no transition) | inner map updated; no banner |
| `desktop` | last mobile client unsubscribes | `idle` | (banner already unmounted) |

**Subscribe-in-desktop-mode rule.** A mobile client subscribing in
`displayMode='desktop'` is treated as a passive watch, not a take-floor
gesture. The driver stays at `idle`/`desktop`, so the desktop user is not
interrupted. The instant that client (or any peer) sends input, sets the
display mode to `auto`/`phone`, or sends a resize, the runtime transitions
to `mobile{thatClient}` and the banner appears. This matches the rest of
the design: the lock engages on *interaction*, not on *presence*.

The protocol is "first-mover wins until the other party acts." Desktop
clicks Take back, mobile types, desktop types again — banner ping-pongs as
each side acts. The `clientId` carried in `mobile{clientId}` is updated
each time a mobile actor takes the floor; this is the wire channel by
which the runtime knows *which* phone last drove (useful for the
forward-path coordinator described at the bottom of this doc, and for the
multi-mobile semantics described below).

### Take back and PTY dimensions

Take back has two sub-cases:

1. **Mobile was in `phone`/`auto` mode (PTY at phone dims)**. Take back
   resizes PTY back to desktop dims (existing behavior of
   `applyMobileDisplayMode('desktop')` when `wasResizedToPhone` is true).
2. **Mobile was in `desktop` mode (PTY already at desktop dims)**. Take
   back is a pure lock-flag flip; no resize. Today's
   `applyMobileDisplayMode('desktop')` already short-circuits the resize in
   this case.

In the symmetric direction, mobile reclaim:

1. **Mobile is in `phone`/`auto` mode but PTY is at desktop dims** (because
   desktop just clicked Take back): mobile reclaim re-applies the phone
   resize via `applyMobileDisplayMode(currentMode)`.
2. **Mobile is in `desktop` mode**: pure lock-flag flip; no resize.

## End-user UX

| Driver | Banner (desktop) | Desktop input | Desktop resize |
|---|---|---|---|
| `idle` | hidden | allowed | allowed |
| `mobile{*}` | "🔒 Mobile is driving this terminal — your input is paused. Click **Take back** to resume." | blocked at xterm.onData (silent drop) | blocked in renderer + dropped in `pty:resize` IPC server-side |
| `desktop` | hidden | allowed | allowed |

Walkthroughs:

**Phone connects while you're typing.** Banner pops in. PTY may resize to
phone dims (existing). Your next keystroke is dropped. Click Take back to
unlock and (if needed) restore desktop dims.

**You click Take back.** Banner gone. You type freely. Mobile stays
connected; mobile sees the desktop-sized terminal because PTY snapped back
(or stayed at desktop dims if mobile was in desktop mode).

**Mobile types something while you're reclaimed.** Banner reappears. Your
next keystroke is blocked. PTY may snap back to phone dims (if mobile is in
auto/phone mode).

**Mobile disconnects.** Banner gone permanently. Driver returns to `idle`.

**Multiple panes.** Driver state is per-pane. Phone on pane A doesn't
affect pane B.

**Text selection / scrollback / copy.** Always allowed. The lock is
keystroke and resize only.

**Output continues to render.** While the banner is mounted, terminal
output streams to xterm normally — it is the mobile actor's bytes you
are seeing. Only desktop-side keystrokes and resize are dropped. This
matters because "your input is paused" can read ambiguously; output
flow is unaffected.

## Asymmetric UX (accepted tradeoff)

Mobile sees no banner in this PR. The mobile UI is visually unchanged: no
"Desktop is driving" indicator, no analog to the Take back affordance.
This is asymmetric and we are accepting it deliberately:

- **Smaller mobile UI surface.** Mobile already has limited screen real
  estate and a constrained component set; introducing a presence banner
  there is a non-trivial design + i18n + dismissibility task that we want
  to defer until the lock model has settled in production.
- **Faster ship.** Driver state machine + multi-mobile subscriber fix +
  desktop banner is the smallest change that fixes the dangerous collision
  (silent input interleaving). Adding a mobile-side banner doubles the UI
  scope.
- **Mobile reclaim is naturally signaled.** When a mobile user types
  while desktop drives, the runtime flips the driver to
  `mobile{thatClient}`, the desktop banner remounts, and (if mobile is in
  auto/phone mode) the PTY snaps back to phone dims. The mobile user sees
  the pane reflow and their keystrokes appear in the output stream. There
  is no silent black-hole condition on mobile that a banner would
  resolve.
- **Mobile keystrokes always reclaim implicitly.** The protocol on mobile
  is "just type to take the floor." There is no mobile-side button to
  surface; a banner with no actionable control is closer to noise than
  signal.

The flip side: a mobile user typing into a stale view *won't* be told
"hold on, desktop is driving" before their keystroke lands. They just take
the floor. We consider that acceptable because (a) they're explicitly
acting, and (b) the desktop user gets the warning side of the tradeoff
where the risk of unintended action is much higher.

If usage data later shows mobile users frequently being surprised by
desktop activity, a mobile banner can be added without changing the wire
format — `terminalDriverChanged(ptyId, driver)` already carries everything
needed.

## Architecture

### Where the truth lives

The `mobileSubscribers` map (re-keyed; see "Multi-mobile subscriber model"
below) plus a new `currentDriver: Map<ptyId, DriverState>` on the runtime
are the source of truth. The renderer learns the driver state via a new
IPC event `terminal-driver-changed(ptyId, driver: DriverState)` emitted
from the runtime through the existing notifier path. The structured
payload is intentional: a binary `locked: boolean` would lose the
`clientId` we need for multi-mobile semantics today and for the unified
write coordinator on the forward path.

The runtime exposes `getDriver(ptyId): DriverState`, replacing the old
`isLocked(ptyId): boolean`. Server-side `pty:write` / `pty:resize`
defenses check `runtime.getDriver(ptyId).kind === 'mobile'` to drop
desktop-side calls.

A new renderer module `mobile-driver-state.ts` mirrors
`mobile-fit-overrides.ts`: keyed by ptyId, supports
`getDriverForPty(ptyId): DriverState` and a subscribe-style change
listener. The `TerminalPane` banner mounts when
`getDriverForPty(ptyId).kind === 'mobile'`, and `pty-connection`'s
`onData`/`onResize` guards drop input/resize under the same predicate.

### Why not reuse `getFitOverrideForPty`?

The fit override only fires when the PTY was actually resized
(`mode='auto'|'phone'` and `wasResizedToPhone=true`). It misses the
desktop-mode case where mobile is subscribed but no resize happened. The
driver state is broader than the fit override.

### Why a new IPC event vs extending `terminal-fit-override-changed`?

Cleaner separation. The fit override is about dimensions; the driver
state is about ownership. They happen to overlap in the auto/phone
subcase, but conflating them long-term ties future work on either to the
other.

### Why a structured payload vs `locked: boolean`?

The runtime needs to know *which* mobile client most recently drove (for
multi-mobile semantics today and for the future write coordinator). A
structured `DriverState` payload makes that information first-class on
the wire instead of smuggling it through a side channel. The cost is ~70
LoC over a binary lock; the payoff is a symmetric UX foundation and a
future-proof wire format.

## Multi-mobile subscriber model

The `mobileSubscribers` map is today shaped `Map<ptyId, Subscriber>` and
each `terminal.subscribe` call overwrites the previous subscriber for that
ptyId. That overwrite is fine for a binary `has(ptyId)` presence check but
breaks the moment we treat presence as a real set: phone B subscribing
silently evicts phone A, so phone A unsubscribing or its WS dropping looks
like "no mobile clients" even while phone B is still on the line. The
driver state machine sits directly on top of presence, so soundness here
is a prerequisite, not a polish.

We rekey to `Map<ptyId, Map<clientId, Subscriber>>` and update each
callsite:

- **`handleMobileSubscribe(ptyId, clientId, subscriber)`** — get-or-create
  the inner map, then `inner.set(clientId, subscriber)`. Do not overwrite
  peer clients. If the inner map was empty before insert, this is the
  first subscriber for the PTY; emit the `idle → mobile{clientId}` driver
  transition.
- **`handleMobileUnsubscribe(ptyId, clientId)`** — `inner.delete(clientId)`,
  then if the inner map is now empty, delete the outer entry, run the
  existing restore-resize logic, and emit the `* → idle` driver
  transition. If the inner map is non-empty, do **not** fire restore /
  driver-change; peers still have the floor.
- **`applyMobileDisplayMode(ptyId)`** — iterate the inner map. The
  restore-resize semantics need a single representative subscriber (the
  desktop dims to restore *to* are stored on the subscriber record). Pick
  the earliest by subscribe time so the restore target is stable as
  later phones come and go. The display mode itself is per-PTY runtime
  state, not per-client.

  **Active phone-fit dim selection (multi-mobile).** When two or more
  mobile clients subscribe with different viewports (e.g., iPhone +
  iPad), the PTY can only be at one phone-fit size at a time. Rule:
  **the most recent mobile actor's viewport wins**. This matches the
  driver state machine — whoever last took the floor (`mobile{X}`)
  also dictates the active phone-fit dims. When that client
  unsubscribes, the next-most-recent surviving subscriber's viewport
  wins; on the last client leaving, the inner map empties and we run
  the existing restore back to the earliest-recorded desktop dims. We
  do not use `min(cols, rows)` across subscribers because that
  produces no clear principal — multiple TUIs are forced to render
  for an aggregate viewport that nobody actually has, which is worse
  than picking a single owner. Most-recent-actor is consistent with
  the rest of the protocol (whoever acted last has the floor) and is
  cheap to reason about.

  **Subscriber record extension.** "Most-recent actor" and
  "earliest-by-subscribe-time" both require timestamps that today's
  Subscriber record does not carry. Extend it with two fields:

  ```ts
  interface Subscriber {
    clientId: string
    viewport: { cols: number; rows: number }
    wasResizedToPhone: boolean
    previousCols: number | null
    previousRows: number | null
    subscribedAt: number  // ms since epoch, set on insert
    lastActedAt: number   // ms since epoch, init = subscribedAt;
                          // updated on every mobileTookFloor for this client
  }
  ```

  - `applyMobileDisplayMode(ptyId)` for active phone-fit dims:
    iterate the inner map, pick `argmax(lastActedAt)`, use that
    subscriber's `viewport`.
  - For restore-to-desktop semantics on last-client-leaves: pick
    `argmin(subscribedAt)` **among subscribers with non-null
    `previousCols`/`previousRows`** and use that subscriber's
    `previousCols/Rows` as the restore target. Desktop-mode
    subscribers carry `previousCols/Rows = null` by design (the
    existing `handleMobileSubscribe` short-circuits dim capture for
    desktop-mode joins to avoid capturing a stale full-width size),
    so they are not viable restore targets. If no surviving
    subscriber has captured dims, fall back to
    `lastRendererSizes.get(ptyId)` (the desktop renderer's most
    recent reported size) — same fallback the existing first-insert
    capture path uses.

  Both operations are O(n) over the inner map, which is bounded by
  the number of concurrently subscribed mobile clients (typically 1,
  rarely 2-3). No indexing needed.
- **`isMobileSubscriberActive(ptyId)`** — returns `true` iff the inner map
  is non-empty.
- **Driver state for the mobile side** stores the `clientId` of the most
  recent mobile actor. Whenever any mobile client sends
  input/resize/setDisplayMode/subscribes-fresh, that client becomes the
  `currentDriver` (`mobile{thatClient}`). Phone B taking over from phone A
  is an internal mobile→mobile transition: no banner change, but the
  recorded `clientId` updates so the runtime always knows who is the
  authoritative mobile actor.

The semantic upshot is that the desktop banner is governed by "is the
inner map non-empty AND has the desktop not reclaimed?" rather than the
old single-slot heuristic, and Take back / mobile-reclaim correctly
ping-pong even when two phones are on the same PTY.

## Implementation

Files touched:

1. `src/main/runtime/orca-runtime.ts` — rekey `mobileSubscribers` to
   `Map<ptyId, Map<clientId, Subscriber>>`, add `currentDriver` map,
   `getDriver(ptyId)` getter, transition methods, notifier hook. Update
   `handleMobileSubscribe` / `handleMobileUnsubscribe` /
   `applyMobileDisplayMode` / `isMobileSubscriberActive` per the
   multi-mobile model above. **Extend `onPtyExit` cleanup** to
   `currentDriver.delete(ptyId)` and emit `terminalDriverChanged(ptyId,
   { kind: 'idle' })` so any banner mounted on the dead pane unmounts.
   Without this, a dead PTY's last driver state lingers and the
   renderer banner could persist on a dead pane until tab teardown.
2. `src/main/runtime/orca-runtime.ts` interface `RuntimeNotifier` — add
   `terminalDriverChanged(ptyId, driver: DriverState)`.
3. `src/main/window-manager.ts` (or wherever `RuntimeNotifier` is wired) —
   forward to renderer via `webContents.send('terminal-driver-changed', …)`.
4. `src/preload/index.ts` + `src/preload/api-types.ts` — expose the new
   event with the structured `DriverState` payload.
5. `src/main/ipc/runtime.ts` — add `runtime:reclaimTerminal` IPC (or
   extend `runtime:restoreTerminalFit`) which drives the
   `mobile{*} → desktop` transition.
6. `src/main/runtime/rpc/methods/terminal.ts` — drive the
   `* → mobile{clientId}` transition in `terminal.send`,
   `terminal.resizeForClient`, `terminal.setDisplayMode`, and the
   subscribe handler (with the subscribe-in-desktop-mode exception
   above).

   **Wire-format changes required.** The driver state machine tags
   the active mobile actor with `clientId`, so every mobile RPC method
   that can take the floor must carry the caller's identity. Today
   only `terminal.subscribe` and `terminal.resizeForClient` do; we
   extend the others.

   **Canonical identity shape.** Use the existing
   `terminal.subscribe` shape: `client: { id: string; type: 'mobile'
   \| 'desktop' }` (with `type` optional). `TerminalResizeForClient`
   keeps its grandfathered top-level `clientId: string` field for
   backward compatibility — implementers may add an aliased nested
   `client.id` setter for consistency at the call site, but the wire
   shape is preserved.

   New fields on existing schemas:

   - `TerminalSend` gains `client: { id: string; type?: 'mobile' \|
     'desktop' }` (optional for backward compatibility — falls back
     to "the most recent mobile actor" when absent).
   - `TerminalSetDisplayMode` gains the same `client` field.
   - `TerminalUnsubscribe` gains `client: { id: string }` so the
     server can derive the composite cleanup key (see below); the
     existing `subscriptionId` field is kept and remains the primary
     lookup, with `client.id` used only when the caller passed a
     bare-handle `subscriptionId`.

   **Subscribe-side composite key.** Change `subscriptionId` from
   `params.terminal` to `${params.terminal}:${params.client.id}` so
   two phones subscribing to the same terminal handle do not evict
   each other via `registerSubscriptionCleanup`. Without this fix,
   the multi-mobile rekey to `Map<ptyId, Map<clientId, Subscriber>>`
   would be silently defeated at the RPC subscription layer (phone
   B's subscribe runs phone A's cleanup → A's data listener tears
   down → A's `handleMobileUnsubscribe` fires).

   **Unsubscribe-side composite key.** The mobile RPC client today
   emits `terminal.unsubscribe` with `params: { subscriptionId:
   stream.params.terminal }` — the bare handle. With the subscribe
   side now keying by composite, a bare-handle unsubscribe will miss
   in `subscriptionCleanups.get(bareHandle)` and silently no-op,
   leaking the data listener and leaving `mobileSubscribers`
   populated forever (banner stuck, driver never returns to `idle`).
   Fix: the mobile RPC client emits `{ subscriptionId:
   ${terminal}:${clientId}, client: { id: clientId } }`, and the
   server's `cleanupSubscription` uses whichever the caller sent —
   if both `subscriptionId` and `client.id` are present and the
   caller passed only `terminal` in `subscriptionId`, the server
   reconstructs the composite key from `client.id`. Belt-and-braces
   so a stale older mobile build still cleans up correctly.

   This is a coordinated client/server wire-format change. The
   mobile app must ship in lockstep; if a stale mobile client emits
   bare-handle unsubscribe to a new server, the server's
   reconstruction path catches it. If a new mobile client emits
   composite-handle unsubscribe to a stale server, the stale server
   ignores `client.id` and the composite key fails to match — but
   that direction is moot because the stale server has not adopted
   composite keys on subscribe either. No client newer than server,
   so this is safe.
7. `src/main/ipc/pty.ts` — defense in depth: drop `pty:write` and
   `pty:resize` calls when
   `runtime.getDriver(id).kind === 'mobile'`. **Preserve the existing
   `runtime.isResizeSuppressed()` short-circuit at the top of the
   `pty:resize` handler** — the new driver-state guard is *in
   addition to*, not in place of, the suppression window. The two
   guards have different purposes: `isResizeSuppressed()` blocks the
   safeFit cascade after a take-back transition (preventing
   collateral resize corruption of background panes), while the
   driver-state check blocks desktop-side resizes whenever mobile is
   driving. Both must apply.
8. `src/renderer/src/lib/pane-manager/mobile-driver-state.ts` — new
   renderer store mirroring `mobile-fit-overrides.ts`. Exposes
   `getDriverForPty(ptyId): DriverState` and a change listener.
9. `src/renderer/src/components/terminal-pane/pty-connection.ts` — guard
   `onData` and `onResize` on
   `getDriverForPty(ptyId).kind === 'mobile'`.
10. `src/renderer/src/components/terminal-pane/TerminalPane.tsx` — switch
    banner to consume driver state, update copy, rename Restore → Take
    back.

### Server-side detail

```ts
// orca-runtime.ts
private currentDriver = new Map<string, DriverState>()

getDriver(ptyId: string): DriverState {
  return this.currentDriver.get(ptyId) ?? { kind: 'idle' }
}

private setDriver(ptyId: string, next: DriverState): void {
  this.currentDriver.set(ptyId, next)
  this.notifier?.terminalDriverChanged(ptyId, next)
}

reclaimTerminalForDesktop(ptyId: string): void {
  if (!this.isMobileSubscriberActive(ptyId)) return
  // Snap PTY back to desktop dims if currently at phone dims.
  // applyMobileDisplayMode is a no-op resize when already at desktop dims.
  this.setMobileDisplayMode(ptyId, 'desktop')
  this.applyMobileDisplayMode(ptyId)
  this.setDriver(ptyId, { kind: 'desktop' })
}

private mobileTookFloor(ptyId: string, clientId: string): void {
  // If mobile is in phone/auto mode, re-apply phone resize on the first
  // hand-off back from desktop. Mobile-to-mobile hand-offs are no-ops
  // for resize.
  const prev = this.getDriver(ptyId)
  if (prev.kind === 'desktop') this.applyMobileDisplayMode(ptyId)
  this.setDriver(ptyId, { kind: 'mobile', clientId })
}

handleMobileUnsubscribe(ptyId: string, clientId: string) {
  const inner = this.mobileSubscribers.get(ptyId)
  if (!inner) return
  inner.delete(clientId)
  if (inner.size > 0) return  // peer mobile clients still drive
  this.mobileSubscribers.delete(ptyId)
  // Drive transition fires synchronously so the desktop banner
  // unmounts immediately. The PTY restore runs inside the existing
  // 300ms pendingRestoreTimers debounce — see "Restore-debounce
  // window" under Edge cases.
  this.setDriver(ptyId, { kind: 'idle' })
  // Existing restore-resize logic (300ms debounced timer) runs here.
}
```

The mobile-took-floor path is invoked from the RPC method handlers (not
from `sendTerminal` directly) so that the driver flip is bound to
deliberate mobile actions, not to internal runtime calls.

### Renderer guards

```ts
// pty-connection.ts onData
if (currentPtyId && getDriverForPty(currentPtyId).kind === 'mobile') {
  return  // Mobile is driving this PTY; banner explains.
}
// existing transport.sendInput(data)

// pty-connection.ts onResize
// Why: keep both predicates. getFitOverrideForPty fires synchronously
// in the renderer the moment safeFit runs; getDriverForPty arrives via
// IPC and lags by one round-trip. Removing the fit-override predicate
// would re-introduce the resize-over-mobile-fit bug mobile-fit-overrides
// was added to prevent.
if (
  currentPtyId &&
  (getFitOverrideForPty(currentPtyId) ||
    getDriverForPty(currentPtyId).kind === 'mobile')
) {
  return
}
```

### Banner copy

```
🔒 Mobile is driving this terminal — your input is paused. [ Take back ]
```

When PTY is at phone dims, append the dim suffix:
```
🔒 Mobile is driving this terminal (80×24) — your input is paused. [ Take back ]
```

The phrasing makes Take back the discoverable resolution. There is no
auto-unlock-on-WS-silence and no liveness probing; the banner stays up
until the desktop user takes back, until mobile actor sends input (which
keeps mobile as driver), or until the last mobile subscriber disconnects.

## Edge cases

- **Mobile drops network**. WS doesn't immediately know. The inner
  subscriber map retains the entry for ~30s until ping timeout. Banner
  stays. Take back still works during this window — it transitions to
  `desktop` immediately. When mobile eventually reconnects with
  `terminal.subscribe`, that client takes the floor again
  (`desktop → mobile{thatClient}`).
- **Two phones on same PTY**. The inner map carries both subscribers.
  Driver state is `mobile{whicheverActedLast}`. Phone A unsubscribing
  while phone B is still on does *not* drop the banner; only the last
  client leaving the inner map transitions to `idle`.
- **Pre-locked input in flight**. `transport.sendInput` is
  fire-and-forget; there is no in-flight queue to drain. The first
  dropped keystroke is on the renderer side, which is good enough.
- **Take back while phone is offline**. Works (transitions to `desktop`).
  When phone reconnects with a fresh subscribe, driver flips to
  `mobile{thatClient}`.
- **Display mode toggle from mobile**. `terminal.setDisplayMode` is
  treated as mobile interaction → that client takes the floor. Aligns
  with "any deliberate mobile action takes the floor."
- **Subscribe from a fresh client (reconnect with new clientId)**. The
  subscribe path runs the `desktop → mobile{thatClient}` (or
  `idle → mobile{thatClient}`) transition. A mobile reconnect takes back
  the floor from desktop — correct semantic since the user actively
  reopened the mobile view.
- **Restore-debounce window on last-subscriber-leaves**. When the
  last mobile subscriber unsubscribes, the driver transitions to
  `idle` synchronously (banner unmounts immediately on desktop), but
  the PTY-dim restore runs inside the existing 300ms
  `pendingRestoreTimers` debounce. For up to 300ms after the banner
  unmounts, the PTY remains at phone dims while desktop input flows
  through. Desktop typing into a still-squished terminal is a brief
  visual mismatch, not a correctness bug — the existing debounce is
  there to absorb rapid tab switches without thrashing PTY size, and
  emitting `idle` synchronously preserves that behavior. Do not
  reorder these (driver-emit-first, then debounced restore) without
  re-introducing thrash.

## Tests

- `orca-runtime.test.ts` (driver state machine):
  - Every transition row in the table above has a unit test asserting
    `(prev, trigger) → (next, side effect, emitted event payload)`.
  - `getDriver` defaults to `{ kind: 'idle' }` for unknown ptyIds.
  - `terminalDriverChanged` is emitted exactly once per state change and
    carries the structured `DriverState` payload (not a boolean).
- `orca-runtime.test.ts` (multi-mobile subscriber sequencing):
  - Phone A subscribes (`auto`) → driver is `mobile{A}`, banner emit
    fires.
  - Phone A subscribes (`desktop`) from `idle` → driver stays `desktop`
    (subscribe-in-desktop-mode does not take the floor); inner map
    has A.
  - Phone B subscribes (`auto`) while A is still on (`auto`) → driver
    flips to `mobile{B}` (subscribe-fresh-with-auto/phone counts as
    take-floor); inner map has both subscribers; active phone-fit
    dims switch to B's viewport.
  - Phone B unsubscribes while A is still on → driver remains mobile;
    active phone-fit dims revert to A's viewport (next-most-recent
    actor); banner stays up; no `idle` transition.
  - Phone A unsubscribes (last client leaves) → driver transitions to
    `idle`, banner unmounts, PTY restores to earliest-recorded
    desktop dims.
  - `applyMobileDisplayMode` picks the **most-recent-actor's**
    viewport for active phone-fit dims and the
    **earliest-by-subscribe-time** desktop dims for restore.
  - Mobile sets `displayMode` to `desktop` from `mobile{*}` does *not*
    transition to `desktop` automatically (existing setDisplayMode
    semantics stand) — but the runtime's *driver* transition rule for
    `desktop → desktop` (mode change to desktop while already in
    desktop driver) is a no-op.
- `terminal.test.ts` (subscriptionId per-client keying):
  - Phone A subscribes to terminal handle `T`, phone B subscribes to
    the same handle `T` → A's data listener still receives bytes
    after B's subscribe (subscriptionId is `${T}:${clientId}` so
    `registerSubscriptionCleanup` does not collide).
  - Regression: prior to the fix, the second subscribe ran the first
    subscribe's cleanup and tore down phone A's stream.
- `pty-connection.test.ts`:
  - `onData` is dropped while `getDriverForPty(id).kind === 'mobile'`.
  - `onData` is delivered when driver flips to `desktop` or `idle`.
  - `onResize` is dropped while driver is `mobile`.
- `pty.test.ts` (or new `pty-driver-state.test.ts`):
  - `pty:write` IPC is dropped when `runtime.getDriver(id).kind ===
    'mobile'`.
  - `pty:resize` IPC is dropped under the same predicate.

## Out of scope

- Mobile yanking desktop tab focus via `terminal.focus`.
- Cold-restore ack from mobile-only attach.
- Mobile-side "Desktop is driving" banner (see "Asymmetric UX" above).

These are independent collisions tracked separately.

## Forward path

The natural next step (not in this PR) is unifying both writers — the
desktop renderer's `pty:write` IPC and the mobile RPC's `terminal.send`
— into a single coordinator that queues bytes through a runtime-owned
write path. The driver state machine cleanly supports this: the
coordinator can use `currentDriver(ptyId)` as the admission predicate
(only the current driver's bytes are dequeued), and the
`mobile{clientId}` payload tells it which queue head to drain when a
specific phone is the active actor. Today's PR keeps two independent
write paths and uses driver state purely as a drop-filter; the same
state machine becomes the scheduling input on the forward path without
a wire-format change.

## Rollout

Single PR. No feature flag needed; behavior is strictly additive (locks
an existing collision surface) and the existing banner UX continues to
work under the new driver-state model with sharper copy.
