# Efficient Simulator preview: measured results

## Decision

Use the upstream H.264 stream for verified local iOS Simulator sessions. Reuse Orca's existing video IPC and decoder. Keep JPEG for older clients, missing video support, and video failure.

The original production-path benchmark improved decoded updates from about 25/s to 60/s while reducing source age, CPU, IPC payload, and summed process RSS. It kept native resolution and upstream encoder defaults. That benchmark met its declared targets, but it did not run the helper's normal CLI watchdog. Later real-CLI measurements found and isolated a separate periodic hitch; the upstream fix and its A/B/A result are documented below.

The cause is **both Orca's JPEG path and work in the older upstream helper**, not a demonstrated hard limit in Electron. Orca's frame gate drops useful JPEG updates. Increasing that gate's limit costs more JPEG encoding, transport, and decoding. The newer helper and a video stream avoid much of that work.

This report supersedes the retain-original decision in the earlier [bounded JPEG investigation](simulator-stream-hillclimb-report.md) only for the wider, user-authorized codec-adoption scope. The earlier negative results remain unchanged. Work follows the [implementation plan](../plans/2026-11-01-0139-perf-simulator-avcc-stream-plan.md). Publication of separate linked Orca and upstream issue/PR pairs is now requested. Benchmark receipts, input-fix receipts, and watchdog-fix receipts establish different claims; none substitutes for the other or for actual before/after demo attachments.

## Before and after

These are medians from three held-out MJPEG reference runs (`holdout-reference-{1,2,3}.json`, helper 0.1.47) and three integrated-production AVCC runs (`production-{1,2,3}.json`, helper 0.1.49-beta.139.1). Both use the native UIKit source at **1206 × 2622**, low-motion and textured-motion workloads, and the same fixed source-frame comparison method. Each run contributes its worse workload value for age and resources. Cadence is reported per workload. The table uses the original unrounded receipts for arithmetic.

| Metric                                | Original MJPEG | Integrated H.264 | Ratio (direction shown) |       Change |
| ------------------------------------- | -------------: | ---------------: | ----------------------: | -----------: |
| Worst-workload decoded source age p95 |          77 ms |            36 ms |      2.14× baseline/new | 53.25% lower |
| Low-motion decoded updates            |        25.18/s |          59.98/s |      2.38× new/baseline | 138.21% more |
| Textured-motion decoded updates       |        24.55/s |          59.97/s |      2.44× new/baseline | 144.32% more |
| Worst measured client-plus-helper CPU |        149.63% |           36.93% |      4.05× baseline/new | 75.32% lower |
| Worst IPC payload                     |     98.65 Mbps |       18.94 Mbps |      5.21× baseline/new | 80.80% lower |
| Worst peak summed process RSS         |     1796.90 MB |        817.97 MB |      2.20× baseline/new | 54.48% lower |

For lower-is-better metrics, the reduction is `100 × (1 − new / baseline)`. For cadence, the increase is `100 × (new / baseline − 1)`. The CPU result means the new path uses 24.68% of the measured baseline CPU, not that every part of the Simulator is "4× faster." The receipts do not support a single "3×/4× faster" claim.

Every integrated run passed measurement validity, exact-source-frame quality, native resolution, and no-IPC-after-stop checks. The production aggregate is `production-results.json`; the exact comparison is `final-comparison.json` in the local evidence directory below.

The candidate was selected before production integration with three paired selection comparisons. Three separate paired confirmation comparisons agreed. The final production results above are not substituted diagnostic projections.

### What these numbers mean

- **Source age** is the timestamp drawn by the native UIKit app to the decoded pixels sampled at renderer animation ticks. The pixel barcode includes a frame counter and CRC. Repeated or stale frames remain in the age samples. This is not physical display latency or input-to-photon latency.
- **Cadence** counts distinct pixel-verified source frames, not decoder callbacks, JPEG seeds, or screenshot acknowledgements.
- **CPU** sums cumulative CPU-time deltas for all dedicated Electron client processes plus the exact helper PID; 100% is one core. The active phase lasts eight seconds with pixel readback and screenshots disabled. Lightweight controller polling remains, but controller CPU is reported separately. The source app, helper children, CoreSimulator, WindowServer, and other platform services are excluded. Process churn and quantized helper CPU time limit precision. No whole-machine energy claim is made.
- **IPC** counts encoded ArrayBuffer payload bytes during that active phase, not HTTP, network, or Electron message headers. Descriptions and the optional JPEG seed are tracked separately; a seed is never a decoded video update.
- **RSS** is the largest sampled sum of client and helper working sets during the active phase, with samples about 500 ms apart, in decimal MB. It is not the sum of separately observed process peaks. Shared mappings can be counted more than once; this is not unique physical memory.
- The comparison changes both the helper version and the stream format. It does not assign a separate percentage of the gain to each change.
- These are steady-state results after a common two-second warmup. Source-age observation and observer-disabled resource collection each last eight seconds in separate phases. Cold-start and first-frame latency are not benchmarked.

