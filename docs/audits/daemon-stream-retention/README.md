# Daemon stream retention reproduction

Run from the worktree root after installing dependencies:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/daemon-stream-retention/reproduce.mjs
```

The script bundles the current `DaemonStreamDataBatcher` with esbuild, then uses real loopback TCP sockets. It pauses the reader, feeds at most 8 MiB, honors the producer-pause callback, resumes the reader, and closes every socket in `finally`. It starts no PTY, agent, or application window. Output includes the bundle hash, queued payload sizes, RSS, and drain outcome.

Visible 64 KiB and 1 KiB producers should pause within the backlog budget and resume after both queues drain. A hidden 1 KiB producer should keep running while the existing keep-tail policy bounds its held output. RSS includes allocator/GC timing; queue measurements are the direct evidence.

`after.json` records a historical fixed run under Node v26.6.0: the visible bulk producer paused after 2,686,976 characters with 131,300 socket bytes and 2,031,616 held characters; the visible small-write producer paused with 3,401,200 socket bytes. The hidden producer processed all 8 MiB with 131,300 socket bytes and 667,648 held characters. Every case resumed and drained both queues to zero.

## Preserved measurements before the fix

`before-1mib-chunks.json` and `before-64kib-chunks.json` were captured before adding producer backpressure, with a real paused reader and 96 MiB of input. The latter includes the original compiled bundle hash and a hidden-session comparison.

| Input  | Socket buffered bytes | Held characters |
| ------ | --------------------: | --------------: |
| 32 MiB |               131,321 |      32,636,928 |
| 64 MiB |            32,809,583 |      33,554,432 |
| 96 MiB |            66,406,511 |      33,554,432 |

The last 32 MiB retained another 33,596,928 queued payload bytes. The held queue plateaued at 32 MiB while the socket queue grew at 1.00127 bytes per produced ASCII byte. Resuming the reader drained both queues in 74 ms. Sampled RSS reached 1.38 GB with 64 KiB chunks; this includes string coalescing/slicing and GC effects.

The original measurement used Node v26.6.0 on macOS; the current reproduction records its runtime and should be run on the supported Node 24 toolchain. The historical build command was:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/daemon-stream-retention/reproduce.mjs
```

This proves a current stalled-consumer retaining path. It does not attribute issue #19831's whole-system memory total to this path; that report lacks per-process measurements.
