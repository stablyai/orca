# xterm reflow writes before the retained buffer

Narrowing a terminal can make xterm's final reflow insertion loop write below logical row zero. `CircularList` maps those indexes with JavaScript remainder: negative results become array properties outside its public length, and nonnegative results overwrite valid rows. The fix stops that insertion loop before the destination falls below zero. It preserves the complete insertion/trim event counts, cursor adjustments, row capacity, and earlier reflow work.

This is separate from the **temporary allocation amplification** measured below. The fix prevents surplus retained rows and corrupted terminal contents; it does not reduce allocation of rows that are later discarded.

## Bounded actual-package reproduction

From the repository root, after installing dependencies:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/xterm-reflow-retention/reproduce.cjs
```

The runner builds the actual `HeadlessEmulator` and portable process launcher in a disposable directory beneath this artifact. It removes that directory afterward. Each memory child has a 192 MiB old-space limit, a 15-second parent timeout, and a sampled RSS ceiling below 240 MiB. No terminal process, app, renderer window, provider, or network is started. Scripts require only the repository's installed dependencies; there is no dependency on ignored notes.

`install-candidate.cjs` finds one exact insertion loop in the installed CJS bundle and evaluates two in-memory module variants: without and with the destination guard. It records installed, baseline, and candidate SHA-256 values and changes no package files. Every other installed patch remains present in both variants. The wrapper still calls the actual installed xterm implementation.

With 80 columns, a 24-row viewport, and 1,000 total retained rows, write a 79,920-byte numbered logical line followed by CRLF, then resize to 8 columns. The cursor is on the separate blank row, so the default cursor-line reflow exclusion does not prevent this trigger:

| Observation                                  | Original loop |          Guarded loop |
| -------------------------------------------- | ------------: | --------------------: |
| Additional BufferLines allocated             |         8,991 |                 8,991 |
| Final public row count                       |         1,000 |                 1,000 |
| Retained negative array properties           |           999 |                     0 |
| Cell-array bytes in those properties         |        95,904 |                     0 |
| First retained row                           |    `00001991` | `00008991` (expected) |
| Incorrect retained rows                      |             1 |                     0 |
| Heap growth after a later turn and forced GC |      ~0.54 MB |              ~0.07 MB |

The surplus property count is bounded by the circular capacity minus one. It is not an indefinitely growing row registry. A rotated circular start can corrupt more than the first retained row: the 128-row parity fixture with start index 37 changes 37 valid rows in the original loop, all restored by the guard.

`parity-results.json` records 28 cases: 14 scenarios through each actual installed headless and renderer CJS bundle. They cover multiple wrapped groups, a rotated ring, wide and combining characters, colors, a wide-character boundary at 9 columns, optional cursor-line reflow, default cursor exclusion, hard-newline overflow, unfilled/small buffers, alternate screen, same-size resize, and the 2- and 20-column dimensions. Cursor/viewport state, marker state, and insert/trim events match the original implementation. Guarded retained cells and wrapping match the tail produced by a larger-capacity actual xterm reference for applicable cases. The first row's wrapped flag is excluded from that reference comparison because trimming its predecessor can change that flag. Controls without out-of-range writes preserve their existing output. Follow-up writes, widening and shrinking produce no negative writes in the candidate; this is not a complete oracle for every repeated-reflow sequence.

The product regressions add eight cases that separately exercise the installed headless and renderer **CJS and ESM** builds, checking the full retained numbered tail, cursor and marker behavior, and absence of negative properties with unrotated and rotated circular starts. Two additional generated-mobile-engine cases check the retained tail and negative properties at its 20-column floor.

## Retention lifetime

`lifecycle-results.json` records eight WeakRef/forced-GC controls through actual headless and renderer packages. Ordinary `terminal.clear()` retains the old array and negative rows. `terminal.reset()` replaces the buffers and releases them. Calling `dispose()` while the terminal object remains strongly referenced retains its array; disposal followed by dropping the terminal reference releases both. These observations concern an otherwise unreferenced fixture, not every application owner graph.

The patch prevents new invalid writes. It does not clean negative properties already present in a live terminal instantiated with the old implementation.

## Separate temporary amplification

`_reflowSmaller` calculates all destination line lengths and allocates every new row into `newLines`/`toInsert` before rearranging the bounded circular buffer. New rows have the **new** column width because `BufferService.resize` updates its columns before buffer reflow. Object count increases with the width ratio; total cell bytes do not increase by that same ratio.

The hard-newline controls fill a 24-row viewport plus scrollback up to the stated total capacity. This is slightly below production defaults, which add the viewport to the scrollback setting. Hooks delegate unchanged to `getBlankLine` and the final trim emitter, retain only scalar counters, and force GC while insertion lists remain on the synchronous stack. These are sampled live-allocation observations, not a natural peak or timing benchmark.

| Old → new columns                 | Total rows | Additional rows created | Sampled heap increase | Sampled external increase |
| --------------------------------- | ---------: | ----------------------: | --------------------: | ------------------------: |
| 80 → 80                           |      1,000 |                       0 |              ~0.04 MB |                  ~0.04 MB |
| 80 → 2, only 2 characters per row |      1,000 |                       0 |              ~0.10 MB |                  ~0.04 MB |
| 80 → 2                            |      1,000 |                  38,961 |             ~17.75 MB |                  ~0.04 MB |
| 80 → 8                            |      1,000 |                   8,991 |                 ~4 MB |                   ~0.9 MB |
| 80 → 8                            |      5,000 |                  44,991 |             ~19.39 MB |                  ~4.36 MB |
| 200 → 8                           |      5,000 |                 119,976 |             ~50.41 MB |                 ~11.56 MB |
| 200 → 20                          |      5,000 |                  44,991 |             ~19.39 MB |                 ~10.84 MB |

For these divisible-width ASCII controls the exact new-row count is `(capacity - 1) * (oldCols / newCols - 1)`. Cell-array bytes are independently counted; small typed-array storage is not consistently reflected in `external`. Final public row count stays at the original cap. Forced-GC heap growth in these hard-newline cases is about 0.12–0.18 MB after a later event-loop turn, while wider old cell storage is collected. RSS can remain high during this short observation. No long-term RSS plateau is established.

The minimal fix intentionally leaves this temporary allocation algorithm unchanged. Avoiding allocations for all doomed rows would require separate cursor, marker, wrapping, and copy-order analysis; lowering configured scrollback or clamping dimensions would change user behavior.

## Production resize boundaries

- Main `createPtyHeadlessTerminalState` omits `scrollback`, using `HeadlessEmulator`'s **5,000 scrollback rows**, plus viewport rows. Daemon session creation uses **1,000** by default, with an environment override restricted to 100–5,000. Desktop renderer policy defaults to **5,000**, allows a minimum of 1,000 and maximum of 50,000. The maximum was not stress-tested.
- Normal desktop fitting requires at least **8 columns** and a measurable pixel box: `pane-fit-measurability.ts` → `pane-fit.ts::performSafeFit` → `fitAddon.fit` → xterm resize. Overrides call the same terminal resize API.
- Renderer `pty:resize` → `resize-visibility.ts` → owning `provider.resize` and `runtime.onExternalPtyResize` → `resizeHeadlessTerminal`'s per-PTY write chain → `HeadlessEmulator.resize`. Daemon `Session.resize` calls its output emulator before resizing the subprocess. SSH work remains on its execution owner; folder workspaces use the same terminal machinery.
- Mobile and paired-runtime desktop viewport paths clamp to **20–240 columns** through `clampTerminalViewport`, including `terminal.resizeForClient`, desktop viewport updates, and remote desktop floor updates. The 20-column case covers that lower dimension.
- The 2-column case is the installed xterm API/direct resize boundary. Public `CoreTerminal.resize` clamps below 2, so the source's 1-column non-progress comment does not establish a reachable Orca hang. This artifact does not claim an ordinary DOM fit or high-level runtime RPC applies two columns.
- Normal-buffer reflow policy matters. Alternate-screen content does not take this scrollback reflow path; the parity suite includes that control.

## Source version, regeneration, and limits

Installed headless **6.1.0-beta.302** and renderer **6.1.0-beta.303** share upstream commit `d3e32b344dfe7dd6015cff6a9aeaaeaeccdc2789`. Their reflow source is identical. `source-versions.json` records the **pre-fix** primary worktree and named `v1.4.198` comparison. That release pins the same packages/upstream and contains the affected Buffer/BufferReflow path, 5,000-row wrapper default, and 8-column fit floor. The current baseline already includes separate contrast-cache and BufferLine cleanup patches; it is not an identical reconstruction of the incident's installed binary.

The maintained source patches add only the destination guard. The canonical generator rebuilds both module formats and maps, checks pristine upstream output against published bytes, and updates patch hashes. Mobile derives the same `Buffer.ts` stanza alongside its existing contrast and cell-cleanup changes. This PR stacks on terminal-cell cleanup **#20992**, which itself stacks on contrast-cache **#20981**; the earlier fixes remain prerequisites, not additional changes attributed to this finding.

`validation.json` records the primary worktree lock that was installed and tested. Publication preserves the base branch’s unrelated WebGL patch hash in three root-lock entries; the reflow sources, bundles, and mobile lock are identical. The projected lock’s hash and exact applicability are recorded separately; that projected lock was not installed in a second checkout.

Source presence and bounded actual-method reproduction do not establish that #19768 or #19831 involved the required terminal content and resize sequence. No affected-host resize trace, heap capture, or historical packaged-binary reproduction is available. The retained surplus is bounded per affected buffer, and the larger allocation measurements are temporary. Neither result alone explains the reported multi-gigabyte incidents.