### Image quality

The quality limits were fixed from the native-frame-matched JPEG motion control before candidate selection. Decoded frames are matched to an exact frozen native source frame. Resolution and quality gates are not relaxed to obtain the speed result.

| Quality check       | Fixed minimum | Worst held-out MJPEG result | Worst integrated H.264 result |
| ------------------- | ------------: | --------------------------: | ----------------------------: |
| Native RGB PSNR     |    35.9933 dB |                  39.6509 dB |                    38.7114 dB |
| Displayed luma SSIM |      0.992423 |                    0.997654 |                      0.994210 |

H.264 remains lossy. Its worst measured PSNR and displayed SSIM are lower than the held-out JPEG baseline, while still passing the predeclared limits. Passing these limits is not a claim of identical pixels or an exhaustive visual assessment of every app. No lower-resolution mode, fixed tiny bitrate, or selective frame-quality shortcut is used.

The fixed quality comparison uses a stable app-content region, excluding the timestamp/barcode and unstable system-overlay pixels. Native RGB PSNR is measured at 1206 × 2622. Displayed luma SSIM uses a fixed 3:1 mathematical reduction to 402 × 874, not a claim about Chromium's scaling filter. The comparator does not apply ICC/color-profile transforms. Its frozen exact-source-frame replay measures fidelity, not streaming latency.

## Separate causes and publication scope

| User-visible result                                            | Change and evidence                                                                                                                              | Scope                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| More distinct updates with less measured CPU, payload, and RSS | Newer helper plus MJPEG-to-H.264 adoption; three held-out baselines and three integrated repetitions above                                       | Orca dependency and existing video-path integration. Helper and codec changed together, so their individual gain percentages are unknown. |
| Input arrives while a drag is held                             | Move the control WebSocket to Electron main without weakening upstream Origin checks; controlled UIKit receipt and decoded-response trials below | Separate Orca input fix. These timings do not measure codec speedup or general input-to-photon latency.                                   |
| Remove the recurring real-CLI rendering hitch                  | Make the existing helper shutdown query asynchronous; matched 30-second A/B/A draw measurements below                                            | Separate `serve-sim` source fix. The selected beta dependency and original direct-middleware benchmark do not contain or prove this fix.  |

The Orca adoption reuses Android's main-owned video IPC, preload bridge, WebCodecs decoder, and canvas. iOS supplies an AVCC configuration record and length-tagged H.264 packets; Android keeps Annex-B handling. The MJPEG URL remains available for older or unsupported consumers and for iOS video failure. This avoids another decoder lifecycle or a custom encoder. It does not add native embedding, a new remote/mobile video feature, or a lower-resolution/quality mode.

## Smallest retained design

- Add optional `avccStreamUrl` metadata. Leave the existing MJPEG `streamUrl` and `streamCodec` compatibility fields unchanged.
- Reuse the main-owned video subscription, preload bridge, renderer hook, and canvas already used for Android. Android keeps its Annex-B handling; iOS supplies its AVC configuration record.
- Parse the upstream length/tag format incrementally with a 32 MiB packet bound and one owned payload allocation. Forward complete configuration, key, delta, and optional seed packets. Do not apply the JPEG frame gate or arbitrarily drop dependent video frames.
- Configure the decoder from avcC; wait for a key frame after configuration. Draw a JPEG seed only before real video. Close decoded frames and bitmaps.
- Switch once to the existing JPEG path on iOS video failure. Keep that failure attached to its session identity so it cannot create a retry loop.
- Close the owned request and decoder on parking, session changes, and normal cleanup. Renderer destruction closes the main-owned HTTP stream.
- Verify the live helper before first advertising AVCC. An exact compatible live version enables AVCC. A ready helper reporting HTTP 404, an older version, or a newer version stays running and uses JPEG, because detach/session metadata does not prove ownership. Only an actual endpoint/helper-readiness failure retains the existing one-retry recovery. An inconclusive diagnostic response does not justify terminating a working shared helper: a new session stays on JPEG; an already verified, reachable session remains reusable.
- Cancel unread non-OK diagnostic response bodies with `cancelUnreadResponseBody` before returning.
- Compare the bundled and materialized package manifests before reusing a cache directory under the same Orca app version.

