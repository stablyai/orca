# Double-tap modifier keybindings — design

## Goal

Allow any keybinding action to be bound to a **double-tap of a bare modifier**
(Shift, Cmd/Ctrl, Alt) in Settings → Shortcuts. A double-tap binding is stored,
recorded, formatted, conflict-checked, and matched alongside normal bindings,
and fires everywhere a normal shortcut does — including when a browser guest or
terminal owns focus.

Example: bind `DoubleTap+Shift` to `worktree.quickOpen` ("Go to File"), then
tapping Shift twice opens Go to File (IntelliJ "double-Shift" style).

## Why this is not just another binding

The existing keybinding system is **stateless and per-keydown**: every binding
has at least one modifier and exactly one key, and matching compares a single
`KeyboardEvent`'s modifier state + key against the stored binding string
(`keybindingMatchesInput` in `src/shared/keybindings.ts`). A double-tap is a
**timed sequence of a bare modifier with no key** — press M, release M, press M
again within a short window. It cannot be represented by the current grammar or
matched by the current stateless comparison.

Dispatch is also split across two layers, and both must participate for a
double-tap to work for "any action":

- **Main process** — `before-input-event` in
  `src/main/window/createMainWindow.ts` matches an explicit allowlist of ~20
  actions via `resolveWindowShortcutAction`
  (`src/shared/window-shortcut-policy.ts`), calls `preventDefault()`, and
  forwards the action to the renderer over IPC. This layer exists so a subset of
  shortcuts work even when focus lives in a browser guest `webContents` or a
  contentEditable surface that bypasses the renderer's window-level listener.
- **Renderer** — the window `keydown` handler in
  `src/renderer/src/App.tsx` matches most actions via `keybindingMatchesAction`
  and runs their effects inline.

## Approach (chosen): synthetic input through the existing matchers

Detect the double-tap with a small shared state machine, then represent the
completed gesture as a **synthetic shortcut input** carrying a
`doubleTapModifier` marker and run that input through the *existing* dispatch
chains in both layers. The matcher is extended so a `DoubleTap+<Mod>` binding
matches only that synthetic input (and never a normal keydown, and vice-versa).

Because the existing dispatch chains already call
`keybindingMatchesAction(actionId, input, …)`, every action that is already
wired in those chains gains double-tap support automatically — no per-action
dispatch table to build or keep in sync.

Rejected alternatives:

- **Per-action dispatch registry** — detector resolves action ids and calls a
  new `dispatchActionById()` implemented per action. Avoids refactoring the
  renderer handler but duplicates action effects that already live there, drifts
  over time, and only supports actions we explicitly wire — not "any action".
- **Re-dispatch a synthetic DOM `KeyboardEvent`** — a double-tap can't be
  expressed as a standard key event without a key, and re-dispatching risks
  event loops.

## Components

### 1. Binding grammar — `src/shared/keybindings.ts`

- New canonical form `DoubleTap+<Mod>` where `<Mod>` is one of `Shift`, `Mod`,
  `Cmd`, `Ctrl`, `Alt`. `Mod` resolves to Cmd on macOS and Ctrl on
  Windows/Linux, identical to normal bindings.
- `ParsedKeybinding` gains `doubleTapModifier?: ModifierToken` and permits an
  empty `key` (only when `doubleTapModifier` is set).
- `parseKeybinding` recognizes a leading `DoubleTap` token followed by exactly
  one modifier token and **no** key token. Anything else with `DoubleTap` is
  invalid.
- `canonicalizeParsedKeybinding` emits `DoubleTap+<Mod>` (modifier in the same
  canonical position rules as today).
- `normalizeKeybindingWithOptions` accepts a well-formed double-tap binding and
  rejects malformed ones with clear errors:
  - `DoubleTap` + a key (e.g. `DoubleTap+Shift+P`) → invalid.
  - `DoubleTap` + two modifiers (e.g. `DoubleTap+Shift+Alt`) → invalid.
  - `DoubleTap+Mod+Cmd` (both forms) → reuse the existing "Mod or
    platform-specific, not both" error.
  - bare `DoubleTap` with no modifier → invalid.
- `formatKeybinding` returns the modifier glyph **twice**: macOS `['⇧','⇧']`,
  Windows/Linux `['Shift','Shift']`.
