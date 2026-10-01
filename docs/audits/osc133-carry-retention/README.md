# Retained OSC 133 incomplete carry

The shared command-lifecycle scanner keeps an incomplete OSC 133 suffix of at
most 4,096 UTF-16 code units. A V8 sliced string can keep the entire preceding
PTY input alive through that small suffix. The correction copies only the final
incomplete carry through existing `ownRetainedString`; short prefixes, content,
parsing, callbacks, authority and reset behavior are preserved.

This adds the fifteenth retained-text boundary to
[#20960](https://github.com/stablyai/orca/pull/20960), following the
[kitty/mouse tails](../terminal-mode-tail-retention/README.md) and other
[retained text slices](../retained-text-slices/README.md). It introduces no wire
change and applies equally to local and SSH/remote terminal bytes reaching the
shared scanner.

## Reproduce

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=192 docs/audits/osc133-carry-retention/reproduce.cjs
```

Run the same script with the installed Electron executable, setting
`ELECTRON_RUN_AS_NODE=1` and `ORCA_BACKGROUND_LAUNCH=1`, with the same Node flags.
No application window, native PTY, or network is created. The runner has a
60-second deadline and accepts an optional output-report path as its first
argument; otherwise it writes [Node](./node-results.json) or
[Electron](./electron-results.json) results here.

The portable loader validates all 28 bundled source modules and seven additional
caller/fixture files. Non-evaluated provenance callers accept only the recorded
audited or named-main bytes, and reports identify which was present; evaluated
modules each require one exact fixed hash. It reverses only the new import/copy call in memory through
a zero-context [patch](./fix.patch), then validates the baseline hash. All
evaluated-source and artifact hashes are recorded. It needs no Git history,
ignored notes, or absolute developer paths. Source/patch reads normalize CRLF;
an in-memory CRLF control checks equivalent before/after strings.

The scanner baseline exactly matches named main
`291b4ddd6f1c1af480169885e0fda7f9c78ff053` and `v1.4.198`
(`e0826956fcfc532f5a1e55b5e081f2e57e553c43`). The copier did not exist in
`v1.4.198`; current helpers and callers are used for both sides of this
experiment. [Source provenance](./source-versions.json) records each named
identity/absence separately. This is not a replay of a complete historical app.

## Result and controls

Both Node 26.6 and Electron 43.7 / Node 24.21 pass **117 cases**. Each runtime
compares the baseline, fixed Buffer copier and fixed Bufferless copier through
the actual scanner, shared title tracker, and daemon background transient-fact
relay. Thirty-two 64 Ki-character inputs retain roughly 2 MiB before the copy;
eight 1 Mi-character inputs retain roughly 8 MiB. Fixed deltas are below the
asserted 1 MiB tolerance, including owner overhead. Completion and reset/exit
release the old parents. Exact GC-sensitive measurements are in the reports;
they are heap deltas, not RSS or exact allocation attribution.

The ordinary sequence bytes come from the fish 4.7.1 capture documented in
`src/shared/terminal-mode-2031-final-state.test.ts`: `A;click_events=1` and
`C;cmdline_url=npx`. That capture contains complete OSC sequences. **The large
plain-output prefix and cut before the terminator are synthetic.** This does
not claim the original capture had those sizes or boundaries.

Controls preserve BEL/ST completion, split prefixes, C/D callback values,
background disable/re-enable, reset, and every split of a Unicode/NUL/lone-
surrogate fixture. The Bufferless copier is selected while Buffer is absent,
then Buffer is restored before measurement; this exercises the renderer's
actual fallback without launching a renderer. Short ordinary `D;0` prefixes,
complete sequences and plain input are negative retention controls. Oversized
unterminated input is separately labelled malformed-protocol stress. V8's
independent last successful RegExp input is reset before both measurements.

Eight permanent tests cover both copier paths, long captured-fish suffixes,
completion, reset and short `D;0`. With the in-memory baseline overlay, exactly
four long-suffix regressions fail at 33,550,680–33,565,360 retained bytes against
a 2 MiB allowance; the other 41 tests in the four-suite run pass. The fixed run
passes all 45. Wider proof/quality validation is recorded in
[validation.json](./validation.json).

## Owners and ordinary input bounds

Main creates a per-PTY tracker with `onCommandFinished` in
`orca-runtime-get-unpersisted-tracked-title-for-pty.ts`; scanner enablement still
respects transient-fact consumer/authority state. Ordinary daemon output frames
delivered to main are sliced to 64 Ki characters in
`daemon-stream-data-batcher.ts`, and ordinary relay output to 16 Ki characters
in `src/relay/pty-handler.ts`. The 64 Ki cases therefore demonstrate retention
without requiring a multi-megabyte main input; the 1 Mi cases amplify the
mechanism. Replay and transformed output have their own existing limits.

The daemon's `BackgroundTransientFactRelay` owns one tracker per background
session. `daemon-terminal-admission.ts` feeds it before output batching, so the
batcher's later slicing is not an input cap on this daemon scanner. Native data
passes through `pty-subprocess/subprocess-handle.ts`, the session's shell
readiness/startup/recovery path, and its stream client. The inspected local
intake does not impose an independent string-length limit; platform/native
library chunk sizes were not measured here.

Completion/replacement of the incomplete escape, scanner reset, session exit,
background retirement, tracker disposal or owner release drops the old parent.
This is at most the last incomplete-parent cost per live scanner, not a list of
every historical chunk. Multiple readers may share the same input backing
storage; do not add their isolated measurements as independent process totals.

This is a reproduced code-level retention mechanism. It does not establish a
native output pause, normal-session frequency/duration, the trigger in
#19831/#19768, a reported sustained growth rate, or a multi-gigabyte incident's
cause. The change does not reduce original input allocation.