There is no custom encoder, adaptive bitrate controller, new tunnel, generic streaming framework, or second decoder lifecycle. The original inline simplicity pass removed duplicate stop-target resolution by reusing the existing resolver. No lint or release-policy exception was added.

## Helper choice and plan deviation

The plan named `serve-sim@0.1.49-beta.140.1`. The normal pnpm install rejected that release under the repository's minimum-release-age policy. The implementation pins **`0.1.49-beta.139.1`** instead. It was old enough to pass the existing policy. No age-policy bypass was used.

The selected release's native binary and capture-related `native.ts`/`middleware.ts` source are byte-identical to the measured 140 candidate. Their Git comparison contains one camera-injection teardown fix, [upstream PR #169](https://github.com/EvanBacon/serve-sim/pull/169), not a capture/streaming change. Camera injection was not exercised. Broader beta compatibility is not established by this performance work.

The mature helper then passed the actual production repetitions. Its copied native addon also ran from a same-app-version materialized cache in the runtime smoke. This is the documented KTD1/KTD6 version-selection deviation; the original plan is not silently rewritten.

`mature-helper-selection.json` records package integrity, publish dates, source revisions, and binary/source hashes. The selected native binary SHA-256 is `62baa5fec5eb467e7a2cf7f134f00be2d43fe0c13d1407e48658e2183a6cc467`.

This is still a prerelease dependency. A stable upstream release containing these changes is preferable when available and verified; no automatic version substitution is part of this change.

## Recorded runtime and correctness proof

The following checks belong to the preserved integration and input-fix revisions. They are historical receipts, not passes on later publication edits. Final checks for the exact publication diff must be recorded separately.

Formal performance runs used macOS arm64, Electron 43.8.1, Chromium 150.0.7871.250, and Node 24.22.0. The final lifecycle smoke used the worktree's Electron 43.8.4 and Node 24.22.1, with the selected helper under Electron-as-Node. No performance equivalence between the two patch releases is asserted.

The hidden instrument imports the **actual production** screen component, video hook, preload bridge, main IPC, parser, and HTTP transport. The native helper runs its actual middleware and capture service. It does not launch the full Orca application or the helper's normal CLI bootstrap, which can open Simulator.app. It therefore omits the normal shutdown watchdog and could not expose the periodic CLI stall found later. All launches use `ORCA_BACKGROUND_LAUNCH=1`; test windows stay hidden and non-focusable. CDP screenshots verify the rendered content.

| Requirement                | Exercised evidence                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1: Native quality         | Three production repetitions at native phone resolution; exact-source-frame PSNR/SSIM gates all pass.                                                                                                                                                                                                                                     |
| R2/R3: Speed and footprint | Three production repetitions meet every predeclared cadence, age, CPU, IPC, and RSS target.                                                                                                                                                                                                                                               |
| R4: Compatibility/failure  | Actual HTTP 404 video failure switches to a loaded JPEG image; no video restart loop. Missing-capability and decoding failures have focused coverage.                                                                                                                                                                                     |
| R5: Existing clients       | Android Annex-B and ownership regressions pass. The registered folder-workspace suite passes. Pane discovery/attach still explicitly target the local runtime; the browser emulator API remains unavailable as before. No remote/mobile video feature is added.                                                                           |
| R6: Lifecycle              | Real park/resume, session-key change, phone/tablet switch, and final stop pass. Normal stop balances decoder starts/closes. Destroying a live hidden renderer removes its Node HTTP socket while main remains alive; IPC bytes stay unchanged afterwards.                                                                                 |
| R7: Helper identity/cache  | Actual materialization replaces 0.1.47 with 139 under the same app-version directory; manifest, middleware, and native binary hashes match. The copied helper runs. Original positive-old/404 recovery tests predate the publication correction that preserves ready adopted helpers; those passes are not proof of the corrected policy. |

