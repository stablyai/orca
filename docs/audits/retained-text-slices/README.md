# Retained CI and terminal text tails

Capped V8 string slices can keep their entire original input alive. The affected
CI excerpt cache accepts 128 entries of 16 KiB text, from downloads up to 64 MiB.
GitLab's raw-trace clamp reaches the same shared excerpt function. Terminal
session/eager/shutdown buffers, deferred reattach queues, recent-output buffers,
and error surfaces also retained oversized parents despite their logical caps.

The fix reuses the existing shared `ownRetainedString` copier for CI, persisted
session tails, and main/relay recent output. Renderer queues and errors reuse
their existing `flattenRetainedSlice` helper. Content, Unicode, earlier-error
selection, cache counts, and transport payloads stay identical. Ordinary
untruncated terminal chunks keep their existing path. Main/relay recent output
preserves chunk boundaries for path-candidate backfill.

Local persisted scrollback is already pruned; the session-buffer fix primarily
covers remote or not-yet-classified owners. Queue and error fixes cover local
and remote output. The main/relay recent-output buffer has a configurable cap,
64 Ki characters by default.

## Reproduce

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc docs/audits/retained-text-slices/reproduce.mjs
```

The script bundles actual production functions. Its baseline removes only the
six new copy boundaries in memory; production files are not changed. Each case
retains eight distinct inputs: 2 Mi characters per CI log and 4 Mi characters
per terminal input. It measures heap after GC and clears V8's independent legacy
RegExp input reference. Bundle hashes and measurements are in
[results.json](./results.json).

| Case                             | Returned bytes, all eight | Retained heap before |     After |
| -------------------------------- | ------------------------: | -------------------: | --------: |
| GitHub long line                 |                   131,072 |           16,787,512 |   145,224 |
| GitHub earlier Unicode error     |                   131,064 |           33,577,840 |   112,744 |
| GitLab long line                 |                   131,072 |           16,793,640 |   147,312 |
| Persisted terminal buffers       |                 4,194,304 |           33,555,624 | 4,195,032 |
| Eager/pre-handler/shutdown tails |                 4,194,304 |           33,556,040 | 4,202,608 |
| Main/relay recent output         |                   524,288 |           33,558,752 |   527,384 |
| Terminal error surfaces          |                    32,000 |           33,555,864 |    33,336 |
| Deferred reattach tails          |                 4,194,304 |           33,565,384 | 4,198,352 |

Captured on macOS with Node v26.6.0. Heap samples include allocator/GC variation;
the large separation is the relevant result. Regression tests also retain the
actual error state and shutdown/reattach/recent-output queue objects.

Validation passed: 41 tests across six CI/provider/helper suites; 69 tests across
six terminal storage/ownership/UTF-8 suites; 28 tests across three error/reattach
suites; and a final 63 tests across seven recent-output/CI/terminal/copier suites.
These are per-run counts and overlap. Full typecheck and changed-code quality pass.

All six cap/slice paths exist in `v1.4.198`. Neither #19831 nor #19768 establishes
the CI-log viewing or oversized terminal inputs required for incident attribution.
Copying costs scale with retained caps: 16 KiB per CI excerpt, 4,000 characters
per error, 512 KiB for the largest byte-capped buffer, and 512 Ki characters for
deferred reattach. The change does not reduce temporary original-input allocation.

The follow-up [PTY detector reproduction](../pty-detector-retention/README.md)
adds three boundaries in the same PR: advertised-URL carries, output waiting for
workspace binding, and Command Code status carries used by ordinary PTYs too.
Thirty-two production-sized 64 Ki-character inputs retain about 2.1 MB in each
isolated baseline. Owned carries reduce that to about 41 KB, 204 KB, or 575 KB,
including the different owner objects. These per-owner costs are not an
unbounded growth curve, and readers of the same input can share its parent.
The follow-up adds 164 passing tests across five detector/URL/copier suites.

The [Claude task metadata reproduction](../claude-task-retention/README.md) adds
the shared 512-character description/name boundary. JSON-parsed task frames
retained their parents in the actual live, settled, and recently removed tracker
entries. Eight 4 Mi-character inputs retained about 32 MiB before the copy and
7–12 KB afterward; 32 smaller 64 Ki-character inputs retained about 2.1 MB before
and 25–45 KB afterward. These synthetic fields establish a retaining mechanism,
not the trigger of a reported incident.
