# WebGL invisible-glyph cache retention

The installed xterm WebGL addon caches every character/background/foreground/style
variant. Invisible glyphs return a shared empty glyph and occupy no texture
pixels, but still create cache entries. The texture-page eviction threshold can
therefore never collect a stream of new invisible variants. Changing true-color
foreground values while redrawing a space reproduces the growth; a space followed
by a zero-width joiner exercises the separate combined-character cache.

The source patch keeps invisible entries in separate caches with a shared
4,096-entry cap. Overflow clears only those entries. Visible glyphs, texture pages,
and the atlas layout version stay intact, so a sibling terminal sharing the atlas
does not need to rebuild its model. Explicit atlas clearing and page eviction
also clear invisible entries. A cache miss after eviction rasterizes the invisible
glyph again; recent repeated variants remain cache hits.

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
- After ASCII warmup finishes, visible cache and glyph counts stay exactly unchanged
  across overflow, with no visible glyph rerasterized; the one texture page stays intact.
- Rendered pixels for the unaffected first cell of both terminals stay identical.
- The last 64 repeated variants cause no new rasterization.
- Explicit clear drops invisible metadata even when the atlas has no drawn glyphs.

The baseline ends with 100,093 entries and about 13.6 MB of heap growth. The fixed
run ends with 1,789 entries (93 visible and 1,696 invisible), with roughly 0.3 MB
of heap growth. Exact heap samples vary; the bounded entry count is the invariant.
No Orca window was launched, and no browser window was shown.

A follow-up [review-validation.json](./review-validation.json) reruns both installed
bundles and both output modes with the stronger warmup/count/rasterization checks
on Node 24.20.0. The original before/after measurements above remain in `results.json`.
The runtime contract test also guards the empty-glyph routing and cap in the source
patch, installed source, and both shipped bundles. Its three checks pass.

Original validation also passed 86 tests across the patch generator/runtime contract and
WebGL lifecycle/context/recovery suites, full typecheck, lint, and changed-code
quality. Test commands used `ORCA_BACKGROUND_LAUNCH=1`.

The reported `v1.4.198` ships the same addon version and lacks this cap. This is a
renderer retaining path compatible with app-scope memory growth, but #19831 does
not establish a stream of distinct invisible color variants. It does not explain
#19768's separately measured main PID. No incident attribution is claimed.