The dedicated iPad smoke decodes **2064 × 2752**, matching the native screenshot, with upright CRC-valid source samples. It also acknowledges a real device-orientation change and continues decoding. Rotation changes pixels/orientation without necessarily changing encoded dimensions. An in-stream resolution change is therefore checked separately: real native tablet and phone AVCC packets are replayed at recorded pacing through one HTTP response and the **same** decoder. This proves configuration/size handling, not a live Simulator resolution change or full-pane rotation layout.

The tablet smoke is not an iPad performance benchmark. No general claim is made for Intel Macs, remote links, browser/mobile clients, physical input response, every app's content, or all helper features.

### Recorded focused checks

- Nine affected Vitest entrypoints: **156 tests passed**, with at most two workers. This includes the registered folder-workspace tests, not an unselected `.spec.ts` file.
- `pnpm tc:node` and `pnpm tc:web`: passed.
- Targeted `oxfmt` (29 supported files) and `oxlint` (owned JS/TS paths): passed. The implementation check scope is 30 files.
- Actual phone/tablet production-path lifecycle smoke: passed, including live-renderer request teardown.

The first iPad driver incorrectly assumed that rotation must swap encoded width and height. That failed driver result is preserved. The corrected check resets portrait orientation, verifies actual upright CRC-valid native pixels, and distinguishes orientation metadata from encoded-size reconfiguration. No production quality threshold was weakened.

## Live input follow-up

Hands-on testing found a separate integration defect: smooth video did not mean live input. The newer helper correctly rejects the renderer's cross-origin WebSocket with HTTP 403. Video works through main-process HTTP, but the rejected control connection makes the device frame buffer a drag and replay it only on pointer-up. A long drag therefore appears to have seconds of input delay. This is an Orca integration error, not a demonstrated three-second native-platform limit. The upstream origin protection must stay enabled; [serve-sim issue #21](https://github.com/EvanBacon/serve-sim/issues/21) explains the security risk it addresses.

The fix moves the persistent control WebSocket into Electron main, behind the existing preload boundary. The main-owned connection sends no browser Origin header; it does not spoof one or change the helper. The bridge restricts endpoints and HID frame tags/sizes, isolates renderer ownership, and closes on stop, replacement, navigation, crash, or destruction. Existing pointer interpretation, 80 ms wheel completion, 4 ms keyboard spacing, and 750 ms reconnection remain unchanged. Browser/mobile emulation remains unavailable.

The repeatable reproduction holds a drag for 1.5 seconds in the actual production device frame, control hook, preload, video IPC, and decoder. An isolated UIKit app logs receipt in `UIWindow.sendEvent` and draws a CRC-protected input counter into the streamed pixels.

| Metric                                             | Broken control, 3 drags | Fixed control, 10 warm drags |
| -------------------------------------------------- | ----------------------: | ---------------------------: |
| Median pointer-down to UIKit receipt               |                 1526 ms |                        10 ms |
| Median pointer-down to decoded visible response    |                 1553 ms |                      36.5 ms |
| Native input received before pointer-up, each drag |                0 events |                     3 events |

All ten confirmation drags received input while held, without fallback replay. UIKit receipt ranged from 2–14 ms and decoded visible response from 28–40 ms. The confirmation uses 1.5 seconds of warmup after the first valid image. The earlier, unsettled three-drag fix check is retained separately: 15–25 ms to UIKit and 37–158 ms to decoded response. These are controlled reproduction results, not a universal latency guarantee or a claim that cold-start latency equals warm latency.

A separately rebuilt full Orca app opened the new control IPC connection and delivered a warm touch to the owned UIKit fixture in 16 ms. After the key-recovery correction below, the rebuilt final app delivered it in 17 ms, and three final production-component drags measured 5–10 ms to UIKit and 28–33 ms to decoded response, without fallback. A first touch after reboot measured 135 ms and is retained separately; warm results do not describe cold guest input startup. The previous running app still had its old preload; hot renderer updates alone do not install this fix. Restart the development app before testing it.

