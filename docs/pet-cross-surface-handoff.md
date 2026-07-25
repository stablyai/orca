# Pet Cross-Surface Handoff

## Problem

The pet needs to walk between the desktop, detached panel popouts, and
the phone. The operator picked true handoff (one pet, exclusive) over an
ambient or mirrored phone pet, so exclusivity is the property this arc
exists to guarantee. Several distinct bugs made that property brittle:

- **The pet vanished into limbo for ~30s after a popout close.** A
  surface is normally retired by its renderer calling `removeSurface` on
  unmount, but a *closed* window is torn down before that cleanup runs.
  The authority kept the dead popout as the pet's holder until the
  stale sweep finally evicted it.
- **The pet flickered in and out on the phone.** `holdsPet` was
  oscillating, and `usePetRoam` restarts its loop whenever `enabled`
  flips, so the pet never accumulated any travel.
- **The pet's identity did not survive a surface crossing.** Presence
  carried who holds the pet and where, but never *which* pet, so each
  surface picked its own sprite — `MobilePetOverlay` fell back to
  `Object.keys(FRAMES)[0]`, alphabetically `apupepe`.
- **A popout repainted the operator's pet as the wrong model.** Same
  family as the phone bug: identity failing to survive a surface
  crossing, this time on the desktop rather than the phone.
- **An arriving pet landed at exactly `x = 0` or `x = 1`.** `entryPointFor`
  put a crossing pet on the edge, where the very next frame is a
  re-cross and the flicker returns.

## Goal

- A single process decides who holds the pet. Renderers, popouts, and
  phones are clients, never writers.
- Coordinates are normalized `0..1`, never pixels, so a 2560px desktop
  window and a 1080px phone share the same coordinate space.
- The pet walks off a window edge and appears on the receiving surface
  in the same gesture, with no limbo state and no flicker.
- Identity travels with the pet as the catalogue slug, not a per-install
  UUID, so the same creature draws correctly on the desktop, in a popout,
  and on the phone.
- A clobbered identity self-heals rather than walling the pet in.

## Non-goals

- Mirroring or ambient pet. The pet is exclusive.
- A second writer. The authority is a module-level singleton on purpose
  (see `src/main/pet/pet-presence-authority.ts` header comment).
- Editing upstream's runtime env IPC. The pet is wired through the same
  IPC the renderer already uses; no new channels.
- Replacing the panel-canvas popout code. P5 turns popouts into pet
  surfaces by registering them with the authority; it does not fork the
  popout logic.

## Implementation

The cross-surface handoff arc lands in five phases (P0–P5) plus a
sequence of fixes against the new wiring. Every commit is on
`feat/pet-full-port`.

### P0 — pure handoff state machine — `3e6e3f27`

`src/shared/pet-presence.ts` owns the rules: surfaces, edge geometry,
reconcile, stale eviction (`SURFACE_STALE_AFTER_MS`), normalized
coordinates, exclusivity guards. Deliberately pure — no DOM, no
Electron, no React Native — so the main process and the mobile app run
the identical module and two screens cannot disagree about the rules.
Exclusivity guards covered by tests:

- An exit reported by a surface that does not hold the pet is ignored.
- An `enteredFromEdge` claim that names a different current holder is
  ignored.
- The pet cannot enter its own current holder.
- A `surface` whose `kind` cannot render the current petId is refused
  as a handoff destination (the slug fix in `347e6c0a` made this rule
  non-vacuous).

### P1 — presence authority + RPC — `84e3fc2f`

`src/main/pet/pet-presence-authority.ts` is the single writer. The pet
is exclusive, and that can only be true if exactly one process decides
who holds it. This is a module-level singleton in main on purpose
rather than something hung off the runtime: one main process is one
authority, and making that structural means a second writer cannot be
introduced by accident.

Renderers, popouts, and phones are all clients: they register a
surface, heartbeat it, report edge exits, and read state. None of them
writes position. RPC handlers live next to the authority so the
client-side call sites are short and the writer stays one path.

### P2 — desktop surfaces — `a58f120b`

`src/renderer/src/components/pet/use-pet-presence.ts:181` registers
each **window** (not the app) as a surface, heartbeats it every 8s,
mirrors authority state, and reports edge contact. Two Orca windows
are two destinations, which is the point. Closing a window removes
its surface immediately rather than letting it go stale.

### Roam engine to shared — `436226b2`

`src/shared/pet-roam.ts` (pure) and
`src/renderer/src/components/pet/usePetRoam.ts` (renderer hook) move to `src/shared/`. P3 needs the
phone to roam; two implementations would drift, and a pet that strolls
differently either side of a handoff stops reading as one creature —
so the desktop and the phone must run the same module, not the same
idea. The one comparison that reached through a renderer barrel is
inlined here rather than exporting renderer internals into the mobile
bundle. Metro already watches `src/shared`, so mobile can import
this directly.

### P3+P4 — pet renders and roams on the phone — `7c81855d`

