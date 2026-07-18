# Terminal Glyph Garble — Investigation Summary & Plan

_2026-07-17 · status: deterministic stale-atlas reproduction fixed; sentinel retained for field confirmation · owner: Brennan + Claude_

## TL;DR

The recurring "terminal turns into garbled glyph fragments" bug is real and is
a WebGL glyph-atlas/model desynchronization. On 2026-07-17 it recurred on
`v1.4.145-rc.2` immediately after a terminal link click. This time the corrupted
frame, byte-exact PTY history, and terminal identity were preserved before the
pane healed.

Offline replay reconstructs the correct `231x84` xterm buffer from the saved PTY
stream. The corrupted screenshot is missing rendered ink in 2,702 of 4,487
populated buffer cells (60.2%) and repeatedly shows colored emoji/icon fragments
from Claude's status line across unrelated body cells. A new two-renderer pixel
reproduction now produces the same stale-coordinate failure deterministically:
attaching a renderer to a different shared atlas left its cached vertices marked
as synchronized. The pre-fix frame differed in 327,165 pixels; after forcing a
full model rebuild on atlas identity changes, it is byte-identical to baseline.

The rc.2 capture did not include renderer internals, so the field occurrence
cannot retrospectively prove that this was its exact transition. The pixel
signature, broken invariant, and upstream xterm implementation all agree,
making this the first evidence-backed fix candidate for the captured failure.

## Deterministic root-cause reproduction and fix — 2026-07-17

`GlyphRenderer.setAtlas()` previously copied the replacement atlas's current
clear generation into `_lastSeenClearModelGeneration`. That treated the new
atlas as synchronized even though every cached vertex still contained texture
page and UV coordinates from the old atlas. The next render could therefore
upload the replacement atlas and draw it with the old coordinates, producing
valid glyph fragments in unrelated cells while the xterm buffer remained
correct.

The regression uses two real WebGL terminals with separate atlas populations,
then attaches one renderer to the other's atlas without changing its buffer. It
asserts on the rendered canvas, not private generation values:

- **Before fix:** 327,165 pixels differ from the intact baseline.
- **After fix:** 0 pixels differ; the canvas is byte-identical.
- **Fix:** set the renderer's last-seen generation to `-1` whenever atlas
  identity changes, forcing the next frame through the existing full-model
  rebuild path. Reusing the same atlas remains a no-op.

This matches current upstream xterm behavior, which also marks a newly attached
atlas as unseen instead of adopting its current layout generation.

## Real occurrence captured — 2026-07-17

- **Build:** `v1.4.145-rc.2`; app and GPU processes had both been alive for
  roughly 11h25m. No GPU restart or WebGL/context-loss log occurred around the
  failure.
- **Trigger:** Cmd-clicking `https://github.com/stablyai/orca/pull/9218` in
  terminal `term_bc932216-45c6-41f2-94f1-701b702980ea`.
- **PTY/session:** `numbfish@@cc6c08b1`; the 5,044,220 output bytes replay
  cleanly into `@xterm/headless`, producing 4,487 populated visible cells.
- **Pixel proof:** with the captured `231x84` geometry (`8x16` device pixels per
  cell), 2,702 expected cells have no ink in the corrupted screenshot. The
  repeated status-line emoji fragments strongly suggest stale per-pane glyph
  UV/model references sampling a repopulated shared atlas.
- **Durable local evidence:**
  `~/Library/Application Support/orca/terminal-render-desync-evidence/manual-20260717-125306-term_bc932216/`
  contains the screenshot, OCKL terminal log, reconstructed buffer, checksums,
  and capture metadata. It is mode `0700`; files are mode `0600` because the
  terminal contents may be sensitive.

The installed rc.2 build did not contain PR #8899, so it was impossible to
extract live renderer internals from this occurrence. The initial #8899 design
also redrew before measuring and waited three five-second samples; either choice
could erase a failure that self-heals in about five seconds. The revised design
below corrects both problems.

## Reproduction follow-up — 2026-07-15

The synthetic repro was rebuilt around the exact reported release
(`v1.4.142-rc.4`) rather than the development build. The driver uses an
isolated profile and throwaway repository, recovers the packaged build's live
xterm buffers from React's retained refs, and compares every populated buffer
cell against the corresponding screenshot cell without forcing a redraw.

Two sustained dark-theme runs completed:

- **Production-shaped replay:** 8 tabs / 16 live panes, a 60-second warmup,
  one real browser handoff, then 30 verified OSC-8 Cmd-clicks. Across 1,234
  pane-frame samples and 249,661 populated cells, no expected cell was missing
  ink. All renderer snapshots were unpaused with no pending full refresh.
- **Accumulated-atlas + focus replay:** colored glyph churn compressed hours of
  atlas history until the shared atlas continuously cycled between 10 and 16
  pages. Twenty URL-handler cycles displaced the main window with an isolated
  native focus sink, then restored it while replay continued. Across 634
  pane-frame samples and 546,928 populated cells, there were zero missing cells
  and zero persistent desyncs. Thirteen clicks retained the exact test URL;
  seven acquired adjacent churn text in xterm's link extent, but still exercised
  the same link handler and focus transition.

The oracle was checked by blanking one captured pane in memory: it reported
1,511/1,511 missing cells and tripped after the required three frames. Earlier
whole-pane density suspects were inspected and rejected as legitimate TUI
rewrites; one later one-cell event was a single-frame buffer/screenshot race at
the entering prompt row and appeared normally in the following frame.

**Result:** the reported garble did not reproduce in the isolated exact-release
environment, including under multipage atlas eviction and native focus churn.
This is a materially stronger negative result, not evidence that the live bug
is gone. The remaining difference is Brennan's long-lived real process state,
GPU/driver history, and real occlusion/parking schedule.

Reusable tooling now lives in:

- `tools/terminal-garble-production-repro.mjs`
- `tools/terminal-garble-session-replay.mjs`
- `tools/terminal-garble-react-terminal-recovery.mjs`
- `tools/terminal-garble-frame-analysis.mjs`

## The bug

- A terminal pane running a dense TUI (Claude Code is the reliable stress
  case) suddenly renders as tiny colored glyph fragments / blank cells while
  the pane keeps streaming. A sibling pane sharing the same glyph atlas can
  stay perfectly crisp.
- The terminal's _buffer_ is always correct — copying text works, and
  scrolling, resizing, selecting, or **switching tabs and back instantly heals
  it**. It is purely a rendering-layer desync.