Input validation: four focused Vitest entrypoints, 45 passing tests; `tc:node`, `tc:web`, scoped formatting and lint passed. The socket regression runs in the existing Node-runtime project, matching Electron: Bun substitutes its built-in `ws` client and does not provide the same pending-handshake cancellation behavior. Tests preserve ordered key releases and cover ownership, stale status, reconnect, rejection, and renderer teardown.

Separate fix-only reviews ran on verified Opus, Astra, and Grok at high reasoning, without fallback. Opus and Astra found no actionable defects. Grok found a valid P2: a delayed key-up can be discarded by main after the renderer has already forgotten it. Failing-before/passing-after tests confirm the gap. Main now reports its held-key state on disconnect; the renderer restores that state and carries it into subsequent connection attempts, including failed reconnects. A real rebuilt Electron IPC/loopback-wire check confirms carried and newly held keys survive a peer close. No native keyboard events were injected by that check. The recovery tail was validated by main, not independently re-reviewed by the three models.

Evidence is under `input-latency/` in the local evidence root: `origin-baseline.json`, `baseline.json`, `fixed.json`, `fixed-confirmation.json`, `final-smoke.json`, `actual-app-input.json`, `actual-app-final-input.json`, `actual-app-verified-input.json`, `actual-app-key-recovery.json`, `review-model-receipts.json`, and rendered PNGs. The new full-app checks and all generated Simulator input target only the owned test device, not the user's Simulator.

Decoded response is sampled at renderer animation ticks, not physical input-to-photon latency. No paired native Device Hub input benchmark or native keyboard-permission path benchmark was performed. Device Hub presents IOSurfaces without this encode/decode hop, so identical physical latency is not established. The test device also reported Device Hub's legacy-input flag; that flag alone did not prevent fast touch delivery here. No input repair, guest restart, or permission change was applied to the user's device.

## Independent review of the original AVCC change

All three requested reviews of the original integration returned. Full-run saved model-change and thinking-level records verify these identities at `high`, without fallback:

| Reviewer | Served model               | Result                                                                                                                                                                                                        |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opus     | `kiro/claude-opus-5.5`     | Found the inconclusive-diagnostic/shared-helper restart risk. A failing-before/passing-after regression confirmed the kill path; fixed.                                                                       |
| Astra    | `openai-codex/gpt-6-astra` | Found same-device refresh shutting down the guest. A failing-before/passing-after runtime regression confirmed it; fixed. Follow-up inspection also accepted the shared-helper policy fix and resolver reuse. |
| Grok     | `cursor/grok-4.7`          | No actionable findings in its inspected integration scope, including the guest-preservation fix.                                                                                                              |

The reviewers performed static review, not runtime measurements. Main performed all checks. Grok and Opus did not re-review the later shared-helper fix; Astra did. Reviewer agreement is not the runtime proof. Earlier failed Opus approach-review attempts remain recorded in the earlier report; they are not counted as successful reviews here.

## Upstream findings and format rationale

The earlier native Device Hub comparison, outside Orca's embedded view, showed Core Animation/IOSurface presentation rather than the JPEG path. It did not measure a native-versus-Orca input-latency ratio.