- `ShortcutKeyCombo` renders the two chips. Double-tap is special-cased so the
  non-Mac separator reads "Shift Shift" (space), not "Shift+Shift". A
  "Double-tap Shift" tooltip clarifies the gesture.

### 2. Detector — new module `src/shared/modifier-double-tap-detector.ts`

A pure, dependency-free state machine. Timestamps are **injected** by the caller
so it is deterministic and unit-testable.

```
class ModifierDoubleTapDetector {
  // event: { type: 'keyDown' | 'keyUp', modifier: ModifierToken | null,
  //          isModifierOnly: boolean, isAutoRepeat: boolean }
  process(event, timestampMs): DetectedDoubleTap | null
  reset(): void
}
```

State machine:

1. **idle** → on a modifier-only `keyDown` of M that is not autorepeat: remember
   M, wait for its release.
2. **down1** → on `keyUp` of M (clean, no other key seen): record release time,
   move to **armed(M)** with deadline `releaseTime + WINDOW_MS`.
3. **armed(M)** → on `keyDown` of the same M within the deadline, with no other
   modifier held and no intervening non-modifier key: **emit** a double-tap of M
   and reset.

Any of these reset to idle: a non-modifier key event at any point, a different
or additional modifier, autorepeat-hold of the modifier, exceeding the window,
or an explicit `reset()` (e.g. on window blur / focus change).

`WINDOW_MS = 300` (internal constant; not user-configurable). A helper derives
`(modifier, isModifierOnly)` from an event's `code`/`key`.

### 3. Matcher extension — `src/shared/keybindings.ts`

- `KeybindingInput` gains `doubleTapModifier?: ModifierToken`.
- `keybindingMatchesInput`: when the parsed binding is a double-tap binding,
  match iff `input.doubleTapModifier` equals the binding's modifier, resolved per
  platform (`Mod` → meta on macOS, control elsewhere). A double-tap binding never
  matches a normal keydown (no `doubleTapModifier`), and a normal binding never
  matches a synthetic double-tap input.
- No change to `keybindingMatchesAction` — it already delegates to
  `keybindingMatchesInput`, so any action becomes double-tap-capable for free.

### 4. Dispatch wiring — both layers

- **Main** (`src/main/window/createMainWindow.ts`): instantiate a
  `ModifierDoubleTapDetector` per window. In `before-input-event`, feed every
  `keyDown`/`keyUp` to the detector (it only consumes bare-modifier events). On
  emit, build the synthetic input `{ doubleTapModifier: M }`, run the existing
  `resolveWindowShortcutAction(syntheticInput, platform, keybindings,
  terminalShortcutContext)`, and if an allowlisted action resolves, dispatch via
  the current IPC + `preventDefault()` path. `resolveWindowShortcutAction` needs
  no per-action change; the implicit numeric-index shortcuts are guarded on
  `input.key`, which is undefined for a double-tap input, so they cannot match.
  Only the emitting second-keydown event is `preventDefault()`-ed — never the
  first tap's down/up (those bare modifiers are harmless and the keyup is needed
  by the detector).
- **Renderer** (`src/renderer/src/App.tsx`): extract the body of the window
  `onKeyDown` handler into `dispatchShortcutInput(input: ShortcutDispatchInput)`,
  where `ShortcutDispatchInput` exposes the modifier/key fields plus
  `doubleTapModifier?`, a `preventDefault()` (no-op for synthetic input),
  `defaultPrevented`, and the focus/target context. The real listener wraps the
  `KeyboardEvent`; a renderer `ModifierDoubleTapDetector` (fed by both a keydown
  and a **new** keyup window listener) produces a synthetic input on emit with
  `context` derived from `document.activeElement`, and calls
  `dispatchShortcutInput`.

#### No double-fire between layers

This reuses the exact disambiguation normal shortcuts already rely on:

- For an **allowlisted** action, main detects the double-tap on the second
  modifier keydown, resolves it, and calls `preventDefault()`. That suppresses
  the corresponding renderer DOM keydown, so the renderer detector never
  completes its second tap → it does not fire. (The renderer detector may have
  observed the first tap's down/up. It has no timer: the second-press window is
  enforced by comparing the next keydown's timestamp against a deadline. The
  suppressed second keydown never arrives, but its keyup still does — a keyup of
  the armed modifier with no intervening second keydown clears the armed state,
  so a later lone press of the same modifier cannot phantom-complete the gesture.)
