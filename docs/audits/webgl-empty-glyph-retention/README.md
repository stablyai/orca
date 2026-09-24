# WebGL invisible-glyph cache retention

The installed xterm WebGL addon caches every character/background/foreground/style
variant. Invisible glyphs return a shared empty glyph and occupy no texture
pixels, but still create cache entries. The texture-page eviction threshold can
therefore never collect a stream of new invisible variants. Changing true-color
foreground values while redrawing a space reproduces the growth; a space followed
by a zero-width joiner exercises the separate combined-character cache.

The source patch keeps invisible entries in a single insertion-ordered key set with
a 4,096-entry cap, separate from the visible caches. Overflow drops only the oldest
admission, so a workload that stays above the cap pays one rasterization per new
variant instead of re-rasterizing all 4,096 on every cap-th miss. Rasterizing costs
a canvas draw plus a `getImageData` readback on the renderer thread, so the wipe was
recurring frame-time noise. Visible glyphs, texture pages, and the atlas layout
version stay intact, so a sibling terminal sharing the atlas does not need to rebuild
its model. Explicit atlas clearing and page eviction still clear invisible entries.

Both generated bundles and their source maps were regenerated using Orca's pinned
xterm patch generator, the lockfile hashes were updated, and the dependency was
reinstalled with the frozen lockfile. The generator's final `--check` passes.

## Reproduce

From the repository root, with Playwright's Chromium headless shell installed:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/webgl-empty-glyph-retention/reproduce.mjs
```

`ORCA_AUDIT_CHROMIUM` can select another Chromium executable. For a before/after
comparison, set `ORCA_AUDIT_WEBGL_BASELINE` to the previous installed
`lib/addon-webgl.js`. This audit reconstructed that baseline by reversing the new
patch from a dependency copy and applying the previous checked-in patch; no
application source or generated bundle was edited by hand.

The script runs the actual installed CJS and ESM bundles in headless Chromium
with SwiftShader, feeds ordinary terminal output, and renders 100,000 redraws in
two modes. It samples V8 heap after CDP collection and records bundle hashes in
[results.json](./results.json). Two terminals share one atlas. Assertions cover:

- Invisible entries stay at or below 4,096; the baseline accumulates 100,000.
- After a fresh fill of 4,096 variants, redrawing that whole window rasterizes nothing,
  and redrawing the one variant that aged out rasterizes exactly once. Clear-all
  eviction scores in the thousands on the first of those two counts.
- After ASCII warmup finishes, visible cache and glyph counts stay exactly unchanged
  across overflow, with no visible glyph rerasterized; the one texture page stays intact.
- Rendered pixels for the unaffected first cell of both terminals stay identical.
- The last 64 repeated variants cause no new rasterization.
- Explicit clear drops invisible metadata even when the atlas has no drawn glyphs.

The baseline ends with 100,093 entries and about 13.6 MB of heap growth. The fixed
run ends with 4,189 entries (93 visible and the full 4,096 invisible), with roughly
0.3 to 0.4 MB of heap growth. Exact heap samples vary; the bounded entry count is the
invariant. No Orca window was launched, and no browser window was shown.

[review-validation.json](./review-validation.json) is the current run, covering both
installed bundles and both output modes on Node 24.20.0 and Chromium 147. Its four
`checks` blocks each report `residentRasterizations: 1` and `evictedRasterizations: 1`.
`results.json` holds the original before/after comparison; its `after` half was recorded
against the earlier clear-all eviction, so its invisible entry counts sit below the cap
rather than at it. The runtime contract test also guards the empty-glyph routing, the
cap, and the single-entry eviction in the source patch, installed source, and both
shipped bundles.

Original validation also passed 86 tests across the patch generator/runtime contract and
WebGL lifecycle/context/recovery suites, full typecheck, lint, and changed-code
quality. Test commands used `ORCA_BACKGROUND_LAUNCH=1`.

The reported `v1.4.198` ships the same addon version and lacks this cap. This is a
renderer retaining path compatible with app-scope memory growth, but #19831 does
not establish a stream of distinct invisible color variants. It does not explain
#19768's separately measured main PID. No incident attribution is claimed.
