# Plugin worker output retention

The worker output parser capped a line at 8,192 code units, but retained slices could keep a much larger decoded input chunk alive. This artifact reproduces two ownership paths using the actual parser and actual `PluginLogBuffer`:

1. An unfinished line stays in the stream listener's buffer.
2. A completed short or truncated line stays in the service's 200-entry log ring.

The fix uses the existing `ownRetainedString` copier for incomplete segments retained across callbacks and for the bounded string passed to the log sink. Line contents, truncation, callback invocation, ring capacity, and worker lifecycle are unchanged. Strings shorter than 13 code units keep the helper's existing fast path.

## Production reachability and lifetime

- `src/main/plugins/plugin-host-process.ts` installs the parser on child stdout and stderr at lines 101–102, with UTF-8 decoding in the parser. The production sink passes through `plugin-worker-manager.ts:148` and `plugin-service.ts:94` to `plugin-log-buffer.ts:14`, which stores the original string without copying it.
- The parser retains at most one incomplete line per stream. The default five active workers allow ten live stdout/stderr buffers. Worker slots are acquired before startup. Idle workers are reaped after five minutes, checked every minute; stream end clears parser buffering.
- The log ring belongs to the long-lived `PluginService`, not the worker. Worker exit and stream end preserve its last 200 entries per plugin. Ring eviction releases the entries. Several lines can share one parent; the backing allocation must be counted once.
- This is a main-process plugin path. The plugin-system setting gates activation (`src/main/startup/main-process-plugins.ts:59–62`). It is not a terminal daemon or renderer retention path. The plugin `orca.log` IPC message is a separate producer.
- `PluginService.getLogs` and its IPC handler expose the existing ring. Reading or serializing a concatenated string can flatten it and shorten its parent retention, but does not remove the service's ring entries.

## Reproduce

From the repository root with the project's dependencies installed:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=192 docs/audits/plugin-worker-output-retention/reproduce.cjs
```

For Electron, run the installed Electron executable with `ELECTRON_RUN_AS_NODE=1`, `ORCA_BACKGROUND_LAUNCH=1`, and the same arguments. This uses Node mode without opening an app window. For example, on macOS:

```sh
ORCA_BACKGROUND_LAUNCH=1 ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --expose-gc --max-old-space-size=192 docs/audits/plugin-worker-output-retention/reproduce.cjs
```

The runner writes `node-results.json` or `electron-results.json` beside itself. Pass `--output <path>` to preserve the captured reports. It uses inert PassThrough streams, no OS child process or network, a 192 MiB heap limit, and a 30-second deadline.

`sources.cjs` reverses `fix.patch` in memory and checks exact baseline/fixed parser hashes. It also checks eight dependency/caller hashes and records actual evaluated source and bundle hashes. No source files are overwritten. A synthetic CRLF read control checks all ten source/patch reads.

`source-versions.json` records identical parser, sink, caller, and helper hashes at main checkpoint `291b4ddd6f1c1af480169885e0fda7f9c78ff053`, main `f78483ec29891ab11f49bb25e6cd628837b1242e`, and the #20960 topic `np-oom-scan-retained-text-slices` at `0d2efbc0d3b4f902b9bc02f5451c6ff4291405cf`. The parser, sink and caller modules also match v1.4.198 (`e0826956fcfc532f5a1e55b5e081f2e57e553c43`), which lacks the newer `own-retained-string.ts` wrapper. The baseline bundle uses only the unchanged parser and ring; fixed variants use the recorded publication helper. These are source controls with current build dependencies, not a historical app binary.

## Controls and results

Both Node 26.6 and Electron 43.7 / Node 24.21 pass 24 cases: baseline, diagnostic tail-only copy, fixed Buffer copy, and fixed code-unit-copy fallback, each with two input sizes and three ownership cases. The fallback is a shared-helper compatibility control; production main normally has Buffer.

| Retained owner                                  | Baseline heap delta | Fixed heap delta |
| ----------------------------------------------- | ------------------: | ---------------: |
| Ten unfinished tails, 64 KiB input each         |        0.72–0.73 MB |          9–24 KB |
| Eight unfinished tails, 4 MiB input each        |      33.56–33.57 MB |          6–11 KB |
| 200 short log rows from 205 × 64 KiB inputs     |      13.14–13.16 MB |         27–45 KB |
| 200 truncated log rows from 205 × 64 KiB inputs |      13.14–13.15 MB |     3.29–3.31 MB |
| Eight short log rows, 4 MiB input each          |            33.56 MB |       about 1 KB |
| Eight truncated log rows, 4 MiB input each      |            33.56 MB |       128–132 KB |

Heap deltas include GC noise. Truncated strings legitimately retain 8,192 code units, including the non-ASCII truncation suffix. Tail-only copying fixes unfinished buffers but leaves both log-ring paths. Stream end clears no-op-sink tails while the actual ring remains live; replacing all 200 entries releases the original parents.

64 KiB is an ordinary-scale stdio input control. The 4 MiB input is amplified stress, not a claim about normal OS pipe reads. PassThrough delivers the selected chunk intact; real child-pipe chunk sizes depend on runtime and OS. Retention is bounded by owner count, ring capacity and backing input size; this is not an unbounded line queue.

Behavior comparisons cover blank and split lines, null/empty streams, CRLF, end flushing, discard/resume after overflow, log level, exact ring content, NUL, lone surrogates, emoji, and the code-unit limit. Value comparisons run separately from heap controls because comparing concatenated strings can flatten them and change retention.

## Validation

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config config/vitest.config.ts src/main/plugins/plugin-worker-output-retention.test.ts src/main/plugins/plugin-worker-output-buffer.test.ts src/main/plugins/plugin-host-process.test.ts src/shared/own-retained-string.test.ts
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config docs/audits/plugin-worker-output-retention/before.config.mjs src/main/plugins/plugin-worker-output-retention.test.ts src/main/plugins/plugin-worker-output-buffer.test.ts
ORCA_BACKGROUND_LAUNCH=1 pnpm tc:node
```

The fixed source passes 20 tests. The baseline overlay intentionally fails all three new heap regressions: approximately 33.6 MB for unfinished tails and 13.2 MB for each ring case, against 2 MiB and 5 MiB ceilings; its original behavior test passes. Node typecheck passes. All five changed-quality scan configurations pass over all five product/test/artifact code files with `--no-ignore --deny-warnings`, including the ordinary and type-aware lint rules.

This proves a reachable code mechanism and its repair. It does not establish affected-host plugin use, output cadence, aggregate app RSS, or attribution to #19831 or another incident.