- For a **non-allowlisted** action, main's detector still emits but
  `resolveWindowShortcutAction` returns `null`, so main does not call
  `preventDefault()`. The second-keydown DOM event reaches the renderer, whose
  detector completes and fires via `dispatchShortcutInput`.

### 5. Recorder UX — `ShortcutBindingRow.tsx` + `ShortcutsPane.tsx`

The recorder currently captures on the first keydown, which makes a bare
modifier error with "Press a key, not only a modifier." Change the row so that
while recording it runs a `ModifierDoubleTapDetector` fed by the row button's
keydown **and keyup** (the button holds focus during recording, so it receives
both):

- A bare-modifier keydown no longer captures immediately — the detector observes
  it.
- A non-modifier keydown (with or without modifiers) captures a normal binding,
  exactly as today.
- A completed double-tap captures `DoubleTap+<Mod>`: the row passes
  `{ doubleTapModifier: M }` into the capture path, and
  `keybindingFromInputWithOptions` short-circuits to build `DoubleTap+<Mod>`
  (mapping meta → `Mod` on macOS, etc.) and normalizes it.
- A single lone modifier tap that never completes is ignored — the recorder
  keeps listening.

Helper text while recording: *"Press a shortcut, or double-tap a modifier (e.g.
⇧⇧)."* Esc still cancels. The detector is reset when recording stops or the row
loses focus.

### 6. Conflicts & terminal policy

`DoubleTap+Shift` is a canonical binding string, so `findKeybindingConflicts`
compares it like any other binding — two actions sharing a double-tap surface a
conflict in the UI. Terminal-policy gating (`keybindingIsActiveInContext`,
orca-first / terminal-first) applies unchanged. Note that a bare modifier press
emits no terminal bytes, so detecting a double-tap never steals readline input;
policy is still honored for consistency.

## Data flow

- **Record:** row keydown/keyup → row detector → `{ doubleTapModifier: M }` →
  `keybindingFromInputForAction` → `DoubleTap+<Mod>` → stored as
  `["DoubleTap+Shift"]` in `~/.orca/keybindings.json`.
- **Runtime:** physical modifier taps → main + renderer detectors → synthetic
  `{ doubleTapModifier: M }` → existing matchers → action dispatched (main IPC
  for allowlisted actions, renderer inline for the rest).

## Behavioral decisions

- **Trigger edge:** fire on the **second modifier keydown** (snappy), not the
  second keyup.
- **Window:** `WINDOW_MS = 300`, internal constant, not user-configurable.
- **Modifiers supported:** Shift, Cmd/Ctrl (`Mod`), Alt — any modifier, recorded
  as the platform-appropriate token following the existing capture convention.

## Testing

- New `src/shared/modifier-double-tap-detector.test.ts`: completion within
  window; timeout past window; reset on intervening non-modifier key; reset on
  different/extra modifier; autorepeat-hold is not a tap; wrong-modifier second
  tap; `reset()` clears state.
- `src/shared/keybindings.test.ts` additions: parse / normalize / canonicalize /
  format for `DoubleTap+*` (incl. malformed-input rejection); platform token
  mapping (`DoubleTap+Mod` → Cmd on macOS, Ctrl elsewhere);
  `keybindingMatchesInput` with a synthetic `doubleTapModifier` input (positive
  and cross-type negatives); conflict detection across two double-tap bindings.
- Manual: record `DoubleTap+Shift` on "Go to File"; confirm it fires globally
  including with a browser guest and a focused terminal; confirm normal Shift+key
  typing is unaffected; confirm chips and tokens are correct on macOS and
  Windows/Linux.

## Risks & edge cases

- **Accidental triggers during fast typing** — mitigated by requiring a clean
  down→up→down of the same modifier with no other key, inside a 300ms window.
- **macOS Sticky Keys (press Shift 5×)** — unaffected; the gesture is two taps
  within a tight window.
- **Double-fire main vs renderer** — resolved by the
  `preventDefault`-on-emit mechanism described in §4.
- **Focus/window changes mid-sequence** — both detectors reset on blur / focus
  change (hook into the existing recorder/terminal focus reset paths in the main
  process and a window blur listener in the renderer).
