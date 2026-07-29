# Layout-aware find in editable Monaco editors

## Problem

Issue [#7953](https://github.com/stablyai/orca/issues/7953) reports that `Cmd+F` can type `f` into a TypeScript file instead of opening find on macOS.

Orca's editable Monaco surfaces currently install its layout-aware save shortcut through `editor-shortcuts.ts` (`src/renderer/src/components/editor/editor-shortcuts.ts:18`), but leave find entirely to Monaco's internal keycode dispatch. Orca already declares `editor.find` as `Mod+F` (`src/shared/keybindings.ts:784`) and its matcher resolves logical keys before physical-code fallback (`src/shared/keybindings.ts:2041`).

A real Electron repro sends a macOS event with logical key `f`, physical code `KeyU`, and virtual key code `U`, as produced by a non-QWERTY layout. Monaco leaves its find widget closed. The equivalent QWERTY `KeyF` event opens it.

## Root cause

Monaco's built-in find keybinding follows the physical/virtual keycode delivered by Chromium. Orca's shortcut system is layout-aware, but its editable Monaco integrations do not use it for find. On layouts where the key that produces `f` is not physical `KeyF`, Monaco misses the chord and Native Edit Context remains in editing mode.

## Non-goals

- Reimplementing Monaco's find widget, match navigation, or search state.
- Changing find behavior in markdown preview, rich markdown, PDF, browser, terminal, or file search.
- Changing find behavior in read-only diff surfaces.
- Reworking all Monaco keybindings or making Monaco defaults fully obey shortcut unbinding in this patch.
- Adding telemetry for a local keyboard action.

## Design

1. Add a focused editor find installer beside the existing save installer in `editor-shortcuts.ts`. It matches `editor.find` through `editorShortcutMatches`, consumes every matched event before it reaches Native Edit Context or Monaco, and invokes a supplied callback only for the initial, non-repeat keydown. Repeat events must still be prevented and propagation-stopped so Monaco's QWERTY binding cannot reopen/reset the widget.
2. Install that handler on every editable Monaco container in the source editor, editable diff views, and notebook code cells. Run that editor's existing `actions.find` action and dispose the bridge from its existing teardown callback.
3. Add unit coverage at the DOM-listener seam for logical `f` with a non-`KeyF` physical code, QWERTY/default behavior, repeat suppression, unrelated typing, and cleanup.
4. Preserve an Electron regression loop that drives both QWERTY and layout-aware raw key events against a real `.ts` editor and verifies the existing Monaco find widget becomes visible without dirtying the file.

## Data flow

- macOS/Linux/Windows keydown reaches the focused editable Monaco container.
- `editorShortcutMatches('editor.find', event)` resolves the active platform, user bindings, modifiers, and logical key.
- On match, Orca consumes the DOM event and calls Monaco's existing `actions.find` action.
- Monaco owns the visible find widget and focus exactly as before.

## Edge cases

- Auto-repeat must be consumed without invoking find again; returning early before prevention would let Monaco handle a repeated QWERTY `KeyF` event.
- Ordinary unmodified `f` typing and unrelated shortcuts must continue to Monaco unchanged.
- A removed/disposed source editor, diff pane, or notebook cell must not retain the listener.
- QWERTY `Cmd/Ctrl+F` must still open the same Monaco widget once, not twice.
- User-configured bindings accepted by Orca's `editor.find` matcher should open find; Monaco's own default bindings remain outside the scope of this patch.
- The behavior is renderer-local and does not read files or execute commands, so local, SSH, and Remote Orca files share the same path.

## Test plan

- Unit: `editor-shortcuts.test.ts` dispatches keyboard events through a real element and parameterizes the shared bridge across macOS (`metaKey`) and Linux/Windows (`ctrlKey`) using logical `f` with physical `KeyU`. It also asserts QWERTY/default handling, matched-repeat prevention without a second callback, unrelated typing, and disposal behavior used by every editable Monaco integration.
- Electron: open a disposable `.ts` file and drive `Cmd+F`/`Ctrl+F` using the platform modifier; assert `.find-widget.visible`, focused find input, unchanged source text, and clean editor state.
- Electron layout regression: on macOS, dispatch logical `f` with non-QWERTY physical/virtual key identity; assert the same find state and unchanged source text.
- Adjacent smoke: dismiss find, type a normal character, and verify it edits the file rather than reopening find.
- Static: run focused Vitest, `pnpm typecheck`, and `pnpm lint`.

## UI quality bar

No new UI. The existing Monaco find widget must appear in its current position and styling, focus its input, and leave the editor content unchanged. No overlap, clipping, duplicate widget, or focus flicker is acceptable.

## Review screenshots

1. QWERTY/default shortcut with the existing Monaco find widget visible in a `.ts` editor.
2. Non-QWERTY logical-`f` regression path with the same find widget visible and source text unchanged.
3. Adjacent ordinary typing state after find is dismissed, showing the source editor still accepts text normally.

## Rollout

1. Add failing unit coverage for the layout-aware find installer contract.
2. Implement the installer in `editor-shortcuts.ts`.
3. Wire it to each editable Monaco surface's existing find action and lifecycle cleanup.
4. Run focused tests, typecheck, lint, and the Electron QWERTY/layout/typing scenarios.

## Lightweight Eng Review

- Scope: Kept to one shared shortcut installer and the existing mount/teardown seams for source editors, editable diff panes, and notebook code cells; no new find implementation or global shortcut interception.
- Architecture/data flow: The renderer-local Monaco container owns the keydown. Orca's canonical matcher resolves the logical key, while Monaco continues to own widget state and rendering. No main/preload/IPC, persistence, network, SSH, or provider boundary changes.
- Failure modes covered:
  - Non-QWERTY logical key differs from physical/virtual keycode.
  - QWERTY double handling.
  - Auto-repeat escaping to Monaco's native QWERTY handler.
  - Listener surviving editor disposal.
  - Ordinary typing being consumed.
  - Custom `editor.find` chord accepted by Orca but not Monaco.
- Test coverage required:
  - DOM-listener unit tests in `src/renderer/src/components/editor/editor-shortcuts.test.ts`, parameterized for Darwin/Meta, Linux/Ctrl, and Windows/Ctrl.
  - Electron-visible QWERTY and layout-aware `.ts` scenarios.
  - Adjacent ordinary typing smoke test.
- Performance/blast radius: One capture listener per mounted editable Monaco editor, doing a constant-time keybinding comparison only for events within that editor. Multiple mounted diff sections do not fan out because each listener is scoped to its own container. Listeners are removed with Monaco disposal; no polling, scans, IPC, storage, or render-loop work.
- UI quality bar: Existing Monaco find widget only; verify focus, unchanged source text, no duplicate opening, and unchanged styling against `docs/STYLEGUIDE.md`.
- Required review screenshots:
  1. Default QWERTY find-open state.
  2. Non-QWERTY logical-key find-open state.
  3. Find-dismissed ordinary typing state.
- Residual risks: Monaco's internal default bindings remain active when a user explicitly rebinds `editor.find`; fully suppressing/remapping Monaco's native keybinding table is a separate, larger change.
