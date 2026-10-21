# Retained terminal mode scan tails

The kitty keyboard tracker and daemon mouse-mode mirror retain an incomplete
escape-sequence tail of at most 4,096 UTF-16 code units. A V8 sliced string can
keep the entire consumed input alive through that small tail. An ordinary
split grouped mode sequence, `ESC[?1049;2004;1000;`, is enough: its 18-character
tail retains each input backing string while its parser stays idle.

The correction copies only accepted incomplete tails through the existing
`ownRetainedString` helper. Empty/rejected tails and short ESC/CSI prefixes keep
their existing behavior; the helper leaves strings shorter than 13 code units
alone. Parser state, live/replay semantics, stack caps, mode flags, and wire
content are unchanged. These are additional boundaries in
[#20960](https://github.com/stablyai/orca/pull/20960), alongside the
[PTY detector carries](../pty-detector-retention/README.md).

## Reproduce

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=192 docs/audits/terminal-mode-tail-retention/reproduce.cjs
```

Run the same script with the installed Electron executable, setting
`ELECTRON_RUN_AS_NODE=1` and `ORCA_BACKGROUND_LAUNCH=1`, and passing the same
Node flags. This launches no app window or native PTY. Each run has a 30-second
deadline and writes either [Node results](./node-results.json) or
[Electron results](./electron-results.json).

The loader reads the actual five source modules, verifies their fixed hashes,
reverses only the three copy calls/imports in memory for the baseline, and
verifies the resulting baseline hashes. All evaluated module and bundle hashes
are recorded. It needs no Git history, absolute development paths, or ignored
notes. CRLF source text is normalized before hashing. The parsers and flag
parser match `v1.4.198`; all five modules match the pre-extension topic
`8d599520e44654a5c28e9930e3070c00d6499931`, except for these copy calls. This
tests current dependencies and the selected source modules, not a historical
application binary. See [source versions](./source-versions.json).

Each runtime checks 42 bounded heap cases: baseline, fixed Buffer copier, and
fixed Bufferless copier; kitty live/replay, mouse live; 32 distinct 64-Ki-character
inputs and eight 4-Mi-character inputs; short, complete, oversized, and C1-CSI
tail controls. Completion must reconstruct the correct modes and release the
large backing strings. Additional controls preserve replay push idempotence,
the 16-frame live stack cap, alternate-screen state, snapshot unknownness,
mouse encodings, and RIS with a trailing partial sequence.

Both runtimes pass all 42 cases. Representative live-path heap deltas in bytes:

| Runtime               | Parser | Input × owners |   Baseline | Buffer copy | Bufferless copy |
| --------------------- | ------ | -------------- | ---------: | ----------: | --------------: |
| Node 26               | Kitty  | 64 Ki × 32     |  2,120,952 |      18,376 |           9,480 |
| Node 26               | Mouse  | 64 Ki × 32     |  2,111,984 |      15,112 |           9,336 |
| Node 26               | Kitty  | 4 Mi × 8       | 33,557,944 |       3,448 |           3,448 |
| Node 26               | Mouse  | 4 Mi × 8       | 33,557,072 |       1,312 |           1,312 |
| Electron 43 / Node 24 | Kitty  | 64 Ki × 32     |  2,111,864 |      12,244 |           5,192 |
| Electron 43 / Node 24 | Mouse  | 64 Ki × 32     |  2,103,444 |      14,432 |           8,004 |
| Electron 43 / Node 24 | Kitty  | 4 Mi × 8       | 33,556,316 |       1,884 |           2,604 |
| Electron 43 / Node 24 | Mouse  | 4 Mi × 8       | 33,556,172 |         776 |             752 |

Heap readings include owner overhead and follow forced GC. The harness clears
V8's last successful regexp input identically in baseline and fixed cases to
isolate per-owner storage. That independent process-wide regexp reference can
keep a most-recent input alive until another successful match; this change does
not eliminate it. The Bufferless selection is memoized while Buffer is absent,
then Buffer is restored before measuring; it exercises the actual renderer
fallback without running a browser renderer.

Two permanent kitty heap regressions fail before the correction at 33,560,832
and 33,575,040 retained bytes against a 2-MiB limit. They also verify that the
retained prefix completes correctly and that replay/pop/snapshot state remains
valid. Existing parser and copier tests provide the wider protocol controls.
The two mouse regressions likewise fail before the correction at 33,559,240 and
33,573,200 bytes, and pass afterward with both CSI encodings. The five-suite
run passes 98 tests, including actual headless-emulator mode snapshots; Node
and renderer TypeScript checks pass.

## Callers and lifetime

- Kitty renderer panes create or reuse one tracker per pane in
  `connect-pane-pty.ts:160`. `write-pty-output-to-xterm.ts:23` feeds application
  output; `apply-reattach-payload.ts` and `hidden-output-seq-and-skip.ts` feed
  replay. Fresh spawn and exit reset it, and
  `terminal-pane-pane-closed.ts:69` deletes the map entry. Dashboard previews
  own another tracker per effect (`AgentTerminalPreview.tsx:116`); cleanup
  removes its listeners and disposes its terminal.
- Main's `orca-runtime-capture-provider-terminal-buffer.ts:23` registers
  temporary live scanners during provider snapshot acquisition and removes
  them in `finally`. It creates a persistent tracker only after observing an
  alternate-screen transition (`:48–57`). `orca-runtime-on-pty-data.ts:30`
  feeds those trackers before later output processing. Exit, floating PTY
  liveness cleanup, and provider generation reset delete the persistent entry.
- The daemon does not directly instantiate the kitty tracker, despite its
  old class comment: its kitty flags come from xterm. No mobile bundle imports
  this class. Mobile can exercise main-side snapshot acquisition; SSH output
  can reach main and renderer trackers through the existing provider routes.
- Mouse mirrors are owned by `HeadlessEmulator` (`headless-emulator.ts:59`).
  Async writes scan after xterm parses the data (`:190`); synchronous live and
  cold-restore writes scan at `:224`. Both daemon sessions and main's headless
  projections use this emulator. It therefore also covers local/remote host
  emulators serving mobile clients. Emulator disposal stops future writes;
  eventual owner release removes the mirror. Completing/replacing its tail
  also releases the old backing string. No ownership or shutdown rule changes.

## Scope and limits

This is a per-owner last-input cost. It does not grow indefinitely with a fixed
set of parsers and bounded input chunks, and further output often completes or
replaces the tail. Multiple readers of the same input can share its backing
storage; do not sum their measurements as independent process memory.

Ordinary daemon bulk frames delivered to main are at most 64 Ki characters
(`daemon-stream-data-batcher.ts:35`), and ordinary relay output slices are
16 Ki characters (`relay/pty-handler.ts:343`). Mouse scanning inside the daemon
happens before outgoing stream framing. The 64-Ki cases demonstrate the issue
at a normal main-input bound; the 4-Mi cases amplify the mechanism, not a claim
that ordinary native reads or daemon frames have that size. Replay inputs and
transformed streams follow their own existing limits. No network, application
renderer, operating-system PTY, or incident heap was used in this proof.

This reduces retained output in local and SSH paths without changing published
terminal content. It neither establishes the trigger in #19831/#19768 nor
explains a reported sustained growth rate or multi-gigabyte incident by itself.