The blocker: `pet.json` ships no frame data. The desktop discovers
frames at runtime by chroma-keying magenta then scanning pixel
rows/columns via canvas `ImageData`. React Native has no canvas, so
that path cannot be ported. The fix is a build-time manifest:
`config/scripts/build-pet-frame-manifest.mjs` bundles
`shared/sprite-frame-detection` and `shared/pet-chroma-key` with
esbuild, decodes each sheet with `@napi-rs/canvas` (already a
dependency), and emits rectangles as JSON. Both surfaces agree by
construction rather than by two implementations happening to match.

### Panel Canvas merge — `533fb2eb2`

Unifies the pet branch and the panels branch so one `orca-serve` can
host both. Until now the desktop ran the panels build (which has no
`pet.*` RPC) while the phone app came from the pet tree, so the pet
could never be granted to a phone — only to a phone-side rerouting
stub.

### P5 — popouts are pet surfaces — `da7d420f`

A detached panel canvas is a real window with real bounds, so it is a
real destination. `usePetPresence` now takes a surface kind, and
`src/renderer/src/components/panel-canvas/PanelCanvasPopoutRoot.tsx`
mounts the overlay as `'popout-window'` rather than letting a popout
masquerade as the main window — which would have made the authority
treat two distinct windows as one surface and lose the pet between
them. Surface ids carry the kind as a prefix so several live surfaces
stay legible in logs.

### Fixes against the new wiring

- **`03360527` — phone surface id must outlive the screen.** The
  authority on node-b had adopted the phone (`surfaceId
  "phone-mrur90ht-5jirsu"`, position at the left edge, `enteredFromEdge
  "left"`) while the phone drew nothing. The surface id is now bound
  to the device install, not the screen mount, so a phone-screen
  recreate does not orphan an adopted pet.
- **`3fc170b9` — a dead surface must not be a handoff destination.**
  Zombie surfaces (registered, never heartbeating) are removed from
  the destination set during reconcile so `holdsPet` stops
  oscillating.
- **`51734a9b` — pet identity travels with the pet.** `petId` now
  lives in `PetPresence`, next to position and ownership, because it
  is the same fact: there is one pet. The desktop owns the
  operator's selection and publishes it; surfaces render it.
- **`347e6c0a` — travelling identity is the catalogue slug.** Caught
  by inspecting live `presence.json` on node-e right after deploying
  the previous commit: the desktop published petId
  `4aa6e196-405f-4cd2-b19e-a832f4b0651f` (a UUID minted at import time)
  while the phone bundles the same creature as `mini-gandalf-the-grey`.
  See [`pet-identity.md`](./pet-identity.md) for the resolver and
  starter-pack context.
- **`b1827a64` — an arriving pet must not land on an edge.**
  `entryPointFor` lands a crossing pet at exactly `x = 0` or `x = 1`,
  which is a coordinate the very next frame would treat as another
  crossing. The arrival is now inset.
- **`f6adc15f` — a clobbered identity must heal itself.** A popout
  store that publishes `claude-the-mage` (Orca's bundled default)
  rather than a phone-known slug would refuse the phone as a
  destination, so `canHandOff` went false and the pet had nowhere to
  go. The no-silent-substitution rule is now paired with a
  self-healing path that re-resolves to the operator's selected slug
  rather than walling the pet in.
- **`dd999f0a` — a popout must not repaint the operator's pet.**
  Same identity family as the phone bug: popout store rehydrates
  with `DEFAULT_PET_ID` because it never received the operator's
  selection. The popout mount path now resolves identity from the
  shared presence state before mounting the overlay.
- **`55505216` — hand off instantly when a popout holding the pet
  closes.** `src/main/pet/pet-surface-ownership.ts` watches each
  registering renderer's `webContents` and on `destroyed` evicts every
  surface it owned immediately — popout close, crash, or reload
  teardown alike — so `reconcileSurfaces` reassigns the pet to the
  preferred live surface at once instead of waiting out the stale
  window. Bookkeeping is Electron-free (plain numeric ids) so the
  eviction is testable without a live IPC layer.

## Verification

- `src/main/pet/pet-presence-authority.test.ts` — exclusivity guards,
  reconcile invariants, stale eviction, webContents-destroyed eviction.
- `src/main/pet/pet-surface-ownership.test.ts` — add/evict/race cases
  for the webContents→surfaces bookkeeping.
- `src/main/pet/pet-identity.test.ts` — slug resolution for the 12
  shipped mesh-defaults, UUID passthrough for missing local
  manifests.
- `src/renderer/src/components/pet/use-pet-presence.test.ts` — surface
  registration, heartbeat, edge reporting on the renderer side.
- `src/renderer/src/components/pet/PetOverlay.identity-reporting.test.tsx`
  — the overlay reports the pet id it actually drew, not what the
  store last published.
- Live `presence.json` reconciliation on node-b after each fix — the
  expected log line is `surfaceId=desktop-… petId=<slug> holdsPet=true`,
  not a UUID.