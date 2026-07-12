# Soniox WebSocket STT Integration Research

Last verified: 2026-07-12

This note records the Soniox protocol facts and the concrete integration seam in Orca. Soniox changes its active model catalog over time, so model names and limits must be rechecked against the linked first-party pages when implementation begins.

## Recommendation

Add Soniox as a real-time cloud provider owned by Electron's main process. Reuse Orca's existing capture, IPC/RPC ownership, and `SttEvent` delivery paths, but introduce a provider-neutral cloud-session interface rather than adding more Soniox branches to the OpenAI-specific session field.

For the initial model, use `stt-rt-v5` with raw `pcm_s16le`, 16 kHz, mono audio. Resample and encode in the main process, then send binary WebSocket frames at capture cadence. The configuration text frame must be sent before any audio. Soniox currently lists `stt-rt-v5` as its active real-time model and documents `stt-rt-v4` only as an alias to it ([models](https://soniox.com/docs/stt/models#current-models)). Raw audio requires `audio_format`, `sample_rate`, and `num_channels`; Soniox's documented 16 kHz mono example uses exactly this configuration ([audio formats](https://soniox.com/docs/stt/rt/real-time-transcription#audio-formats)).

Do not expose the API key or the Soniox socket to the renderer or mobile client. Orca already captures desktop audio in the renderer and forwards samples through preload/IPC to the main-process `SttService`; mobile audio similarly terminates at the paired desktop runtime. Keeping the provider connection in main preserves that trust boundary and also preserves the existing rule that speech runs on the paired desktop, not on a worktree's SSH host.

## Soniox WebSocket Contract

### Authentication, endpoint, and first frame

- Connect to `wss://stt-rt.soniox.com/transcribe-websocket` ([WebSocket endpoint](https://soniox.com/docs/api-reference/stt/websocket-api#websocket-endpoint)). Soniox also documents regional US, EU, and Japan hosts; a regional project key must be used with its matching endpoint ([data residency](https://soniox.com/docs/data-residency#regional-endpoints)). Region selection is not required for the first Orca increment, but the connection constructor should not make future regional support difficult.
- After the socket opens and before sending audio, send one text JSON start request. `api_key`, `model`, and `audio_format` are required; raw PCM additionally requires `sample_rate` and `num_channels` ([configuration](https://soniox.com/docs/api-reference/stt/websocket-api#configuration)). The API's error catalog explicitly rejects a non-text start request.
- The `api_key` field accepts either a long-lived Soniox key or a temporary key. This is distinct from Soniox REST authentication, which uses an `Authorization: Bearer ...` header ([authentication errors](https://soniox.com/docs/api-reference/errors#unauthenticated)).
- The raw WebSocket protocol does not document a start-ack frame. Orca should consider the session able to accept queued audio once the socket is open and the configuration frame has been sent, while still treating a later configuration error frame as startup/session failure.

Recommended initial configuration:

```json
{
  "api_key": "<read from main-process secure storage>",
  "model": "stt-rt-v5",
  "audio_format": "pcm_s16le",
  "sample_rate": 16000,
  "num_channels": 1,
  "enable_endpoint_detection": true
}
```

`client_reference_id` is optional and is recorded in usage logs. It should contain an opaque session identifier, never repository paths, terminal text, user speech, or other sensitive content ([configuration parameters](https://soniox.com/docs/api-reference/stt/websocket-api#parameters)).

### Audio format, sampling, and cadence

- Audio normally follows the start request as binary WebSocket frames. Each stream supports up to 300 minutes ([audio streaming](https://soniox.com/docs/api-reference/stt/websocket-api#audio-streaming)).
- `audio_format: "auto"` is for container streams with detectable headers: AAC, AIFF, AMR, ASF, FLAC, MP3, OGG, WAV, and WebM. Orca currently transports headerless sample arrays, so `auto` is the wrong fit. Raw signed/unsigned integer PCM, float PCM, mu-law, and A-law are supported when encoding, rate, and channels are declared ([audio formats](https://soniox.com/docs/stt/rt/real-time-transcription#audio-formats)).
- Soniox does not prescribe one sample rate or an ideal frame size. Orca can reuse `resampleToRate` to normalize renderer hardware rates and mobile-provided rates to 16 kHz, then encode clamped floats as little-endian signed 16-bit PCM. This avoids WAV headers and avoids changing either capture source.
- Send at real-time or near-real-time speed. Brief buffering and jitter are tolerated, but prolonged bursts or lags can disconnect the session ([real-time cadence](https://soniox.com/docs/stt/rt/error-handling#real-time-cadence)). Renderer startup buffering is bounded to 30 seconds today; draining that backlog as fast as IPC permits may violate this guidance. The Soniox session therefore needs an outbound queue with bounded backpressure and real-time pacing for buffered startup audio, plus a defined overflow error rather than unbounded memory.

### Response and transcript accumulation

A successful server text frame contains a `tokens` array plus `final_audio_proc_ms` and `total_audio_proc_ms`. Tokens have `text`, `is_final`, and `confidence`, and may have timestamps, speaker, language, or translation fields ([response schema](https://soniox.com/docs/api-reference/stt/websocket-api#response)).

The text contract is important:

- A token may be a word, subword, punctuation, or whitespace. Concatenate token `text` with `join('')`; do not insert or normalize spaces.
- Non-final tokens are a replaceable snapshot. They may change, disappear, or repeat in later responses. Replace the prior non-final buffer with the current frame's non-final token text.
- Final tokens never change, are sent only once, and are not repeated. Append each frame's final token text exactly once to the committed buffer.
- The current display is `committedFinalText + currentNonFinalText` ([token evolution](https://soniox.com/docs/stt/rt/real-time-transcription#how-processing-works)).
- With endpoint detection enabled, Soniox finalizes the segment and emits a final `<end>` control token. Filter `<end>` from user-visible transcript text; it is a segment-boundary signal, not dictated content ([endpoint detection](https://soniox.com/docs/stt/rt/endpoint-detection#how-endpoint-detection-works)).

For Orca's current event contract, the adapter should emit only newly appended final text as `SttEvent { type: 'final' }` and the current replaceable non-final suffix as `SttEvent { type: 'partial' }`. It must not trim either value. If a frame contains both kinds, emit final first and then partial so consumers clear or replace the provisional suffix after committing text.

There is one existing incompatibility that implementation must fix: desktop final insertion can preserve Soniox whitespace tokens because `formatFinalTranscriptSegment` already avoids adding space when a segment supplies it. Mobile currently trims every final event in `startMobileDictation` and returns `finalTexts.join(' ')`, which can turn token sequences such as `Hello`, `,`, ` `, `world` into `Hello , world`. Mobile accumulation must preserve provider text exactly (for example, append untrimmed final fragments and concatenate with `join('')`). Empty-string filtering must not discard a whitespace-only final token.

Manual `{"type":"finalize"}` is not the same as ending the stream. It finalizes pending audio, returns final tokens, then emits the final control token `<fin>`; audio may continue afterward ([manual finalization](https://soniox.com/docs/stt/rt/manual-finalization)). If Orca later uses it for endpoint control, filter `<fin>` from user-visible text just as the initial adapter must filter endpoint detection's `<end>`. The initial stop path can use the protocol's empty-frame graceful finish instead.

### Graceful finish, cancellation, and close

- To finish, send an empty binary or text WebSocket frame. Soniox returns remaining response frames, then a frame with `finished: true`, and then closes the connection ([ending the stream](https://soniox.com/docs/api-reference/stt/websocket-api#ending-the-stream)).
- Resolve Orca's `stopDictation()` only after `finished: true` has been parsed (or after a bounded stop timeout). Deliver all final text before the existing `stopped` event. A close event by itself is insufficient proof of success.
- Cancellation should close the client socket and discard remaining provisional audio/text. Soniox does not guarantee final results after a client-side abrupt close.
- The adapter must make finish idempotent because desktop window cleanup, mobile cancellation, and error handling can converge on the same session.

### Errors

On failure, Soniox sends one JSON error frame and then closes the WebSocket with close code `1000`. Therefore a normal close code cannot distinguish success from failure; parse every text frame and retain the error before handling close ([STT WebSocket error frame](https://soniox.com/docs/api-reference/errors#stt-websocket-error-frame)).

The error frame includes `error_code`, stable `error_type`, human-readable `error_message`, `more_info`, and `request_id`. Branch on `error_type`, not message text, and retain `request_id` for diagnostics without ever logging the API key ([error response](https://soniox.com/docs/api-reference/stt/websocket-api#error-response)). Expected groups include malformed request/model errors (400), authentication (401), balance or budget exhaustion (402), temporary-key expiry (403), timeouts (408), maximum duration (413), limits (429), internal error (500), and service unavailable (503).

Sanitize errors before renderer/RPC delivery. At minimum, redact the configured key and Bearer-like credentials from server, WebSocket-library, and locally constructed errors. User-facing errors should be stable Orca messages; logs may include `error_type`, numeric code, and `request_id`, but not configuration JSON or raw audio.

Soniox's recovery guidance is not uniform: a maximum-duration error requires a new connection, early 503 termination requires a new request, and audio must remain near real time ([real-time error handling](https://soniox.com/docs/stt/rt/error-handling)). The general error reference recommends retry/backoff for transient classes ([errors](https://soniox.com/docs/api-reference/errors)). Authentication, invalid request/model, budget exhaustion, and temporary-key expiry should not be blindly retried with identical inputs.

### Keepalive and reconnect

When audio is continuously captured, audio frames themselves keep the stream active. If Orca pauses sending while retaining the session, send `{"type":"keepalive"}` at least every 20 seconds; 5–10 seconds is common. More than 20 seconds without audio or keepalive may close the connection, and billing covers the full open-stream duration ([connection keepalive](https://soniox.com/docs/stt/rt/connection-keepalive)). A timer is useful only while the socket is open and no audio has been sent recently; clear it on finish, cancellation, error, and close.

The raw protocol defines no resume token, audio offset, or cross-connection deduplication. A reconnect is a new transcription request. Automatic replay can duplicate already-final text or omit speech unless Orca owns a bounded audio replay buffer and a precise commit boundary. For the first integration, prefer explicit failure over a misleading "seamless" retry during active dictation. It is safe to retry connection establishment before any audio/final token, and it is reasonable to offer a fresh session after a transient failure. Any later transparent reconnect needs dedicated replay/deduplication design and tests.

### Model and language settings

Soniox uses one multilingual real-time model for more than 60 languages ([supported languages](https://soniox.com/docs/stt/concepts/supported-languages)). `language_hints` improves recognition but does not restrict output; `language_hints_strict: true` requests a best-effort restriction ([language hints](https://soniox.com/docs/stt/concepts/language-hints), [language restrictions](https://soniox.com/docs/stt/concepts/language-restrictions)).

Orca's `VoiceSettings.language` currently defaults to `en` but is not wired into the speech pipeline or exposed as an effective model setting. Do not silently send that default as a Soniox hint, because it would bias multilingual users toward English. The initial Soniox configuration should omit language hints. A later UI change can expose automatic versus one-or-more explicit hints and pass only intentional user choices.

## Orca Implementation Map

| Concern           | Current seam                                                                       | Required change                                                                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog and types | `src/shared/speech-types.ts`, `src/main/speech/model-catalog.ts`                   | Add `soniox` provider/type and a streaming `stt-rt-v5` catalog entry. Update every exhaustive provider union, including mobile runtime summaries.                                                                                                                    |
| Provider session  | `src/main/speech/openai-transcription-client.ts`, `src/main/speech/stt-service.ts` | Define a narrow cloud session contract (`feedAudio`, `finish`, `cancel`/cleanup and event sink as needed). Keep OpenAI batch upload behind it and add a separate Soniox real-time session module. Avoid a generic `utils`/`helpers` module.                          |
| Audio conversion  | `src/main/speech/stt-audio-resample.ts`                                            | Reuse resampling; add a concretely named PCM16 encoder module shared with tests. Do not copy the private WAV encoder and do not add WAV framing to each WebSocket chunk.                                                                                             |
| Lifecycle         | `SttService.startDictation/feedAudio/stopDictation`                                | Route by provider. Soniox should emit `ready` after open + start-frame send, stream partial/final events, and make stop wait for `finished`. Preserve owner checks, `stopping`, startup/stop timeouts, and stale-session suppression.                                |
| Secure key        | `src/main/speech/openai-api-key-store.ts`, `src/main/ipc/speech.ts`                | Add a provider-specific Soniox key store using `safeStorage`, `~/.orca`, mode `0600`, cache clearing, legacy/plaintext fallback behavior only if project policy accepts it, and provider-specific status/save/clear IPC. Never return the key to renderer or mobile. |
| Model readiness   | `src/main/speech/model-manager.ts`                                                 | Cloud readiness must check the matching provider key rather than treating only `openai` specially. A provider registry/predicate is safer than successive conditionals.                                                                                              |
| Desktop           | `use-audio-capture.ts`, `DictationController.tsx`                                  | No new browser-to-Soniox path. Keep session IDs and existing partial/final IPC. Verify whitespace-only final events and startup-buffer pacing.                                                                                                                       |
| Mobile            | `OrcaRuntime.startMobileDictation/finishMobileDictation`                           | Expand provider union and change final aggregation from trimming plus `join(' ')` to exact Soniox-safe accumulation without regressing local/OpenAI segment spacing. Prefer making the event text contract provider-neutral and exact.                               |
| Settings UI       | `VoicePane.tsx` and its extracted model/key components                             | Add provider-specific configuration status/dialog using existing UI primitives and style tokens. Avoid folding Soniox state into `openAiApiKeyConfigured`; settings need explicit provider key status.                                                               |
| SSH/remote        | `OrcaRuntime.listMobileSpeechModels` and speech runtime ownership                  | Continue executing capture-to-provider traffic on the paired desktop main process. Do not route Soniox through a repository SSH host or assume that host has the key/network access.                                                                                 |

The current `SttService.cloudSession` is typed as `OpenAiTranscriptionSession`, and its cloud stop path assumes `finish()` returns one final string. Soniox instead produces events throughout the session and has a multi-frame asynchronous finish. The provider-neutral session interface is therefore the central architectural change; forcing Soniox into the current concrete type would spread protocol-specific state across `SttService`.

## Key Security Decision

Orca should support user-provided Soniox keys stored only in the main process, matching the existing OpenAI BYOK pattern. The key must not be compiled into Orca, persisted in settings JSON, sent over IPC/RPC, printed in logs, or included in errors.

Soniox states that an untrusted browser/client connecting directly must use a temporary key minted by a controlled backend; a long-lived key must never leave that backend ([temporary API keys](https://soniox.com/docs/guides/temporary-api-keys)). Temporary keys are created by `POST https://api.soniox.com/v1/auth/temporary-api-key` with `usage_type: "transcribe_websocket"`; they can be short-lived, single-use, and session-duration-limited ([temporary-key API](https://soniox.com/docs/api-reference/auth/create_temporary_api_key)). Orca has no project-operated credential backend in this flow, so it must not invent a temporary-key exchange or ship a shared Soniox credential. If a future Orca service offers managed credentials, the renderer/mobile client should receive only a short-lived single-use key, never the long-lived issuer key.

## Test Plan

Soniox documents no sandbox endpoint, fake key, deterministic transcript mode, or record/replay facility. Most coverage must use an injected WebSocket transport/factory and protocol fixtures; real API tests must be opt-in.

### Deterministic tests

1. Start frame is the first text frame and includes the correct provider key, `stt-rt-v5`, PCM16LE, 16 kHz, and one channel; snapshots and failure output must redact the key.
2. Hardware-rate Float32 chunks resample and encode to expected little-endian PCM16 boundaries, including clipping, empty chunks, and multiple input rates.
3. Audio is queued until open/config send, then sent as binary in order with a bounded queue and tested pacing/backpressure behavior.
4. Mixed token frames append final tokens once and replace non-final tokens. Cover repeated/changing non-final tokens, whitespace-only tokens, punctuation, CJK text, subwords, and a frame containing both final and non-final tokens. Endpoint fixtures must filter `<end>` from visible text.
5. Manual-finalization fixtures filter `<fin>` if that control is implemented.
6. Graceful finish sends one empty frame, waits through trailing result frames for `finished: true`, emits final before stopped, and is idempotent under repeated stop.
7. Error JSON arriving before close wins over close code 1000. Cover stable error-type mapping, request ID retention, credential redaction, malformed JSON, network error, unexpected close, startup timeout, and stop timeout.
8. Keepalive fires only after the configured idle interval and is cleared on audio, finish, cancel, error, and close. No timer or socket listener survives a completed session.
9. Owner isolation covers desktop windows, mobile clients/connections, cancellation while starting, stale socket events, and switching between local, OpenAI, and Soniox models.
10. Desktop and mobile consumers preserve exact token text. Regression fixtures must include `Hello, world!`, whitespace tokens delivered separately, and Chinese/Japanese text without injected spaces.
11. Key-store tests cover save/read/status/clear, unavailable encryption behavior, file permissions where supported, corrupt ciphertext, cache clearing, and absence of secret material in returned status/errors.

Use a local `WebSocketServer` from the already-declared `ws` dependency for higher-level integration tests. It can assert actual frame type/order and script trailing results, `finished`, error-before-close, delayed open, and abrupt disconnect without external network or billing.

### Opt-in live smoke test

The live test is gated behind both `SONIOX_API_KEY` and `SONIOX_SMOKE_PCM_PATH`; it never runs in default CI or prints the key. The fixture must be raw 16 kHz mono signed PCM16LE containing a short spoken phrase. Run it with `pnpm exec vitest run --config config/vitest.config.ts src/main/speech/soniox-transcription-client.live.test.ts`. It streams at near-real-time cadence, gracefully finishes, and asserts at least one final non-control token and no error event rather than exact transcript wording. A valid key, balance, and available quota are required and the request is billable. On failure, surface sanitized `error_type` and `request_id`; consult the official [status page](https://status.soniox.com/) for service incidents.

## Open Implementation Decisions

- Whether to expose Soniox data-residency region in the first UI or initially use the global/US endpoint only.
- Whether endpoint detection should be on by default. It can reduce final latency, but exact sensitivity/latency settings require live dictation evaluation; Soniox documents tuning fields on the [WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api#parameters).
- Whether Orca should preserve the present event shape or replace it with an explicit transcript delta/snapshot type. The latter would make committed versus provisional text harder to misuse across desktop and mobile, but is a broader refactor.
- How to pace the renderer's bounded startup backlog without increasing perceived start latency or violating Soniox's near-real-time cadence.
- Whether transient mid-stream reconnect is worth an audio replay/deduplication protocol. The raw Soniox API provides no resume primitive, so this should not be claimed as reliable until designed and tested.
