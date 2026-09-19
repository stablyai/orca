# Dead terminal cell text

The installed xterm engine retains overwritten combined Unicode strings in three
places: sparse cell maps, invalid line-translation caches, and a module-wide cell
used while shifting columns. All three can retain text after the terminal becomes
blank. Scrollback row limits do not bound the length of an individual cell string.

The fix releases dead strings and unused extended attributes. It preserves live
combining text, protected cells, wide characters, column moves and reflow. Setter
cleanup checks the old cell flags before overwrite; copying checks destination
maps because the destination flags have already been copied.

## Reproduce

From the repository root, after installing the regenerated package:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc docs/audits/terminal-cell-retention/reproduce.mjs
```

For the same run against an unmodified package, point
`ORCA_AUDIT_HEADLESS_BASELINE` at the pristine CJS bundle produced by the existing
patch generator, for example:

```sh
ORCA_BACKGROUND_LAUNCH=1 \
ORCA_AUDIT_HEADLESS_BASELINE=/tmp/orca-memory-xterm-patch-build/pristine/_xterm_headless/package/lib-headless/xterm-headless.js \
node --expose-gc docs/audits/terminal-cell-retention/reproduce.mjs
```

Each case runs in a fresh Node process with forced GC. No app, PTY process or
visible window is launched. Headless, desktop and mobile CJS/ESM builds are
exercised, in normal and alternate buffers. The fixture uses eight cells, each containing a base character
and 100,000 combining acute accents. The live-text and scratch-cell cases use one
cell. It reports numeric counts, bundle hashes and heap growth without retaining
the inspected text in its results.

Before the fix, overwriting eight cells with ordinary characters or erasing them
retains about 42.9 MiB. A separate full-line erase clears the sparse maps but leaves
about 42.9 MiB in invalid translation caches. Shifting then clearing the last
combined cell leaves about 5.45 MiB in the shared scratch cell. Fixed runs retain
about 0.1–0.2 MiB in these cases. A live 100,001-character cell continues to retain
about 5.46 MiB, preserving its complete text.

These are separate cases, not additive allocations: a string can have several
retaining roots. `results.json` contains 70 isolated cases: ten baseline cases
and sixty fixed cases across the six installed bundles.

Independent source checks and parser timings can be repeated with the same
`ORCA_BACKGROUND_LAUNCH` and `ORCA_AUDIT_HEADLESS_BASELINE` settings:

```sh
node docs/audits/terminal-cell-retention/semantic-review.cjs
node docs/audits/terminal-cell-retention/throughput.cjs
node docs/audits/terminal-cell-retention/emitted-throughput.mjs
```

The source check preserves cells and translations across 25,000 seeded mutations
and proves the scratch-cell release directly. The actual-source parser benchmark
has a low single-digit cost. The emitted CJS comparison batches eight 1.2 MB ASCII
writes per round, alternates execution order, and discards four warmup rounds:
median time per write is 7.665 ms before and 8.04 ms after, about 5% slower in this
synthetic hot path. This is a measured cleanup cost, not an application-wide
performance estimate. Timings and source/bundle hashes accompany both scripts.

## Scope and evidence

`HeadlessEmulator` feeds this engine in Electron main and the terminal daemon.
Desktop and mobile xterm use the same `BufferLine` implementation. The reported
`v1.4.198` pins the same unpatched headless package, version
`6.1.0-beta.302`, published from upstream commit
`d3e32b344dfe7dd6015cff6a9aeaaeaeccdc2789`. Its package integrity matches the
baseline used here. Desktop's `6.1.0-beta.303` has identical `BufferLine` source.

The large combining sequences are synthetic. This proves a retaining mechanism,
not that issues #19831 or #19768 contained that output. Ordinary small graphemes
incur much smaller retained values; growing live text is distinct from retaining
text that has been overwritten.

The real-emulator regression suite is
`src/main/daemon/headless-cell-retention.test.ts`. It covers both buffers,
overwrite/erase, wide-cell boundaries, insert/delete, overlapping copies in both
directions, same-column copying, protected cells, shrink/grow, legacy scalar
writes and unchanged live combining text. Its 17 cases fail 15 times before the
fix and all pass after it. A broader emulator/snapshot/fidelity run passes 127
tests across 11 files. The generated mobile WebView engine also passes both
normal/alternate-buffer cases in Happy DOM.

The PR is stacked on contrast-cache PR #20981. Its regenerated desktop and mobile
patches include that prerequisite; it is not a standalone patch against main.
The separate headless source patch contains only the `BufferLine` change.

## Review follow-up

The branch now includes the current #20981 base. Both source patches had stale hunk
counts after conditional cache invalidation was added; those counts and the generated
headless, desktop, and mobile bundles/maps are now rebuilt from the pinned upstream.
Both lockfiles contain the matching patch hashes. The mobile WebView engine and its
expected payload hash were regenerated from the installed mobile package.

Both complete `--check` commands pass. The patch-generation/source-map/headless suites
pass 62 tests, and the generated mobile engine/payload suites pass all three tests.
The 70 allocation cases, 25,000 source mutations, and both throughput artifacts were
rerun against these exact rebuilt packages on macOS arm64 / Node 24.20.0. `diff` is now
a direct development dependency, so the source audit does not rely on hoisting.
