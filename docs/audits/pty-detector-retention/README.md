# Retained PTY detector input

The advertised-URL watcher keeps a 4,096-character carry for each bound PTY and
16,384 characters for each of at most 32 unbound PTYs. The Command Code status
detector keeps 300 characters before its agent-specific prefilter, including for
ordinary shell, Claude, and Codex output. Each could keep the whole original
input alive through a V8 sliced string.

The fix uses the existing `ownRetainedString` copier when dropping oversized
input. It preserves URL reconstruction, status detection, UTF-16 code units,
binding/unbinding, cache limits, and remote/local authority. These are three
additional boundaries in [#20960](https://github.com/stablyai/orca/pull/20960).

## Reproduce

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc docs/audits/pty-detector-retention/reproduce.mjs
```

The script bundles the actual detector and watcher. The baseline removes only
the three copy calls in memory. Each input has its own live owner; URL cases
use separate watcher instances to isolate each carry. Heap is measured after
GC, before completing the partial URLs and verifying cleanup. Results include
owner overhead, not just text. [Bundle hashes and measurements](./results.json).

| Case                |  Input per owner | Owners | Heap before | Heap after |
| ------------------- | ---------------: | -----: | ----------: | ---------: |
| Status detector     | 64 Ki characters |     32 |   2,112,688 |     41,400 |
| Bound URL carry     | 64 Ki characters |     32 |   2,173,848 |    204,112 |
| URL pending binding | 64 Ki characters |     32 |   2,148,824 |    575,512 |
| Status detector     |  4 Mi characters |      8 |  33,557,144 |      6,504 |
| Bound URL carry     |  4 Mi characters |      8 |  33,569,168 |     47,112 |
| URL pending binding |  4 Mi characters |      8 |  33,568,936 |    144,504 |

Captured with Node v26.6.0 on macOS. Three GC regression tests failed before the
fix, retaining about 32 MiB each, and pass afterward. The five-suite run passes
164 tests including existing URL/status behavior and copier Unicode/fallback
tests.

## Scope and limits

Main feeds both observers before renderer batching. Default daemon bulk output
frames are at most 64 Ki UTF-16 characters; main's later 16 Ki-character batching
does not bound these readers. The 4 Mi-character cases demonstrate the retaining
mechanism under larger inputs, not normal daemon frame size. Both implementations
also exist in `v1.4.198`.

Transformed frames bypass ordinary chunk slicing but still face the daemon's
16 MiB encoded-line limit. Native fallback output has no application chunk cap;
this audit does not establish multi-MiB native reads. Ordinary relay chunks are
16 Ki characters. The actual main feed is `orca-runtime-on-pty-data.ts` and the
ordinary daemon bound is in `daemon-stream-data-batcher.ts`.

These are per-owner last-input costs, not unbounded growth for a fixed set of
PTYs and fixed-size frames. Owners consuming the same input can share the same
backing string, so the three measurements must not be added as independent
process costs. Unbind removes URL buffers and pending entries. This improves
memory proportional to active owners; it does not establish the cause or growth
rate of #19831 or #19768. Copy work is bounded by the small retained tails.