No ADR or explicit light-footprint rationale for choosing MJPEG was found in the inspected Orca documentation or original [Orca PR #4754](https://github.com/stablyai/orca/pull/4754). Do not infer that JPEG was chosen because it was lighter.

- [serve-sim PR #78](https://github.com/EvanBacon/serve-sim/pull/78) introduces H.264 against bandwidth-heavy MJPEG while preserving JPEG compatibility.
- [serve-sim PR #171](https://github.com/EvanBacon/serve-sim/pull/171) addresses per-frame blocking service work, surface caching, lazy JPEG work, and resolution-scaled H.264 bitrate. The selected helper includes the capture implementation tested here.
- [Orca PR #32967](https://github.com/stablyai/orca/pull/32967) improves JPEG parser accumulation but leaves the frame gate in place.

The middle ground is therefore available now: use the efficient upstream video format with its measured defaults, keep JPEG compatibility, and avoid a custom streaming system. These results reject a hard-platform-limit explanation for the original lag. They do not prove that no further optimization is possible.

## Real-CLI periodic rendering fix

The original benchmark did not settle all visible pacing problems. Later pre-fix paired Native Simulator and Orca window recordings retained visible holds. Packet timing placed the recurring delivery gaps before the main-process socket; the recorded decode queue was empty through those gaps. The earlier streaming-stage investigation retained no optimization and did not prove native presentation parity.

The normal `serve-sim` CLI shutdown watchdog used synchronous `execSync('xcrun simctl list devices booted -j')` on the same JavaScript event loop that receives native AVCC callbacks and writes HTTP video. A booted tick schedules its next check 3000 ms after the query returns. Blocking that event loop pauses frame delivery even though the guest continues to render. The narrow upstream change makes the existing shared boot snapshot asynchronous with `execFile` and awaits the two existing reusable-state callers. It preserves the query timeout, cache, shutdown grace, orphan cleanup, and serial polling; it does not raise the polling rate or change video settings.

The real-CLI A/B/A experiment runs the same native addon and production decoder/canvas against the owned deterministic UIKit motion fixture. Each timed interval is 30 seconds. The unchanged helper runs first, then the asynchronous-query build, then the unchanged helper again.

| Production canvas measurement | Baseline A | Async query | Baseline B |
| ----------------------------- | ---------: | ----------: | ---------: |
| Draw rate                     |    57.87/s |     60.00/s |    58.03/s |
| Draw gaps over 33 ms          |         10 |           0 |         10 |
| Maximum draw gap              |   157.2 ms |     24.4 ms |   143.2 ms |

The stall returns when the old helper returns. These measurements support the upstream event-loop fix, independently of the earlier codec/helper resource gains and Orca control-channel fix. They are real production canvas submissions, not physical scanout. They use the owned fixture, not the user's Home-screen gestures. They do not establish Device Hub parity, 120 Hz content, input-to-photon latency, or whole-machine energy savings.

The successful receipt is `simulator-window-comparison/watchdog-video-1793561061544-45383/result.json`; `optimization-decision.json` records the decision and separate regression/barrier evidence. All three helpers record Electron 43.8.1/Node 24.22.0 and the identical native SHA-256 `62baa5fec5eb467e7a2cf7f134f00be2d43fe0c13d1407e48658e2183a6cc467`. Their source-build package manifests report 0.1.46; these are not a new benchmark of a published watchdog-fixed beta package. The first harness attempt failed before measurement on a runtime-state-field assumption and is excluded, not counted as a baseline.

The upstream source change is separate from Orca's adoption PR. Orca still pins `0.1.49-beta.139.1` and does **not** contain the watchdog fix; adopting it requires an upstream release and a dependency update. Zero draw gaps over 33 ms is the result of the locally patched upstream A/B/A interval, not a result promised by the unpatched Orca dependency. Earlier `capture-motion-01` and `capture-motion-timing-02` Native-vs-Orca videos show the pre-fix state only. The separately captured before/after videos below identify their actual build and scope instead.

## Published evidence

- Orca problem and codec demos: [issue #37183](https://github.com/stablyai/orca/issues/37183).
- Separate nonblocking watchdog fix: [serve-sim issue #186](https://github.com/EvanBacon/serve-sim/issues/186), [PR #187](https://github.com/EvanBacon/serve-sim/pull/187).
- [Public numerical receipts, method, arithmetic audit and media hashes](https://gist.github.com/kiendle/8bc3c3f09e2204377b8e9ed61a8f5a31). The exports omit private host/device/process data. They support recalculation, not an independent rerun of the unshipped instruments or image comparison.
- Codec/helper recordings: [MJPEG / 0.1.47 before](https://github.com/user-attachments/assets/f194ce41-8699-4768-93c4-be42f757671e), [AVCC / 139.1 after](https://github.com/user-attachments/assets/911482cc-3b2c-4c45-a0e1-b5ffa4e010fb). Both run real middleware without the CLI watchdog.
- Watchdog recordings: [synchronous query before](https://github.com/user-attachments/assets/752ff534-6c47-4e48-8299-8419e3789d4e), [asynchronous query after](https://github.com/user-attachments/assets/62165e84-a716-461f-bb87-546722162889). Both run the real CLI with the watch enabled and the same native addon.

These are separate real-time, approximately ten-second captures of actual production decoded pixels, not native-window recordings or repeats of the formal resource benchmark. The production source stays 1206 × 2622; only a recording-only mirror uses the actual 402 × 874 CSS viewport. MediaRecorder adds scaling/encoding overhead. Movie frame counts are not distinct source-frame counts. Original presentation timestamps and held images survive the metadata-only MP4 remux; no source frames, interpolation, or playback-speed changes are introduced. Warmups can select different starting source counters, so movie zero is not exact source-frame alignment.

All four uploaded MP4s were read anonymously and matched the inspected file hashes. The actual public GitHub players loaded and played them without media errors in a signed-out browser. These later captures use Electron 43.8.4/Node 24.22.1, not the formal benchmark's 43.8.1/24.22.0. Their receipts record stopped owned helpers/renderers, released leases, the owned guest shut down, and the preexisting matching fixture preserved. User apps and the user's guest were not commanded.

## Local evidence and reproduction

Evidence root: `.context/compound-engineering/ce-optimize/simulator-avcc-autonomous/` in the preserved worktree.

- `spec.yaml`, `experiment-log.yaml`, `confirmed-decision.json`: search constraints, paired selection, and held-out decision.
- `final-comparison.json`, `production-results.json`, `production-{1,2,3}.json`: exact aggregates and individual production results.
- `production-*.json.cases/`: raw observations, frame-matched quality, CPU phases, and decoded/compositor PNGs.
- `bench/`: frozen formal measurement instrument. `production-evaluate.mjs` and `production-series.mjs`: native-source production drivers.
- `ui-smoke-results.json`, `ui-smoke/`: actual lifecycle results, native screenshots, and hidden-compositor evidence. The earlier orientation-assumption result remains separate.
- `mature-helper-selection.json`, `review-model-receipts.json`: helper and full-run reviewer identities.
- `stream-stage/investigation-result.json`: diagnostic stage attribution with no retained performance change and explicit native-parity limits.
- Sibling `simulator-window-comparison/optimization-decision.json`, `watchdog-response-1793560703273/result.json`, and `watchdog-video-1793561061544-45383/result.json`: separate upstream watchdog diagnosis, responsiveness barrier, and actual-CLI A/B/A evidence.

The instruments use explicit owned devices, private helper state, and non-user ports. They deliberately refuse the user's device and helper port. Read the ownership receipts before rerunning; boot only the dedicated test device and preserve the existing result files. Baseline paths describe the package installed when the measurements ran, not a promise that the current worktree still has 0.1.47 installed.

Raw measurement files remain in the preserved worktree; the report and implementation are the repository deliverables. The public exports and later demo captures above have separate provenance. Historical measurement and review receipts are not a claim that the final publication diff passed its checks; final integration checks must be recorded against that diff.

The original integration receipts record cleanup of its owned helper controllers, shutdown and preservation of the dedicated phone, deletion of its disposable iPad, and cancellation of its deadline backstop. The later successful watchdog receipt separately records helper stop, fixture uninstall, owned-device shutdown, and lease release. These are historical cleanup receipts, not a claim about the current live app. Neither experiment targeted the user's device or helper.

## Publication-base integration

The publication checkout applies the feature to main `11101fb05ac71615a6a78edf669ee9b9f3e34cc7`, retaining its Device Hub input-takeover checks and native Android controls. The focused integration run passed 188 tests across 16 files; all five typecheck projects and all 41 project-wide lint steps passed. Packaging and non-macOS runtime results are not implied by these checks.

A fresh owned-device smoke imported this checkout's actual production screen, video hook, main IPC and parser into a hidden Electron 43.8.4 / Node 24.22.1 renderer. Its real UIKit source advanced during both recordings at 1206 × 2622. AVCC configured `avc1.640033`, rendered real video without JPEG fallback or page/decoder errors, and ended with an empty decoder queue. The parent inspected the recorded native pixels.

The preserved measurement worktree retains this run at `.context/compound-engineering/ce-optimize/simulator-publication-media/owned-codec-1793576023523-47678-5def88c1/manifest.json`. Its source-module hashes identify the tested implementation. Both windows remained hidden, unfocused and nonfocusable. Owned helpers, sources and renderers stopped; the dedicated guest returned to Shutdown, the lease was released, and the preexisting fixture and data were preserved.

This is a current-source streaming smoke, not a whole-app, physical-scanout, native Device Hub comparison or new performance benchmark. The formal resource/quality medians and public demos above remain bound to their historical revisions.
