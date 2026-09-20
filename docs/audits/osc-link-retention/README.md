# OSC 8 hyperlink retention reproduction

The installed xterm builds retain hyperlink metadata after a TUI overwrites its
linked text. Each anonymous OSC 8 open creates a registry entry and a line marker;
overwriting or erasing that line's cells does not dispose the marker. Repainting
one linked character therefore grows memory indefinitely even with 24 buffer rows.

This reproduces in `@xterm/headless@6.1.0-beta.302` and
`@xterm/xterm@6.1.0-beta.303`, the versions also shipped in `v1.4.198`.
`OscLinkService.registerLink`, `Buffer.addMarker`, and marker-disposal callbacks
form the retaining path. Explicit `id=` values reuse entries only while both the
ID and URI stay identical; fresh IDs or URIs can accumulate the same way.

## Run

From the repository root, with dependencies installed:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc docs/audits/osc-link-retention/reproduce.mjs
```

The script bundles the current collector, records its SHA-256, and compares the
same installed xterm with and without collection. It uses real parsers and forced
GC without opening a window. Every case performs 10,000 redraws, sampling every
2,500; modes cover ordinary overwrite, erase-line, alternate-screen redraws, and
entering/exiting the alternate screen between redraws.

## Recorded result

See [results.json](./results.json), captured on macOS with Node v24.20.0. Values
below are heap growth after GC, in decimal MB; these are isolated reproductions,
not affected-host measurements.

| Terminal | Before, across four modes | After, across four modes |
| -------- | ------------------------: | -----------------------: |
| Headless |            20.54–20.93 MB |             1.66–1.74 MB |
| Renderer |            20.51–20.77 MB |             1.65–1.73 MB |

All baseline cases retained 10,000 entries/markers with only 24 rows. All fixed
cases retained 785–794 entries/markers at the final sample. A sweep of a
5,024-row, 160-column buffer removed 1,024 obsolete entries in
roughly 6–14 ms for plain rows and 14–16 ms for link-dense rows in the refreshed
run. At 50,024 rows, plain sweeps measured roughly 45–51 ms and link-dense sweeps
roughly 263–325 ms. Sweep cost scales with configured buffer size; these are isolated samples, not latency bounds.

## Mobile verification

Install the mobile workspace from its own frozen lockfile before generating the
WebView engine or refreshing its payload hash. It uses esbuild 0.25.4 and stock
xterm; the desktop workspace uses esbuild 0.25.12 and patched xterm. A shared or
symlinked dependency directory can generate different output while tests still
appear to pass locally.

```sh
corepack pnpm@12.0.0 --dir mobile install --frozen-lockfile
ORCA_BACKGROUND_LAUNCH=1 corepack pnpm@12.0.0 --dir mobile exec vitest run src/terminal/terminal-webview-osc-link-retirement.test.ts src/terminal/terminal-webview-engine.test.ts src/terminal/terminal-webview-payload-hash.test.ts
```

The clean mobile build produces a 731,870-character document with SHA-256
`d1448c5931ba8d90c2c43080cb7f51a903d0d3493bc779497f9f65bff8a1c508`.
The 13 focused WebView checks pass against that build.

## Fix and safeguards

After 1,024 additional registry entries, the collector scans both normal and
alternate buffers and preserves every referenced URL ID, the currently open link,
and saved-cursor attributes. It disposes only markers belonging to entries with
no remaining reference. Existing xterm callbacks remove both registry indexes;
unrelated markers are untouched. The check runs after headless parsing and through
`onWriteParsed` for desktop panes, dashboard previews, and the mobile WebView.

The scan deliberately checks every cell instead of trusting marker rows: wrapping
can put live linked cells on a row other than the initial marker, and resize/reflow
can make marker coordinates stale. Regression tests exercise real headless/renderer
libraries, the generated mobile engine, scrollback, alternate-screen transitions,
partial overwrite/reflow, explicit ID reuse, split writes, unrelated markers, and
both production headless write paths. This keeps correctness sound but leaves a
known performance gap for very large, link-dense scrollback: a synchronous sweep
can take hundreds of milliseconds. A future time-budgeted or incremental collector
should address that separately; this PR does not claim to remove that stall.

The collector depends on private xterm registry/attribute fields, as Orca's
existing snapshot hyperlink extraction does. Shape checks skip unsupported core
layouts, and tests against the pinned libraries must accompany upgrades. Cleanup
occurs between parsed batches; it does not cap a single batch's allocation, live
hyperlink bytes, or ordinary scrollback. Without further registry growth, a final
tail of obsolete entries can remain until terminal disposal.

## Issue correlation

This mechanism can retain memory in Electron main's terminal mirrors, terminal
daemons, and rendered terminals. It needs neither SSH nor headless automation and
is compatible with prolonged TUI redraws. It is therefore a concrete candidate
for [#19831](https://github.com/stablyai/orca/issues/19831) and the main-process
growth in [#19768](https://github.com/stablyai/orca/issues/19768). Neither report
contains the relevant output transcript or allocation trace; this reproduction
does not establish either incident's root cause or measured growth rate.
