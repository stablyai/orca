# STA-2694 — garbled terminal after switching away from an AI workspace

Handoff snapshot: 2026-07-27, branch
`neil/sta-2694-fix-ui-rendering-artifacts-when-switching-away-from-ai`.

## The report

> When I use an AI tool—such as OpenCode—and switch away to the desktop or
> another task, the page appears garbled or distorted upon returning; I have to
> resize the window to restore the display.

Reporter hints: related to terminal parking / workspace switching; also happens
with Claude Code and probably grok.

## Status

**One defect, root-caused and fixed, with a mechanism-level test that fails
without the fix.** The garble window is *unbounded*, not the ~1s I originally
claimed — see [the correction](#correction-the-window-is-unbounded).

A second hypothesis was implemented, then **refuted by measurement and
reverted**. That refutation is the other half of the value here: it rules out a
whole class of "just force a fuller repaint" fixes, and it is pinned by a test so
it cannot be reintroduced.

| | |
|---|---|
| Fix | `ed1eaf55f1` — release an abandoned synchronized-output frame on reveal |
| Refuted + reverted | `0f7ec4458d`, reverted in `8d5eacecb4` |
| Oracle + scope correction | `3ccffc17ec` |
| Unit tests | 8 passing across 2 files |
| e2e | 5 draw-command oracle + 10 headless convergence + 1 headful |
| Teeth-verified | Yes — removing the fix fails the stranded-latch test |

## The defect

Alt-screen agent TUIs (OpenCode/OpenTUI, Codex, grok) bracket every repaint in
DEC 2026 synchronized output — `\x1b[?2026h … \x1b[?2026l` — many times a second.
Hide a pane mid-bracket (a worktree switch, a cold park, or an OS-level occlusion
lands there routinely) and xterm keeps
`decPrivateModes.synchronizedOutput` latched `true`.

`RenderService.refreshRows` checks that latch **before** rendering
(`RenderService.ts:162`), so while it holds, every repaint Orca owns is a no-op:
the forced render-pause repaint, the plain `refresh()` fallback, and the shared
glyph-atlas rebuild all render zero rows against a perfectly correct buffer.

The fix (`terminal-synchronized-output-release.ts`) clears the latch and flushes
the handler's buffered row range at both reveal repaint entry points, before the
repaint. Both reveal paths reach it:

- `schedulePaneRevealPresent` (plain refocus / desktop return)
- `resetWebglTextureAtlas` (worktree switch, cold park, tab reveal — also reached
  from `resetAndRefreshAllTerminalWebglAtlases` via the light tab-resume path)

### Correction: the window is unbounded

`ed1eaf55f1`'s commit message says this "closes a bounded window rather than the
whole STA-2694 report", because xterm arms a 1s watchdog that clears the latch.
**That was wrong.** The watchdog is armed only inside
`SynchronizedOutputHandler.bufferRows`, and `refreshRows` returns at its
`_isPaused` check *first*:

```ts
public refreshRows(start, end, sync = false, isRedrawOnly = false): void {
  if (this._isPaused) { this._needsFullRefresh = true; return }   // ← occluded pane stops here
  if (this._coreService.decPrivateModes.synchronizedOutput) {
    this._syncOutputHandler.bufferRows(start, end)               // ← only place the watchdog arms
    return
  }
  ...
```

While a pane is occluded its `IntersectionObserver` sets `_isPaused`, so nothing
ever reaches `bufferRows` and **no timer is ever pending**. A pane hidden
mid-frame holds the latch with no watchdog behind it, indefinitely — which is the
indefinite garble the report describes. `terminal-reveal-draw-command-probe.spec.ts`
asserts exactly this: latch set, `_timeout === undefined`, and a repaint drawing
0 instances.

This also explains the specific workaround: resizing the window makes the TUI
repaint via SIGWINCH, and that repaint's closing `?2026l` clears the latch.

## The refuted hypothesis (do not reimplement)

The idea: xterm's renderers are diff-based, so a reveal `refresh()` skips cells
whose model entry still matches the buffer, leaving an occluded canvas showing
pre-hide pixels until a resize rebuilds the model. It is a *plausible* reading —
`WebglRenderer._updateModel` really does early-continue per unchanged cell.

It is wrong, measured on a live pane:

| Refresh | `updateCell` calls | instances drawn |
|---|---|---|
| diff-skipped (model matches buffer) | 0 | 562 |
| model cleared first | 561 | 562 |

`GlyphRenderer.render` copies vertices for **every** row up to `lineLengths[y]`
into the active buffer and issues **one** full-viewport `drawElementsInstanced`.
The diff only decides how much *vertex data* is rewritten, never how much is
*drawn*. The DOM renderer likewise `replaceChildren()`s every row
unconditionally. So clearing the model cannot change what reaches the screen.

Worse, it has a cost: `_clearModel(true)` zeroes every glyph vertex, and
`RenderService.clear()` fires no repaint of its own — so any paint landing between
the clear and the repopulating refresh draws an **empty** viewport (0 instances,
also asserted in the spec). On a reveal that refresh is debounced through a RAF
and can itself be swallowed, which would turn a merely-stale pane into a blank
one. Reverted in `8d5eacecb4`.

The first test in the oracle spec pins the refutation so this cannot come back as
a "fix".

## Why pixel oracles failed, and what replaced them

The field defect is "the buffer is correct but the compositor shows pre-hide
pixels". Two pixel oracles were built and **both were proven blind** by injecting
that exact defect (freeze `RenderService.refreshRows`, then write new content):

1. **Canvas-vs-buffer ink sampling.** `drawImage` on a
   non-`preserveDrawingBuffer` WebGL canvas hands back a *re-rendered* copy — it
   reported 0 missing cells against 5263 cells of text the canvas had never
   drawn.
2. **Screenshot vs. a forced repaint.** Playwright's screenshot drives a fresh
   compositor frame, which *heals* the stale paint before capture; and the
   "repair" ran the same code the reveal already ran, so a shared defect cancels
   out.

An earlier resize-referenced oracle was also unsound: resizing shifts alt-screen
rows, so its 4.4% pixel diff measured legitimate reflow.

**Pixels are the wrong layer** — anything that reads them can trigger the repaint
that hides the bug. `tests/e2e/terminal-reveal-draw-command-probe.spec.ts`
instead wraps `GlyphRenderer.updateCell` and `gl.drawElementsInstanced` on the
live pane and counts draw commands. A draw command cannot be healed after the
fact, so "did the reveal repaint?" is directly observable — and falsifiable,
which is how the second hypothesis got refuted.

Use that spec for **paint** questions;
`terminal-opencode-altscreen-reveal-artifacts.spec.ts` for **buffer, geometry and
PTY-size convergence** (worktree switch, cold park, idle agent, headful desktop
hide). The idle-agent case matters: every earlier test kept the TUI streaming
across the reveal, so live frames repainted whatever the reveal got wrong and the
defect healed itself before any assertion ran.

## Leads closed by measurement

Both were live suspects in the previous handoff; both are now ruled out.

- **Dimension staleness.** Every dimension-rebuilding path in `WebglRenderer` is
  behind an unchanged/zero-sized early exit that a hidden pane trips, and
  `performSafeFit` early-returns at unchanged geometry — so nothing on the reveal
  path re-runs `handleResize()`. Measured across a real `window.hide()` /
  `show()`: canvas backing store `1272×1104` matched the renderer's computed
  dimensions exactly, char metrics stayed `8.65×16`, `_isAttached` stayed true,
  the screen element stayed connected. No staleness.
- **Lagging atlas page bindings.** Right after a reveal the bound texture version
  *does* lag the atlas page (e.g. 1297 vs 1366) — but bindings are lazy and
  `GlyphRenderer.render` rebinds any page whose version moved, so one repaint
  brings them level (1366/1366). Normal, not a defect. Judge bindings only
  *after* a draw.

## Residual risk

The oracle proves the repaint is *issued*; it does not photograph the user's
screen. If a report survives this fix, the remaining suspects are below the draw
call — GPU-process/compositor-level content loss — where the in-app sentinel on
real hardware is the tool:

```js
localStorage.setItem('orca:render-desync-sentinel', '1')   // then reload
```

Reproduce, then **⌘-click** (Ctrl-click off Mac) in the garbled pane. That starts
a 10s burst at 250ms intervals; a trip needs the same cells missing across 2
consecutive samples, ≥200 text cells, ≥8% missing. It writes `corrupt.png` +
`corrupt.json` to `<userData>/terminal-render-desync-evidence/<captureId>/`, then
runs atlas recovery and captures the healed frame. Armed at import when the flag
is set (`terminal-freeze-breadcrumbs.ts:45`).

## Verification commands

```bash
npx vitest run --config config/vitest.config.ts src/renderer/src/lib/pane-manager/
npx tsc --noEmit -p config/tsconfig.tc.web.json
npx playwright test tests/e2e/terminal-reveal-draw-command-probe.spec.ts \
  tests/e2e/terminal-opencode-altscreen-reveal-artifacts.spec.ts \
  tests/e2e/terminal-inline-tui-reveal-convergence.spec.ts \
  --config tests/playwright.config.ts --project=electron-headless --workers=1
SKIP_BUILD=1 npx playwright test tests/e2e/terminal-opencode-altscreen-reveal-artifacts.spec.ts \
  --config tests/playwright.config.ts --project=electron-headful --workers=1
```

To confirm the fix still has teeth, delete the
`releaseAbandonedSynchronizedOutput(pane.terminal)` line from
`schedulePaneRevealPresent` and re-run the oracle: the stranded-latch test fails
with "the reveal repaint did not release the stranded latch, so the pane stays
frozen".

## Files

Production:

- `src/renderer/src/lib/pane-manager/terminal-synchronized-output-release.ts` (the fix)
- `src/renderer/src/lib/pane-manager/pane-reveal-repaint.ts` (`schedulePaneRevealPresent`)
- `src/renderer/src/lib/pane-manager/pane-webgl-renderer.ts` (`resetWebglTextureAtlas`)

Tests:

- `terminal-synchronized-output-release.test.ts`, `reveal-repaint-synchronized-output.test.ts`
- `tests/e2e/terminal-reveal-draw-command-probe.spec.ts` (the oracle)
- `tests/e2e/terminal-opencode-altscreen-reveal-artifacts.spec.ts`,
  `tests/e2e/fixtures/opencode-altscreen-live-fixture.cjs`