- Observed 2026-07-13 (screen recording: garble ~5s after a ⌘+click on a
  link, self-healed) and again 2026-07-15 on v1.4.142-rc.4 with the same
  steps. Long history of related reports (#5130 and the partial-fix lineage:
  #2281, #1579, #4941, #2708, #5042, #7064, #7554, #8150).

## What is proven (not theory)

1. **The failure class is real and demonstrable.** A deterministic harness
   shows the _unpatched_ WebGL addon garbling ~20% of a pane's cells while its
   buffer is clean (screenshots + per-cell pixel proof, side by side with the
   healed render of the same buffer).
2. **Atlas replacement was a real uncovered invalidation gap.** A renderer
   could attach to a different shared atlas while retaining vertices from the
   previous atlas, then suppress the required full rebuild by adopting the new
   atlas's current generation. The real WebGL pixel test is red before the fix
   (327,165 pixels changed) and byte-identical after it.
3. **The field occurrence remains retrospective evidence, not a live internal
   trace.** rc.2 could not record the renderer generations, so no honest claim
   can prove which call replaced its atlas. The failure shape is the same and
   the violated invariant is sufficient to cause it.
4. **WebGL must stay.** The DOM renderer fallback is the "easy fix with bad
   consequences" the team explicitly rejected before (see PR #5048 history);
   GPU rendering is a performance requirement for dense agent TUIs.

## What got fixed along the way

### PR #8672 — atlas sampler-budget fix (merged, in rc.4)

The atlas could grow more texture pages than the shader has sampler slots
(16 on most Macs); glyphs on the extra pages render as undefined pixels, and
one code path could crash the renderer outright. #8672 makes the atlas
evict-and-rebuild rather than exceed capacity — the same design direction the
xterm.js maintainers have in flight upstream (xtermjs/xterm.js#6043).

**Honest status:** it fixes a real, provable defect and should stay merged —
but it is _not_ the fix for Brennan's repro (that was believed at the time and
was wrong; the recurrence on rc.4 disproved it). It was authored during this
investigation and merged from Brennan's account on 07-14; flagged here because
it hadn't clearly registered.

### Why the earlier fixes kept "missing"

Earlier fixes — the team's lineage and this investigation's first two — were
chosen from _plausible mechanisms identified by reading code_. This subsystem
(shared glyph atlas + per-pane renderers + Orca's visibility/recovery
scheduling) offers many plausible failure mechanisms; several were genuinely
broken and genuinely got fixed. But plausibility is not causality, and the
only way to discriminate is data. The 2026-07-17 capture narrowed the failure
to stale atlas/model sampling; a focused audit then found and pixel-reproduced
the atlas-identity transition that the generation logic incorrectly skipped.

## Remaining uncertainty and field confirmation

- **The original corpse is incomplete.** The screenshot and replayed buffer
  prove the render mismatch, but rc.2 could not record the renderer generation
  or atlas identity at the failure moment. Field confirmation on the fixed
  build is still necessary before calling the incident closed.
- **The user gesture is not yet deterministic.** The invalid atlas-replacement
  state now reproduces exactly, but an isolated Cmd-click soak did not reliably
  drive Orca into that state. Long-lived process, parking, reattachment, and
  configuration timing may determine when the replacement occurs.
- **A false capture already happened once.** An early detector "reproduced"
  a 14.7% divergence that turned out to be an artifact of driving xterm's
  pause flag unfaithfully; driven through xterm's real unpause path it healed
  to 0%. Lesson encoded: fixes get written against faithful captures only.

## Field confirmation: renderer-state capture (revised PR #8899)

**Render-desync sentinel** — off by default, armed per-machine:

```js
// DevTools console in Orca, then reload:
localStorage.setItem('orca:render-desync-sentinel', '1')
```

After a terminal Cmd/Ctrl-click, it samples that pane every 250ms for 10
seconds. It reads the compositor-presented canvas **without a redraw** and
compares it with the simultaneous xterm buffer. A trip requires the same
screen cells to be divergent in two consecutive samples; real desync is pinned
in place while scroll/frame races move.

On trip it does three things:

1. Records a `webgl-render-desync` breadcrumb (joins the existing
   freeze-report diagnostics).
2. Writes the garbled canvas PNG, clean buffer text, atlas clear generation,
   atlas page versions, glyph texture versions, glyph-renderer generation,
   model line lengths, and vertex state under app-owned user data. The flag is
   an explicit local opt-in because pixels and buffer text may be sensitive.
3. Only after the corrupt evidence write succeeds, runs the same recovery a tab
   switch performs and saves a healed reference PNG beside the capture.

The renderer keeps at most four capture records and releases their large pixel
and buffer payloads after persistence. The main process independently retains
at most four capture directories under a 96 MiB aggregate budget.

**Lifetime is bounded:** the sentinel is scaffolding. It comes out once the
root cause is fixed — or in ~a month if it never trips (which would itself be
signal). Review should come from the terminal-rendering owners, not
self-certified.

## Decisions & discipline

| Item                           | Decision                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR #8672 (sampler budget)      | Keep merged — real defect, independent of this repro                                                                                                                                               |
| PR #8899 (sentinel)            | Merge with removal deadline; arm on Brennan's machine                                                                                                                                              |
| Atlas replacement fix          | Ship with the pixel regression; require field confirmation before declaring the incident closed                                                                                                    |
| Disabling WebGL / DOM fallback | Rejected (team decision, performance)                                                                                                                                                              |
| More synthetic repro rigs      | Retired — negative results already conclusive; a rig also caused a real-browser-popup incident (clicks reached `shell.openExternal`), rules for any future rig are documented in the session notes |

## If the revised sentinel trips again

The capture will show whether the renderer was still stale at an atlas identity
change or whether a second invalidation path remains. Preserve that evidence
before recovery and extend the permanent pixel regression around the recorded
transition.

## Artifacts

- Proving harness (buffer-vs-render, calibrated to 0% baseline, catches the
  old bug at ~20%): `/tmp/glyph-proof/`
- Red/green + regression harnesses for the atlas fixes: `/tmp/glyph-overflow-repro/`,
  `/tmp/xterm-garble-repro/`
- Live-rig tooling (replayer for Orca terminal-history logs, CDP driver):
  the platform temp directory's `garble-rig/` — `shell.openExternal` is stubbed
  by default; pass `--allow-open-url` only when a real browser handoff is required
- PRs: [#8672](https://github.com/stablyai/orca/pull/8672) (merged),
  [#8899](https://github.com/stablyai/orca/pull/8899) (open)
