# Native chat tool pairing

Latest follow-up: [mobile row identity](./mobile-row-identity.md) keeps an opened detail with its command after earlier rows disappear or move.

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
  ORCA_BACKGROUND_LAUNCH=1 node config/scripts/native-chat-tool-pairing-benchmark.mjs
```

[benchmark.json](./benchmark.json) records eight counterbalanced sample pairs
per workload, source bundle hashes, raw timings, and correctness checks. It
includes immediate pairs, reverse completion, positional FIFO, duplicate IDs,
silent-call backlogs, unmatched results, and finite limits at seven sizes.
At 2,048 calls, reverse completion improved from 7.46 ms to 0.163 ms, a
silent-call backlog from 13.02 ms to 0.244 ms, and immediate ordered pairs from
92.0 microseconds to 47.3 microseconds. Single-call backlog/missing workloads
remain within 11 ns of the baseline. These timings cover the shared pairing
function, not React, DOM, transport, or the full transcript projection. These
measurements identify the earlier matcher revision in the artifact. Later orphan
projection, journal import, and discarded-wrapper allocation changes are outside
this benchmark's scope.

The deterministic contract runs in `pnpm test:perf:contracts`. Broader coverage
uses the shared/native-chat and renderer/native-chat suites, provider transcript
reader suites, and `tests/e2e/native-chat-tool-pairing.spec.ts` for hidden
Electron rendering and output ownership.

## Full folding, allocation, and mobile disclosure

The later allocation fix reuses the same matcher for folding attribution without
collecting pair wrappers that folding immediately discarded. Consumer pairing
still returns fresh wrappers with the original call/result references. No cache,
parallel matcher, or ownership fallback was added.

Run the three-version production-module benchmark and its retained-allocation
control with:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc config/scripts/native-chat-fold-benchmark.mjs --memory-control
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc config/scripts/native-chat-fold-benchmark.mjs
```

[full-fold-benchmark.json](./full-fold-benchmark.json) compares original
`51e7181850b`, published `b1e44269d655`, and the measured worktree. It records
54 cases across three sizes, six workloads, and full folding, settled desktop
projection plus all-row render-data pairing, and repeated folding. Each
comparison uses six counterbalanced sample pairs; the table uses raw-sample
medians because the artifact's rounded summary loses microsecond precision.
The two comparisons have separate current samples.

| All-row projection and pairing                     | Original → current               | Published → current |
| -------------------------------------------------- | -------------------------------- | ------------------- |
| 8,192 reverse completions                          | 320.4727 → 3.7358 ms, about 86×  | 3.5954 → 3.6126 ms  |
| 8,192 silent calls plus 8,192 later answered calls | 558.9641 → 5.5075 ms, about 101× | 5.5551 → 5.2629 ms  |
| 8,192 immediate ordered pairs                      | 2.4124 → 2.5636 ms               | 2.6577 → 2.3606 ms  |

These are large adversarial-run gains, not a general frame-time improvement.
At 32 immediate pairs, the original/current pipeline medians were 11.38 and
16.74 microseconds: roughly 5.4 microseconds of extra work. The separate
published/current comparison measured 15.60 and 13.10 microseconds. Original
folding and refolding alone were faster than the ownership-preserving fold:
for the large silent backlog, folding rose from 1.1191 to 2.6317 ms and refolding
from 0.3171 to 1.4090 ms. The expensive original consumer scan dominates the
large named-result cases. Full folding still visits the collection on updates;
settled row reuse does not make the fold incremental.

Against published C, the large fold medians fell approximately 3–9%; whole
pipeline changes varied, including the small reverse-case increase above.
The deterministic allocation gain is clearer: large silent-backlog folding
collects zero discarded pair wrappers instead of 16,384, while consumer pairing
retains the required 16,384. Its median pre-GC heap delta fell from 8.23 to
6.84 MB; retained output stayed near 0.23 MB. Named orphan conservation,
original block references, unique row IDs, and repeated-fold identity are
checked for published/current outputs, which are deeply equal for every
workload. Original output counts expose historical drops or guessed ownership;
those cases do not provide equivalent visible-output timing comparisons.

