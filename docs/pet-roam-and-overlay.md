# Pet Roam and Overlay

## Problem

The pet needs to roam inside its window without distracting the
operator, behave correctly when it is being dragged or when an agent
is busy, and the same engine has to drive the desktop and the phone so
a handoff does not flip a creature. The right-click menu has to land
on a stable identity so it does not infinite-loop the overlay.

Three sharp bugs surfaced:

- **Roam during drag.** A pet that walks while the operator is
  dragging it is two pets, not one.
- **Phone and desktop roaming differently.** A pet that strolls at
  one speed on the desktop and another on the phone stops reading as
  one creature across a handoff.
- **Right-click → "Give me an assistant" crashes the overlay.** A
  resolver in `usePetAgentAsk` returned a fresh object every call, so
  zustand's `Object.is` equality re-rendered without end. The bug was
  dormant until a spawn created a bound session, which is precisely
  the moment the menu becomes useful.

## Goal

- A single, pure roam engine that the desktop and the phone both run.
- Roam pauses while the operator is dragging the pet or while an
  agent is busy / blocked / waiting on approval.
- The pet is grabbable on the phone with the same direction rule as
  the desktop.
- The speech bubble fires on the phone so the pet announces state
  there too, not only on the desktop.
- The right-click menu mounts without crashing the overlay.

## Non-goals

- Replacing the roam algorithm with a pathfinder or animation
  system. The current engine picks a target, steps, clamps, and pauses
  on a small rule set; that is enough.
- Adding new bubble copy. The bubble text comes from
  `src/shared/pet-bubble-text.ts`; the promotion just makes it
  available to the phone.
- Touching the desktop drag code. The desktop already had a working
  drag; only the phone was missing it, and the direction rule is
  promoted out of the renderer into shared so the two views agree.

## Implementation

### In-window roam with busy/drag pause — `2dcf57b6`

`src/shared/pet-roam.ts` is the pure engine
(pick target, step, clamp, pause rules). `src/renderer/src/components/pet/usePetRoam.ts`
is the `requestAnimationFrame` hook wired into `src/renderer/src/components/pet/PetOverlay.tsx`.
Roam freezes while:

- the operator is dragging the pet, or
- an agent on this worktree is `working` / `blocked` / waiting on
  approval.

Unit tests in `src/shared/pet-roam.test.ts` cover
the pure path; bubble/beats are unchanged. The overlay position test
in `src/renderer/src/components/pet/pet-overlay-position.test.ts`
pins the layout delta so the roam hook integration does not regress
the existing bubble layout.

### Move roam engine to shared for the phone — `436226b2`

Already documented under
[`pet-cross-surface-handoff.md`](./pet-cross-surface-handoff.md#roam-engine-to-shared--436226b2).
The relevant change for this arc is that the engine lives in
`src/shared/` and Metro already watches `src/shared`, so the phone
imports it directly without going through the renderer bundle.

### Pet is grabbable on the phone — `9f0be090`

`src/shared/pet-drag.ts` holds the direction rule (a 4–12 px deadband
that flips facing after a small drag, regardless of which surface the
pet is on). `src/renderer/src/components/pet/pet-agent-state.ts` re-exports it so existing renderer
imports are untouched. Tap-to-notice / drag-to-place are wired into
the phone overlay the same way the desktop overlay already had them.

### Speech bubbles on the phone — `9511a1fd`

Bubble rules move to `src/shared/pet-bubble-text.ts` for the same
reason the drag rule did — a pet that announces "codex is waiting" on
one screen and stays mute on the other is two pets, not one. The
desktop bubble is wired, on by default, and unit-covered; the phone
had no bubble at all, so for as long as the pet was on the phone,
agent status had no voice anywhere. That gap is now closed.
`src/renderer/src/components/pet/pet-bubble.tsx` and `src/renderer/src/components/pet/pet-bubble-text.test.ts` cover the renderer
side; `src/renderer/src/components/pet/use-pet-presence.ts` reads bubble-eligible state from
`agentStatusByPaneKey` the same way the desktop does.

### Right-click loop / React #185 fix — `0de788c1`

`usePetAgentAsk` selected `resolvePetBoundNoteTarget(...)` directly
out of `useAppStore`. That resolver returned a fresh object every
call, so zustand's `Object.is` equality re-rendered without end and
took the overlay to its error boundary with React error 185
(maximum update depth exceeded). The fix is a stable selector
pattern in `src/renderer/src/components/pet/pet-agent-ask.ts` that compares by tab id rather than by
reference. The bug was dormant until a spawn created a bound session,
which is exactly when the menu becomes useful — so it fired
precisely on the click the whole feature exists for.

## Verification

- `src/shared/pet-roam.test.ts` — pure path: pick, step, clamp, pause rules
  across drag / busy / blocked / waiting.
- `src/renderer/src/components/pet/use-pet-presence.test.ts` — bubble eligibility, surface
  registration, edge reporting.
- `src/renderer/src/components/pet/pet-overlay-position.test.ts` — the overlay layout delta after
  the roam hook integration matches what the position test pins.
- `src/renderer/src/components/pet/pet-bubble-text.test.ts` — bubble copy on desktop + phone surfaces
  is identical.
- `src/renderer/src/components/pet/pet-agent-ask.render.test.tsx`, `src/renderer/src/components/pet/pet-agent-ask.test.ts` — the menu
  mounts without triggering React error 185; the ask row targets the
  bound tab.
- Live: dragging a pet across a desktop→phone handoff leaves roam
  state consistent — the pet does not accelerate or pause on the
  receiving surface in a way it did not on the sending surface.