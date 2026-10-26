# Local voice turn models

The desktop voice panel uses Smart Turn v3.2 for audio end-of-turn detection and a
quantized multilingual MiniLM encoder with locally fitted linear heads for English, Chinese, Korean, Japanese, Spanish, French and Portuguese
overlap intent and whether the assistant expects an answer. Runtime intent
classification has no acknowledgment/stop keyword list or Korean suffix regex.
Confidence thresholds, scheduling and cancellation fences remain application logic.

Voice attaches to the selected Codex chat and shares its session, model, permissions,
and transcript. Opening the sidebar never creates a session; **New chat** is explicit.
The history tab leaves capture mounted. No raw audio recording is saved.

Settings let users follow the app language or choose any built-in Orca language.
The model picker can show only matching live models, with the existing download and
credential flows. Local streaming recognition currently covers English, Chinese and
Korean; Scribe Realtime automatically detects all seven languages. Batch recognizers
remain available for dictation, but are not offered for continuous conversation.
Local playback uses a selected installed system voice in the conversation language;
users can install voices through their OS and refresh the list. If the OS exposes no
matching voice to Electron, configure ElevenLabs output instead. Providers never
switch automatically. Cloud recognition and speech incur the provider's account costs.

This is experimental. The intent examples are authored synthetic text, not a
representative multilingual speech corpus. `evaluation.json` is a development report,
not independent accuracy: its examples were inspected while fitting the heads.
The text classifier depends on STT preserving question marks and words; it cannot
reconstruct an interrogative intonation omitted by STT. Smart Turn sees audio but
does not classify backchannels. Microphone echo cancellation remains necessary.
Endpoint inference starts when STT commits a segment, so provider finalization
latency still applies. This change does not promise a faster overall response.

The first desktop start downloads 37,340,301 bytes into the existing speech model
cache, under `sts-turn-v1`. Revisions, sizes and SHA-256 checksums are pinned in
`src/shared/sts-turn-models.ts`. Each load checks integrity. The renderer's worker
receives these fixed assets and performs inference with bundled single-thread
ONNX WASM; it cannot fetch inference models or call paid services. Neither audio
nor transcripts are logged or retained by the model worker. STT/TTS still follow
the user's selected providers and their existing costs.

Only one worker lives per voice conversation. Ending or closing the panel
terminates it and clears the bounded eight-second audio buffer. New transcripts
invalidate older predictions. Uncertain stop predictions retain the words.
Incomplete endpoint predictions are rechecked a bounded number of times, then
wait for more speech or **Send spoken words**, without ending the microphone.
The same button remains usable after inference failure. Model preparation failure
is shown explicitly; there is no silent keyword or cloud fallback.

The optional preload method keeps mixed-version clients compatible. This initial
implementation requires the desktop speech bridge; mobile/web clients without
that capability cannot start this model mode.

## Reproduce

Obtain the exact assets from the pinned manifest, verifying their checksums. Put
the encoder files in `intent/` (ONNX in `intent/onnx/model_quantized.onnx`) and
Smart Turn in `endpoint/smart-turn-v3.2-cpu.onnx` under a chosen local directory.

```sh
node config/voice-models/download.mjs <verified-model-directory>
node config/voice-models/train-intent.mjs <verified-model-directory>
pnpm build:electron-vite
ORCA_BACKGROUND_LAUNCH=1 node config/voice-models/smoke.mjs <verified-model-directory>
```

Training uses the frozen encoder on CPU and deterministic softmax regression.
Weights are checked in; training is not performed in the app. The browser smoke
check runs the actual bundled worker offline, checks multilingual intent/context cases,
checks endpoint execution on synthetic audio, and rejects external requests.
It does not measure microphone recognition or natural conversation accuracy.

## Model provenance

- [Smart Turn v3.2](https://huggingface.co/pipecat-ai/smart-turn-v3), revision
  `f766f81d3cfdf7737ac64aad813d91bbfd56bf93`, BSD-2-Clause.
- [MiniLM L6 distilled ONNX](https://huggingface.co/onnx-community/minilm-student-L6_uniform_distilled-ONNX),
  revision `6aa4deb590ea89b4b9ae217015042618defff20d`, Apache-2.0. Encoder derived from
  `gomyk/minilm-student-L6_uniform_distilled` and multilingual MiniLM L12.
- Feature extraction uses Transformers.js's Whisper feature extractor with
  left padding and waveform normalization matching Pipecat's reference.
- Authored examples and fitted heads are provided under this repository's license.
