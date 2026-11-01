# Speech worker audio admission budget

When native speech recognition stops consuming input, `SttService.feedAudio` previously kept transferring microphone buffers into the worker's message queue. The worker can retain those buffers outside the main isolate's JavaScript heap. This artifact demonstrates that queue and its new admission limit using real Node Workers and actual service/worker code. The native recognizer is a controlled stalled substitute; no speech model, app window, network call or intentional OOM is used.

## Result and new policy

Pending worker audio now has an **8 MiB backing-storage limit and a 1,024-frame limit per service**, aggregated across current and predecessor workers. These are new decode-queue overload policies. The byte amount matches the existing renderer startup buffer allowance; its tail-shedding behavior is not reused. The frame limit covers many tiny messages. Normal desktop frames contain 4,096 Float32 samples, so the byte limit wins after 512 frames.

Admission checks happen before transfer. Overflow starts the existing owner-fenced stop and reports an explicit recognizer-overload error through the existing speech event path. Desktop displays the error and stops capture. Mobile records it and returns it on the next chunk or finish, invoking its existing failure/cancel handling. Already accepted audio stays ordered ahead of the stop frame and drains if recognition recovers. Continuing after unnoticed dropped audio is not the overload behavior.

| Stalled input                                     |        Original service |          Fixed service |
| ------------------------------------------------- | ----------------------: | ---------------------: |
| 1,024 attempted normal frames                     | 1,024 admitted / 16 MiB |   512 admitted / 8 MiB |
| 2,048 attempted one-sample frames                 |  2,048 admitted / 8 KiB | 1,024 admitted / 4 KiB |
| Error before explicit user stop                   |                    None |     One overload error |
| Previously admitted frames consumed after release |                     All |                    All |
| Warm worker reuse after stop                      |                Succeeds |               Succeeds |

`results.json` and `electron-results.json` contain all six original/fixed cases, including a controlled native error that still consumes acknowledgment credit and finishes stopping. Fixed byte/frame counters return to zero; the actual worker is reused successfully, then explicitly terminated with no remaining accounting owner.

## Ownership and acknowledgment

- Charge the actual transferred **backing allocation**, including storage outside a subarray view. Empty audio is omitted without transferring its backing storage. Cloud transcription uses its existing separate path.
- The worker acknowledges cumulative byte and frame end positions in a `finally` around actual feed processing, including errors and early returns. Main keeps one scalar record per worker, not a callback or record per frame.
- Watermarks remain monotonic across warm reuse. Older, duplicate, out-of-range and noninteger acknowledgments do not release credit. Another worker cannot acknowledge predecessor debt. The internal worker echoes host-issued positions in processing order; it is not a remote client input.
- `postMessage` failure before transfer rolls back credit. A detached backing buffer remains charged conservatively if posting were to throw after transfer.
- Old debt remains charged after an active-worker field is cleared or stop times out. Existing termination calls restore accounting listeners after lifecycle cleanup and release credit only on actual exit or fulfilled termination. Failure to terminate does not prove the queued buffers were released.
- Overflow initializes the stop before invoking the error sink, so a synchronous error callback cannot feed more audio or post a second stop. Internal consumed events never reach speech UI consumers.

The host still replies to chunk RPCs immediately. No preload, paired RPC or SSH wire change is introduced; only the host's bundled worker exchanges the added internal acknowledgment. Speech routing, owner matching and folder/worktree scope remain unchanged.

## Reproduce and validate

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc docs/audits/speech-worker-audio-budget/reproduce.cjs
ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/speech/stt-audio-pending-budget.test.ts src/main/speech/stt-worker-audio-ack.test.ts src/main/speech/stt-service.test.ts src/main/speech/stt-worker.test.ts src/main/ipc/speech.test.ts src/main/runtime/rpc/methods/speech.test.ts
```

The runner reverses only `fix.patch` in memory and verifies original hashes. The fixed phase builds the unmodified current source. Both phases use actual service/start/stop/state/listener/worker implementations; model manifest/path and constructor data are fixture ports. The constructor still starts real Node Workers. A fake native function blocks the first frame on a shared semaphore for at most ten seconds; the runner releases it after sampling the queue. First/last sample values and total samples verify every admitted frame in order. Temporary bundles are created outside the checkout, normal `require` loads them, and worker termination plus temporary-file cleanup are awaited.

The **51 focused source tests** include fifteen new controls for full backing sizes, frame limits, empty audio, warm reuse, duplicate/stale acknowledgments, wrong-worker events, timeout/replacement debt, successful and failed termination, reentrant error callbacks, failed posts, owner mismatch and cloud isolation. A permanent real-worker regression checks acknowledgments for successful processing, native failure and an early return before initialization. The artifact additionally proves normal drain/reuse behavior.

For the installed macOS Electron runtime without launching the app:

```sh
ELECTRON_RUN_AS_NODE=1 ORCA_BACKGROUND_LAUNCH=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --expose-gc docs/audits/speech-worker-audio-budget/reproduce.cjs docs/audits/speech-worker-audio-budget/electron-results.json
```

The runner is portable; that executable path is platform-specific. Reports record runtime and source/proof hashes. The installed Electron Node 24 run is compatibility evidence, not a historical packaged-binary reproduction. RSS observations are supplementary: phases run sequentially and allocator reuse can make later deltas small. No peak or plateau is inferred from those samples.

## Limits and attribution

This bounds pending transferred audio and message count. It does **not** bound native model allocations, recognition scratch buffers, renderer-to-main IPC queues, or whole-process memory. A blocking native call may delay worker termination. Existing startup behavior permits a replacement model after a stop timeout; keeping predecessor queue credit does not prevent that separate model allocation. The change does not claim resources are reclaimed within the existing sixty-second stop timeout.

Eight MiB represents roughly 131 seconds of Float32 mono audio at 16 kHz, or 44 seconds at 48 kHz. It is not mobile's existing five-second transport budget, and a sufficiently slow offline recognizer may now explicitly end dictation when it exceeds the new queue allowance.

Desktop overload stops capture but keeps the active session until the worker stops, so final transcripts from already accepted audio can still be inserted. Renderer tests cover this recovery path. The existing sixty-second stop timeout can still abandon undelivered transcription if recognition does not recover; mobile finish still rejects a session with recorded errors. Previously inserted text remains. The queue proof verifies worker consumption and cleanup; it does not establish lossless delivery for an indefinitely blocked recognizer or mobile overload.

If a predecessor worker remains blocked in native code and cannot finish termination, its queued audio continues to consume the shared budget. New dictation can therefore fail immediately until that worker exits or the app restarts. Releasing its credit early would admit more memory while the old buffers remain alive; this fix deliberately keeps the memory bound.

The 2026-09-18 review follow-up catches a failed worker-termination promise after startup times out, matching the other termination paths. Both successful and rejected termination are covered by the startup-timeout regression. All 53 focused tests (including the two renderer overload cases) passed. The audit patch and Node/Electron results were refreshed after the recoverable-overload change; all twelve comparative cases passed across the two runtimes.

The original service and worker are byte-identical in named `v1.4.198`; `versions.json` records that comparison. The queue mechanism requires sustained dictation with a recognizer that consumes audio too slowly or stalls. No affected-host observation establishes that trigger. Normal audio rates cannot explain a roughly 95 MB/s incident growth estimate, and this proof is not an attribution for #19831 or #19768.
