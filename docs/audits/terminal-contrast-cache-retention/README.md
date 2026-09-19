# Terminal contrast-color cache retention

Xterm memoizes foreground/background contrast corrections in two caches: ordinary
and dim text. Distinct true-color pairs grow these caches even when the result is
`null` (no correction needed). Texture-page eviction does not clear them. Orca
normally enables contrast correction, so this is separate from the invisible
glyph cache fixed in #20965.

Each `ColorContrastCache` now admits at most 4,096 entries across its color and
CSS maps. Inserting another distinct key clears that cache; replacing a key does
not consume capacity. The normal and dim caches remain independent. Evicted
colors are recalculated by the unchanged correction function. Theme settings,
terminal output, and transport behavior do not change.

## Reproduce

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/terminal-contrast-cache-retention/reproduce.mjs
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/terminal-contrast-cache-retention/reproduce-dom.mjs
ORCA_BACKGROUND_LAUNCH=1 ORCA_AUDIT_MOBILE=1 node docs/audits/terminal-contrast-cache-retention/reproduce-dom.mjs
```

Both scripts exercise the installed CJS and ESM bundles in headless Chromium.
`ORCA_AUDIT_XTERM_BASELINE` can point to a pre-fix CJS bundle to add before runs.
The WebGL script also accepts `ORCA_AUDIT_WEBGL_BUNDLE`. Captured results use the
older WebGL bundle without #20965, clearing its atlas every 1,000 updates to
isolate contrast storage from glyph storage. Thus this fix and reproduction do
not depend on the other open PR. SHA-256 hashes are in the results files.

The WebGL test performs 100,000 colored-space redraws with two terminals sharing
one atlas. One visible glyph uses a low-contrast color that requires correction.
Normal and dim runs preserve both terminals' first-cell pixel hashes and the
corrected glyph's pixels, including after clearing and recalculating its color.
CDP collects garbage before measuring the JavaScript heap; no heap snapshots or
Orca application windows are used.

| Bundle     | Mode   | Final contrast entries |     Heap growth |
| ---------- | ------ | ---------------------: | --------------: |
| Before CJS | Normal |                100,002 | 5,487,228 bytes |
| Before CJS | Dim    |                100,001 | 4,023,452 bytes |
| After CJS  | Normal |                  1,746 |   291,796 bytes |
| After CJS  | Dim    |                  1,721 |   316,176 bytes |
| After ESM  | Normal |                  1,746 |   408,652 bytes |
| After ESM  | Dim    |                  1,721 |   436,188 bytes |

All fixed samples stay within the 4,096-entry limit per cache. The DOM test adds
10,000 redraws per case for dark/light backgrounds and normal/dim text. It checks
that an evicted color, and a color recalculated after explicit cache clearing,
produce the same computed CSS color and rendered row HTML as before.
All 12 DOM cases pass across the baseline and both fixed module formats; samples
reach the exact 4,096-entry cap. Every page and browser is closed after the run.

The mobile mode loads the actual generated WebView engine after mobile's
postinstall. `ORCA_AUDIT_MOBILE_BASELINE` accepts a pre-fix generated engine to
include before cases. Its eight recorded dark/light and normal/dim cases also
preserve the corrected CSS colors and row HTML after eviction and recalculation.
The fixed engine stays within 4,096 entries; the baseline exceeds 10,000.

## Validation and limits

- 122 tests pass across cache, regeneration, contrast, appearance, IME, and
  renderer suites. Two cache regressions fail against the previous source.
- The authoritative source patch, generated CJS/ESM bundles and source maps, and
  lockfile hashes were regenerated together. Frozen install and the pinned
  regeneration `--check` pass.
- Full desktop typecheck, formatting/lint, and changed-code quality pass.
- Captured browser: Chromium 147.0.7727.15 on macOS. Heap measurements include
  GC/allocator variation and other terminal state.
- Mobile's separate package receives a contrast-only source patch, rebuilt
  CJS/ESM bundles and source maps. The existing pinned generator verifies both
  variants, and mobile's postinstall rebuilds its gitignored WebView engine.
  Desktop IME and SortedList patches are not copied into mobile.
- The mobile follow-up passes 90 generator/cache/CI-contract tests and 23 mobile
  engine/theme tests, mobile typecheck, frozen install, and regeneration checks.
  These counts overlap with the earlier desktop pass.
- `v1.4.198` shipped the same xterm version and automatic 3/4.5 contrast settings.
  Its appearance path also skipped unchanged theme/ratio assignments, so ordinary
  reapplication did not periodically clear the cache. User contrast overrides were
  added later; their current behavior is unchanged.
- Revisited evicted pairs incur the existing contrast calculation again. No
  incident report establishes the distinct-color traffic used in this proof;
  renderer retention does not explain #19768's separately measured main PID.

The follow-up [review-validation.json](./review-validation.json) reruns both installed
WebGL bundles in normal and dim modes on Node 24.20.0. Its clear/recompute check
also clears the glyph atlas, requires the contrast cache to repopulate, and compares
the probe pixels after fresh calculation. The original before/after measurements
remain in `results.json`. The focused contrast and CI-scope suites pass 41 tests;
changes to the shared patch-text generator now trigger desktop and mobile checks.