Preserving separately sourced orphan evidence still costs rows and memory.
With 8,192 singleton orphan outputs, current folding retains roughly 2.61 MB
versus the original's 0.15 MB; fresh all-open projection and pairing retain
about 9.23 MB versus 0.33 MB. Published/current retention is essentially the
same. The original grouped these outputs with unrelated calls. Desktop
windowing normally mounts only viewport rows, while this consumer benchmark
processes every run as opened. It excludes React commits, DOM layout, mobile
runtime, and transport latency.

[full-fold-memory-control.json](./full-fold-memory-control.json) confirms that
the sampling method retains a live million-slot array at about 8 MB. Each
memory sample releases its preceding output, holds the current output through
forced GC, and excludes shared source inputs. Projection memory uses a fresh
projector/cache; timing reuses a settled projector. Pre-GC deltas indicate
allocation pressure, not peak memory or total allocated bytes. Negative
retained deltas are noise, not savings or per-update growth.
[full-fold-benchmark-receipt.json](./full-fold-benchmark-receipt.json) records
commands, source/tool hashes, and the post-main-merge graph review. Only three
account-startup enum/map modules changed after measurement; those branches are
absent from the benchmark fixtures, so no new timing claim is made for them.

Mobile previously exposed only six tool rows with no way to reach later
outputs. The existing disclosure now reveals six more rows per request and can
collapse back to six. A closed run performs no pairing; an opened run collects
only the requested prefix plus one sentinel to decide whether Show more is
available. This limits wrapper and mounted-row retention, while matching may
still scan a pending suffix to find the requested owners. Long runs require
multiple reveals, and expanding them mounts more rows at the user's request.
Result-only summaries use the existing Result label without inventing a call
count. Local mobile stream and SSH-authoritative handler tests cover late named
completion, orphan reachability, cursor paging, and older-host no-cursor
replacement. They establish ownership and paging behavior, not network latency.

## Rendered verification

The rebuilt Electron app passed the dedicated E2E test through the real Claude
JSONL reader: three reverse completions behind 32 silent calls, an unrelated
result, and successful/failed task updates. The [inspected screenshot](https://github.com/user-attachments/assets/79f41dc6-8ec8-4f12-8e89-e4d7ec4b5daa)
shows all three outputs attached to their commands, the accepted pending task,
and the unrelated output under its own Result summary and row.
[rendered-validation.json](./rendered-validation.json) records the
commands, test source hash, exact worktree identity, hidden/unfocused native
window assertions, and process cleanup. The fixture uses synthetic Claude
JSONL through the production reader and real UI clicks. This is desktop
correctness evidence; it does not exercise an actual provider CLI or adoption
launch, measure mobile rendering, or measure SSH transport latency.

The mobile component check uses the actual React Native Web primitives and
production message/fold modules under the shipped browser build options and
shell content-security policy. The [before capture](https://github.com/user-attachments/assets/6b6b30f1-58f0-4bc7-8149-6f2169a368b2)
shows six orphan results with no way to reveal later rows. The [after capture](https://github.com/user-attachments/assets/81241691-0dfe-4a88-b3d1-bdf7e8d02adc)
shows all eight Result rows and the seventh output's full body. Real clicks on
Show more and Show less reveal and hide those rows. Further captures show
[reversed named outputs and a separate orphan](https://github.com/user-attachments/assets/26e0559f-3f0c-482e-9ef2-f32903466c82)
and [a named completion after seventeen silent calls](https://github.com/user-attachments/assets/69b1e49b-0627-40b3-977d-052b885beef6).
[mobile-rendered-validation.json](./mobile-rendered-validation.json) records
row-specific full-body assertions, source and bundle hashes, the one-component
historical overlay, and exact headless-browser cleanup. This proves mobile web
component disclosure and ownership; it does not exercise a native phone, the
full session route, provider decoding, adoption, or transport.

The [before screenshot](https://github.com/user-attachments/assets/b9f84d6e-a786-42d5-b895-8a4319f972cd) shows the unrelated result and named outputs attached to silent calls, and the failed task replacing the accepted task. The [before validation record](./before-validation.json) identifies the three modules restored from `51e7181850b`: `native-chat-tool-fold.ts`, `transcript-record-blocks.ts`, and `transcript-line-decoders-codex.ts`. Other app code, including the hidden launch policy, stayed current. This proves the original folding/decoder defect, rather than a full historical app build. Each of the three overlaid source files was restored byte for byte and the owned app process exited. Images are uploaded attachments, not committed binaries.
