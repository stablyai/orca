# Native chat tool pairing

Long tool runs repeatedly scanned all unanswered calls to find each named result.
Calls that emitted no output stayed at the front of that scan. Positional results
also shifted the remaining pending-call array after every answer.

The shared matcher now uses a linked FIFO and builds an ID index only when a
named answer needs to match beyond its head. That index stays valid until the
pending queue empties. Named and unnamed answers remove a pending call without
array movement; each call enters the index at most once. Duplicate IDs retain
FIFO order. Existing pair limits and output references are preserved.
The implementation remains shared by desktop, mobile, and host readers.

The rendered check exposed related correctness defects: Claude and Codex
transcript decoders discarded result IDs, and folding used only call counts to
assign results. Decoders now retain the optional provider ID; folding uses
the canonical matcher and occurrence indices, so an unrelated result cannot
consume another call's answer. Unmatched named results stay visible separately
and cannot acquire a guessed owner during later folds. Results without IDs
remain positional; already imported calls missing IDs cannot own named results.

Legacy journal import also preserves IDs on singleton calls and keeps singleton
results as result messages. The focused importer/projector regression test
covers reverse batched results, mixed record shapes, duplicate IDs, anonymous
FIFO, and old persisted calls whose IDs were already lost. That integration
coverage is separate from the rendered transcript fixture below.

## Reproduction and measurements

Baseline: `51e7181850b`. At 2,048 calls, the regression tests measured 2,098,176
ID reads for reverse completions, 4,194,304 reads for silent-call backlogs and
unmatched results, and 2,096,128 moved array slots for FIFO completions. The
fixed implementation passes linear operation budgets at 64, 512, and 2,048
calls. Semantic differential tests preserve call/result references across
mixed IDs, interleavings, immutable inputs, and unusual limits.

Run the production benchmark with the original module on stdin:

```sh
git show 51e7181850b:src/shared/native-chat-tool-fold.ts |
  node config/scripts/native-chat-tool-pairing-benchmark.mjs
```

[benchmark.json](./benchmark.json) records eight counterbalanced sample pairs
per workload, source bundle hashes, raw timings, and correctness checks. It
includes immediate pairs, reverse completion, positional FIFO, duplicate IDs,
silent-call backlogs, unmatched results, and finite limits at seven sizes.
At 2,048 calls, reverse completion improved from 7.46 ms to 0.163 ms, a
silent-call backlog from 13.02 ms to 0.244 ms, and immediate ordered pairs from
92.0 microseconds to 47.3 microseconds. Single-call backlog/missing workloads
remain within 11 ns of the baseline. These timings cover the shared pairing
function, not React, DOM, transport, or the full transcript projection. The
pairing source is unchanged since these measurements; the subsequent orphan
projection and journal import fixes are outside this benchmark's scope.

The deterministic contract runs in `pnpm test:perf:contracts`. Broader coverage
uses the shared/native-chat and renderer/native-chat suites, provider transcript
reader suites, and `tests/e2e/native-chat-tool-pairing.spec.ts` for hidden
Electron rendering and output ownership.

## Rendered verification

The rebuilt Electron app passed the dedicated E2E test through the real Claude
JSONL reader: three reverse completions behind 32 silent calls, an unrelated
result, and successful/failed task updates. The [inspected screenshot](https://github.com/user-attachments/assets/4f84dcf5-10e5-4521-b435-a23878e14d73)
shows all three outputs attached to their commands, the accepted pending task,
and the unrelated output under its own Result summary and row.
[rendered-validation.json](./rendered-validation.json) records the
commands, test source hash, exact worktree identity, hidden/unfocused native
window assertions, and process cleanup. The fixture uses synthetic Claude
JSONL through the production reader and real UI clicks. This is desktop
correctness evidence; it does not exercise an actual provider CLI or adoption
launch, measure mobile rendering, or measure SSH transport latency.

The [before screenshot](https://github.com/user-attachments/assets/b9f84d6e-a786-42d5-b895-8a4319f972cd) shows the unrelated result and named outputs attached to silent calls, and the failed task replacing the accepted task. The [before validation record](./before-validation.json) identifies the three modules restored from `51e7181850b`: `native-chat-tool-fold.ts`, `transcript-record-blocks.ts`, and `transcript-line-decoders-codex.ts`. Other app code, including the hidden launch policy, stayed current. This proves the original folding/decoder defect, rather than a full historical app build. Each of the three overlaid source files was restored byte for byte and the owned app process exited. Images are uploaded attachments, not committed binaries.
