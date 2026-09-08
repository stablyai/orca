# BUG-006: `speech.models.*` channels not implemented in backend-go

**Service:** `api-gateway` (dispatch) — no owning service exists (checked `ai-provider-service`)
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/*.go`
**Severity:** Medium — breaks voice-dictation model setup (list/download/delete Whisper-style
speech models) specifically for the **mobile app paired to a remote/backend-go-backed
runtime environment**. Desktop's own renderer never hits this path today (see below), so
this does not affect the desktop UI, but it fully blocks the mobile app's speech-model
management screen against any backend-go target.
**Status:** ✅ Resolved, by design — **not implemented as a backend-go RPC**.
See [`solutions/SOL-006-speech-models-channels.md`](./solutions/SOL-006-speech-models-channels.md)
for the full investigation: dictation always targets the paired desktop
process holding the local model files — there is no dev-server/worktree
concept to relay to, unlike `ephemeralVm.*`/`browser.*`. The one concrete
action this verdict called for —
adding `speech` to `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts`'s
`DESKTOP_ONLY_NAMESPACES` (was absent — a live, unclassified gap; see
[`tasks/TASK-007-speech-add-desktop-only-namespace.md`](./tasks/TASK-007-speech-add-desktop-only-namespace.md)) —
is done. Treat the severity/description below as the pre-investigation
framing, kept for history rather than as a description of current behavior.

---

## Description

`speech.models.*` lists/downloads/deletes local speech-to-text models used for voice
dictation. The frontend's hybrid client routes it through the standard pattern —
`{kind !== 'environment'} → window.api.speech.X` (desktop IPC) /
`{kind === 'environment'} → callRuntimeRpc(target, 'speech.models.X', ...)`:

`frontend/src/renderer/src/runtime/runtime-speech-client.ts:25-62` —
`speechGetModelStates` (→ `speech.models.list`), `speechDownloadModel` (→
`speech.models.download`), `speechDeleteModel` (→ `speech.models.delete`).

None of the 3 channel names appear in `wscompat`'s registered-channel list (0 matches
for `speech.models` out of 309 registered channels), so every call falls through to
`registry.go`'s `notImplementedHandler`.

**Who actually calls this today:** `frontend/src/renderer/src/runtime/runtime-speech-client.ts`
has **zero importers anywhere in `frontend/src`** — the desktop settings UI
(`frontend/src/renderer/src/components/settings/VoiceSpeechModelSection.tsx`,
`VoicePane.tsx`) calls `window.api.speech.*` **directly**, bypassing this hybrid client
entirely, so the desktop renderer never exercises the `speech.models.*` RPC path
regardless of active runtime target. The real, live consumer is the separate mobile app:

`mobile/src/dictation/mobile-dictation-setup.ts:34,48,58` — `client.sendRequest('speech.models.list', null)`,
`client.sendRequest('speech.models.download', { modelId })`,
`client.sendRequest('speech.models.delete', { modelId })`, sent over the mobile app's
own RPC transport to whatever runtime it is paired with. When that runtime is a
backend-go-backed environment (not the desktop app directly), these calls hit the same
unimplemented `wscompat` channels. (Note `mobile-dictation-setup.ts:15-22`'s own
backward-compat comment: mobile already handles pairing with older desktop runtimes
that predate `speech.models.list` — the failure mode for "channel doesn't exist" is a
known, handled case there, but a real gap for backend-go specifically.)

## What's missing

Desktop-local implementation this namespace mirrors:

- `desktop/src/main/runtime/rpc/methods/speech.ts:51-66` — `SPEECH_METHODS`'s
  `speech.models.list` / `speech.models.download` / `speech.models.delete` entries,
  delegating to `runtime.listMobileSpeechModels()` / `runtime.downloadMobileSpeechModel()`
  / `runtime.deleteMobileSpeechModel()` on the desktop's `OrcaRuntimeService`.
- `desktop/src/main/speech/speech-runtime-service.ts` — actual model-state/download
  bookkeeping.
- `desktop/src/main/speech/speech-model-deletion.ts` — deletion logic.

Explicitly **not** in scope for this report (per the frontend client's own header
comment, `runtime-speech-client.ts:1-6`): the live dictation session itself
(`speech.dictation.setup/start/chunk/finish/cancel` +
`onPartialTranscript/onFinalTranscript/onStopped/onError`) is deliberately not wrapped
by this hybrid client and is a separate concern from model management.

## Owning service verdict: none found

`ai-provider-service` is the natural candidate (an LLM/AI-provider account and usage
management service), but its proto has nothing speech/transcription/dictation-shaped:

`backend-go/proto/orca/aiprovider/v1/aiprovider.proto:13-33` — full
`AiProviderService` RPC list: `CreateAccount`, `ResolveProvider`, `RotateKey`,
`GetUsageToday`, `ListAccounts`, `UpdateAccount`, `DeleteAccount`, `WriteCredential`,
`TestConnection` — all LLM-provider-account concerns, nothing about local speech
models.

`backend-go/services/ai-provider-service/internal/usecase/` — directory listing (10
usecase files) confirms no speech/transcription/dictation usecase exists.

A repo-wide search (`grep -rln "speech\|Speech\|transcri\|Transcri\|dictation\|Dictation" backend-go/services/`)
returns **zero real matches** anywhere in `backend-go` — not `ai-provider-service`, not
any other service. This is a **capability gap** with no owning service: speech models
are currently a purely local-desktop-filesystem concept (downloaded model files
managed on the desktop host); backend-go has no equivalent storage/serving concept for
a remote/backend-go-backed runtime to host them from.

## Missing channels

| Method | Frontend/mobile call site | Notes |
|---|---|---|
| `speech.models.list` | `runtime-speech-client.ts:25-36`; `mobile/src/dictation/mobile-dictation-setup.ts:34` | No backing RPC on any service; live mobile-app consumer. |
| `speech.models.download` | `runtime-speech-client.ts:38-51`; `mobile-dictation-setup.ts:48` | No backing RPC; live mobile-app consumer. |
| `speech.models.delete` | `runtime-speech-client.ts:53-62`; `mobile-dictation-setup.ts:58` | No backing RPC; live mobile-app consumer. |

---

## References

- `frontend/src/renderer/src/runtime/runtime-speech-client.ts:1-62` — hybrid routing client, unused by any current frontend importer
- `mobile/src/dictation/mobile-dictation-setup.ts:1-58` — the real, live caller of `speech.models.*` over RPC
- `desktop/src/main/runtime/rpc/methods/speech.ts:51-66` — desktop-local RPC method table
- `desktop/src/main/speech/speech-runtime-service.ts`, `desktop/src/main/speech/speech-model-deletion.ts` — desktop-local model management logic
- `frontend/src/renderer/src/components/settings/VoiceSpeechModelSection.tsx`, `VoicePane.tsx` — desktop settings UI, calls `window.api.speech.*` directly (bypasses this hybrid client)
- `backend-go/proto/orca/aiprovider/v1/aiprovider.proto:13-33` — full `AiProviderService` RPC list (nothing speech-shaped)
- `backend-go/services/ai-provider-service/internal/usecase/` — directory listing, no speech/dictation usecase
- `backend-go/services/api-gateway/internal/adapter/wscompat/registry.go` — `notImplementedHandler`
- `specs/backend-go/bugs/missing-v1/README.md` — methodology/format precedent
