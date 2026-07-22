# Pet Identity

## Problem

The pet's identity has to survive every surface crossing it can
experience: a desktop rerender, a popout adoption, a handoff to the
phone, a return. The fork hit four distinct identity bugs before the
shape was stable:

- **The phone drew the wrong pet.** The desktop publishes which pet the
  operator selected; the phone just rendered. But presence carried who
  holds the pet and where, never *which* pet — so `MobilePetOverlay`
  fell back to `Object.keys(FRAMES)[0]`, alphabetically `apupepe`.
  Two unrelated pets were taking turns being visible.
- **The slug did not match.** The desktop published petId
  `4aa6e196-405f-4cd2-b19e-a832f4b0651f`, an import-time UUID; the
  phone bundles the same creature as `mini-gandalf-the-grey`. The phone
  declares what it can draw and refuses a surface that cannot draw the
  current pet, so the handoff stopped crossing.
- **A clobbered identity walled the pet in.** A popout store that
  published `claude-the-mage` (Orca's bundled default) rather than a
  phone-known slug would refuse the phone as a destination, so
  `canHandOff` went false. The pet had nowhere to go.
- **The popout repainted the operator's pet as the wrong model.** Same
  family as the phone bug — popout store rehydrated with
  `DEFAULT_PET_ID` because it never received the operator's selection.

## Goal

- The pet has one name that travels with it across every surface.
- That name is the catalogue slug, not a per-install UUID.
- A clobbered identity self-heals so the pet never gets stuck.
- A starter pack ships as fork defaults so installs without a Petdex
  network call still render the operator's curated 12.

## Non-goals

- A new identity service. The slug lives next to position and ownership
  in `PetPresence`; the desktop publishes it and every other surface
  renders it.
- Re-importing the operator-removed pets. The starter pack and seeder
  CLI both match the operator-kept 12 and never resurrect deleted
  entries.
- Replacing the desktop's per-install UUID store. The store remains;
  `resolveTravellingPetId` translates from UUID to slug at the boundary
  so the rest of the system only ever sees the slug.

## Implementation

### Travelling identity is the slug — `347e6c0a`

`src/main/pet/pet-identity.ts` (`resolveTravellingPetId`) normalizes a
pet id into the identity that travels between surfaces. The desktop
and the phone name the same creature differently: a pet imported from
Petdex is stored under `sidekicks/custom/<uuid>/`, so the renderer's
store holds a per-install UUID like `4aa6e196-…`. The phone bundles
the same creature by its catalogue slug (`mini-gandalf-the-grey`)
because that is the directory name under `resources/pets/mesh-defaults`
that Metro compiled in.

A UUID is meaningless on any other machine — it is minted at import
time, so two hosts that imported the same pet disagree. The slug is
the only stable cross-surface name, and it is written to `pet.json`
beside the spritesheet at import time precisely so it survives.
Resolving here, in the main process, rather than in the renderer
keeps one definition of "which pet" behind the single writer instead
of every surface inventing its own translation.

### Identity on the wire — `51734a9b`

`petId` now lives in `PetPresence` next to position and ownership,
because it is the same fact: there is one pet. The desktop owns the
operator's selection and publishes it; surfaces render it. The change
is paired with `usePetPresence` selecting from the published `petId`
rather than `Object.keys(FRAMES)[0]` on the phone.

### A clobbered identity heals itself — `f6adc15f`

The no-silent-substitution rule (don't write a different pet into
presence without telling the user) is paired with a self-healing
path: a popout store that rehydrates with the bundled default is
treated as unhydrated, and the overlay reads identity from the
shared presence state before mounting. The operator's selection
wins, even when a stale store would have clobbered it.

### Popout preserves identity — `dd999f0a`

The popout mount path now resolves identity from the shared presence
state before mounting the overlay, so dragging a pet to a popout does
not repaint it as `claude-the-mage`.

### Petdex starter pack seed — `a576a81e`

`src/main/pet/petdex-install.ts` adds a curated catalog, Codex-geometry
conversion, install path into `sidekicks/custom`, an offline seeder
CLI, an IPC handler in `src/main/ipc/pet.ts`, a status-bar entry
("Install Petdex starter pack"), and unit tests. The seed populates
the same `CustomPet` index the status bar already lists when
`experimentalPet` is on. The seeder prefers shipped mesh-defaults
sheets (`resources/pets/mesh-defaults/<slug>/`) and falls back to the
Petdex CDN.

### Shrink to operator-kept 12 — `d780e9cd6`

The operator deleted most of the seed from the Orca GUI on node-b.
`src/shared/petdex-catalog.ts` is trimmed to the remaining keepers;
the seeder CLI and the inline catalog match so re-seed / rebuild does
not resurrect deleted pets. node-e receives the keeper set by
transfer. The catalog carries a comment to that effect so the next
curator does not reintroduce removed slugs.

### Ship operator-curated 12 as fork defaults — `9edf4abb`

`resources/pets/mesh-defaults/MANIFEST.json` plus 12 per-slug
subdirectories (`apupepe/`, `clank/`, `claw-crawler/`, `faye/`,
`gojo/`, `mini-gandalf-the-grey/`, `nezukocoder/`, `nous-girl/`,
`rubick/`, `spike/`, `strike-freedom/`, `teknium/`) bake the live Orca
pet set into the fork. Each subdirectory holds a `spritesheet.webp`
plus a `pet.json` describing the Codex geometry. Starter catalog +
seeder + `seedPetdexStarter` prefer bundled sheets (Petdex CDN
fallback). Default active slug is `mini-gandalf-the-grey`. Do not
re-add pets the operator removed without an explicit catalog edit.

The IPC handler in `src/main/ipc/pet.ts:271` resolves the
mesh-defaults dir for both the packaged tree (`process.resourcesPath`)
and the dev tree (`app.getAppPath()`), and the seeder falls back to
it before any network call.

## Verification

- `src/main/pet/pet-identity.test.ts` — slug resolution for the 12
  shipped mesh-defaults; UUID passthrough when no local manifest
  exists; bundled-default passthrough for `claude-the-mage` and
  friends.
- `src/shared/petdex-catalog.test.ts` — keeper list matches the
  trimmed catalog; manual additions round-trip through the seeder.
- `src/main/pet/petdex-install.ts` unit tests cover the offline
  seeder, the bundled-sheets preference, and the Petdex-CDN fallback.
- `src/renderer/src/components/pet/PetOverlay.identity-reporting.test.tsx`
  — the overlay reports the pet id it actually drew; after a clobber
  heal, the published `petId` matches the operator's selection.
- Live `presence.json` reconciliation on node-b / node-e: the
  published `petId` is a slug, never a UUID; after a popout re-mount,
  the same slug is still published.

## Anti-patterns

- **Re-add a removed pet to the catalog without an explicit edit.** The
  keeper list is the operator's signed-off set; the next curator
  inherits it.
- **Mint a fresh UUID on import and treat it as identity.** UUIDs are
  per-install; the travelling id is always the slug.
- **Read the desktop's selected pet from a per-surface store instead
  of presence.** Identity belongs in the cross-surface state, not in
  each renderer's local view.