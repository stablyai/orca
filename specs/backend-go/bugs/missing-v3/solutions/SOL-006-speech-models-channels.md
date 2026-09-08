# SOL-006: `speech.models.*` — don't implement; this is a desktop-instance-scoped concept with no coherent home in a stateless `backend-go` fleet

**Resolves:** [BUG-006](../BUG-006-speech-models-channels-not-implemented.md)
**Service:** None proposed. No `backend-go` service is architecturally positioned to own this — see the verdict below.
**Affected files (proposed):**
- `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts` (add `'speech'` to `DESKTOP_ONLY_NAMESPACES` — it is currently **missing** from that list despite being exactly the kind of namespace it exists for; see "A live, unclassified gap today" below)
- `specs/backend-go/bugs/missing-v3/BUG-006-speech-models-channels-not-implemented.md` (update Status from "❌ Open — capability gap" to a "will not be implemented, by design" verdict, mirroring how `ephemeralVm`/`mobile`/`orcaProfiles`/`remoteWorkspace` are already documented as deliberate non-ports rather than open gaps)
- No `backend-go` code changes proposed.
**Status:** 🚧 Proposed — no code written (a "do not implement" design, not a deferred one)

---

## Verdict up front

`speech.models.*` is not a "portable, blocked on missing infra" namespace
like `ephemeralVm.*` or `browser.*` — it belongs in the other bucket
`AGENTS.md`'s house style already has room for:
`desktop-only-rpc-error-suppressor.ts`'s `DESKTOP_ONLY_NAMESPACES`, next to
`mobile`, `orcaProfiles`, and `remoteWorkspace` — namespaces whose header
comments already explain, for each, **why the problem they solve doesn't
exist in server mode** rather than proposing a relay. This proposal reaches
the same conclusion for `speech.models.*`, for a reason specific to this
namespace that those three don't share: unlike them, this one doesn't even
fail the "is there a single machine this could relay to" test the same way
`ephemeralVm.*`/`browser.*` pass it.

## Why this isn't dev-server/worktree-scoped in the first place — the load-bearing finding

Every other `missing-v3`/`missing-v1` relay-shaped bug
(`ephemeralVm.*`, `browser.*`, `terminal.*`) resolves "which host does this
work belong to" via a `connectionId`/`worktree`/`repoId` — the work is tied
to a specific repo or dev server. Speech dictation is not. The desktop's
own implementation says so explicitly, in a comment that is the single most
important piece of evidence for this proposal:

`desktop/src/main/runtime/orca-runtime-mobile-dictation.ts:45-46`:
> "Lists the speech-model catalog joined with live download/ready state...
> **Always targets this (paired) desktop — speech never routes to a
> worktree's SSH host.**"

This is a deliberate architectural statement, not an oversight: a mobile
client pairs directly with **one desktop process**, and every
`speech.models.*`/`speech.dictation.*` call always means "the desktop I'm
paired with," full stop — there is no per-repo, per-worktree, or
per-dev-server resolution step anywhere in this feature, unlike
`ephemeralVm.*` (repo-scoped) or `browser.*` (worktree-scoped). That
absence is the reason this bug's fix can't be "relay to whichever dev
server the active connection resolves to" the way `ephemeralVm.*`/
`browser.*`'s fixes are — there is no such resolution to port; the entire
feature's design assumes exactly one long-lived process holding local
state.

## What "the paired target" becomes in environment mode — and why it doesn't have an analogue

In local/desktop-pairing mode, "the paired target" is the one Electron main
process the mobile app connected to, with a durable
`app.getPath('userData')` directory that survives restarts and belongs to
exactly one machine. In environment mode
(`settings.activeRuntimeEnvironmentId` resolved by
`frontend/src/renderer/src/runtime/runtime-rpc-client.ts:47-55`'s
`getActiveRuntimeTarget`), "the paired target" is a single `backend-go`
environment — but a `backend-go` environment is, by explicit design, a
**horizontally-scaled, multi-tenant container fleet**, not one durable
machine:

- `specs/backend-go/tdd/services/infra-fleet-service.md` §8: "this service
  is horizontally scaled (multiple pods)... other pods resolve which pod
  owns [a live transport] (or re-establish)... rather than assuming shared
  in-memory state" — pods are explicitly not a place durable per-connection
  state lives.
- Nothing in `backend-go` has a `dev_server`/`connection` concept for
  speech at all, because (per the finding above) speech was never
  dev-server-scoped to begin with — there is no "resolve the repo's Dev
  Server, relay there" fallback to reach for the way `ephemeralVm.*`
  reaches for `git-gateway-service`'s repo→host dispatch.

So the question isn't "which dev server should this relay to" (answerable,
if awkwardly) — it's "which of `backend-go`'s many interchangeable,
stateless pods should hold a ~74-180MB downloaded ONNX model archive and
run inference against it," which has no good answer by the fleet's own
design constraints. This is confirmed, not assumed: I checked
`ai-provider-service` and `tenant-service`'s TDD docs directly, per
BUG-006's own request.

## Checked `ai-provider-service.md` — nothing speech-shaped, and reusing it would conflate two different credential concepts

BUG-006 already confirmed `ai-provider-service`'s actual proto has nothing
speech-shaped
(`backend-go/proto/orca/aiprovider/v1/aiprovider.proto:13-33`). Reading
`specs/backend-go/tdd/services/ai-provider-service.md` in full for whether
the *target* architecture sketches anything speech-adjacent: it does not —
its entire bounded context is "AI provider accounts" (Anthropic/OpenAI/
Google/Azure/AWS/Ollama/vLLM) used to spawn **AI coding-agent CLI
sessions**, and its own schema (`ai_provider.accounts`, §5) makes this
concrete: every account row carries a **mandatory `dev_server_id`**
(`ai-provider-service.md:133` — `dev_server_id UUID NOT NULL`, "logical FK
-> infra-fleet-service"), because these accounts exist to have their
ciphertext pushed to a specific execution host ahead of an agent spawn
(§9's whole "ciphertext push" design). That is a fundamentally different
credential concept from "does this user have a personal OpenAI API key for
their own voice dictation" — confirmed on the desktop side too: the
OpenAI key `hasOpenAiSpeechApiKey()` checks is read from a **dedicated,
separate** encrypted file,
`desktop/src/main/speech/openai-api-key-store.ts:9-10`'s
`OPENAI_SPEECH_TOKEN_FILE = 'openai-speech-token.enc'`, distinct from
whatever store holds a user's AI-coding-agent provider keys. Routing
`speech.models.*`'s OpenAI-catalog-entry state through
`ai-provider-service.ListAccounts` would silently conflate these two
unrelated credentials under one lookup — a correctness bug waiting to
happen, not a shortcut. There is no existing `backend-go` credential
concept for "a personal OpenAI key for speech," and building one is new,
narrow, single-purpose infrastructure for a mobile-only, dev-tool-adjacent
feature — a poor cost/benefit trade discussed further below.

## Checked `tenant-service.md` — `user_profiles.settings` could hold prefs, but there's nothing to make them do anything

`tenant-service.md`'s `user_profiles` table
(`tenant-service.md:162`, `settings JSONB DEFAULT '{}'`) plus its
`GetUserProfile`/`UpdateUserProfile` RPCs
(`tenant-service.md:72-73`) is a real, already-designed place a
`speech.models.list` implementation *could* durably persist the
`enabled`/`selectedModelId`/`dictationMode` fields
`RuntimeSpeechSetupState` (`mobile/src/vendor-shared/shared/runtime-types.ts:648-654`)
requires alongside the model catalog. This part is genuinely low-risk and
buildable. But it's not worth building in isolation: `speech.dictation.*`
(the RPCs that would actually *read* `enabled`/`selectedModelId` to decide
whether to run a dictation session) is explicitly out of scope for BUG-006
and has no implementation plan of its own — so persisting these fields now
would create settings that can influence nothing, since no model can ever
reach `status: 'ready'` in environment mode (see next section) and no
dictation session exists to gate on `enabled` even if one could. Building
the settings-write half without a reachable settings-read consumer is
scope for its own sake — flagged here as a reason to hold, not a technical
blocker.

## Why even the "cheap half" (OpenAI-catalog entries) isn't actually cheap

`SPEECH_MODEL_CATALOG` (`desktop/src/main/speech/model-catalog.ts:1-161`)
splits every entry by `provider: 'local' | 'openai'`
(`desktop/src/shared/speech-types.ts:2`). It's tempting to conclude the
`openai`-provider entries (`openai-gpt-4o-mini-transcribe`,
`openai-gpt-4o-transcribe`, lines 141-160) are the portable half — no
74-180MB archive, no ONNX runtime, just a credential check — and ship only
those. Investigated directly: this doesn't reduce to a small feature.

- **List** would need a new, dedicated "speech OpenAI key" existence-check
  in `backend-go` — not reusable from `ai-provider-service` per the
  conflation problem above, so it's new storage plus a new RPC, for a
  binary "is a key configured" fact.
- **Download/delete** for `openai`-provider entries are **already
  unsupported on desktop itself** — `ModelManager.downloadModel`
  (`desktop/src/main/speech/model-manager.ts:164-166`) throws `Model does
  not support downloads` for any non-`isLocalSpeechModel` manifest, and
  `deleteLocalSpeechModel`
  (`desktop/src/main/speech/speech-model-deletion.ts:60-62`) throws
  `voice_model_not_deletable` the same way. Porting these two RPCs for
  `openai`-provider IDs is therefore trivial (return the same rejection,
  no relay, no new storage) — but that's exactly the part that needs no
  design work at all.

So the "cheap half" is cheap only for the two methods that don't do
anything interesting, and requires new bespoke credential infrastructure
for the one that would. That is a bad trade for a feature whose only live
consumer today is a single mobile settings sheet
(`mobile/src/dictation/mobile-dictation-setup.ts`).

## Local-provider models: confirmed, not assumed, to have no coherent remote home

`model-catalog.ts`'s `local`-provider entries are 74MB-180MB `sherpa-onnx`
ONNX archives (`downloadUrl`s pointing at GitHub release assets,
`model-catalog.ts:13-14` etc.), downloaded via `ModelManager.downloadFile`
(`model-manager.ts:312-496`, using Electron's `net.request` — an
Electron-main-process-specific API, not portable to a Go service as-is
regardless of the architectural question), verified by SHA-256, extracted
with `tar`, and read back by a native ONNX inference engine
(`SttService`, referenced but out of scope per BUG-006's own exclusion of
`speech.dictation.*`). Every one of these steps assumes a single,
long-lived, disk-durable process — the opposite of `backend-go`'s pod
model. There is no dev-server/worktree concept to fall back to (per the
finding above), so unlike `ephemeralVm.*`'s Group 2b (blocked on a missing
but *identifiable* single target — the repo's Dev Server), there is no
"if only X existed" fallback host to point at when the whole system's
sharing unit is a stateless, replicated fleet, not a fixed machine.

## A live, unclassified gap today — worth fixing regardless of this verdict

`speech` is currently **absent** from
`desktop-only-rpc-error-suppressor.ts`'s `DESKTOP_ONLY_NAMESPACES`
(`frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts:57-72`
lists `shell`, `ephemeralVm`, `mobile`, `app`, `updater`, `pet`, `ui`,
`computerUsePermissions`, `developerPermissions`, `e2e`, `export`,
`localhostWorktreeLabels`, `orcaProfiles`, `remoteWorkspace` — no
`speech`). This means a mobile client paired to a `backend-go` environment
that opens the dictation setup sheet today gets `registry.go`'s raw
`notImplementedHandler` message
(`channel "speech.models.list" is not yet implemented in backend-go — see
backend-go/docs/execution-plan.md's...`,
`backend-go/services/api-gateway/internal/adapter/wscompat/registry.go:195-197`)
surfaced essentially verbatim as `Failed to load dictation models`
(`mobile-dictation-setup.ts:39`'s fallback), rather than being silenced as
an expected, classified gap the way `ephemeralVm`/`mobile`/`orcaProfiles`
already are. Note also that `mobile-dictation-setup.ts:17-24`'s own
`isLegacyDesktopSpeechSetupError` heuristic (checking for `error?.code ===
'method_not_found'`) is aimed at a *different*, already-handled case — an
old desktop predating `speech.models.list` — and would not fire for this
one anyway (the `wscompat` error's code is unlikely to be
`method_not_found`), so today's failure mode is the raw, undifferentiated
message, not even the (also slightly wrong, "update the paired desktop")
legacy-guidance path. Adding `'speech'` to `DESKTOP_ONLY_NAMESPACES` is a
small, independent fix worth making regardless of whether the verdict above
is later revisited — it correctly reclassifies a real, permanent
architecture mismatch as a known one instead of leaving it as unclassified
noise.

## If this verdict is ever revisited

Two independent conditions would need to both hold before reconsidering:
(1) real product demand for voice dictation against `backend-go`-paired
environments specifically (not just desktop-paired), and (2) a decision on
where inference would actually execute — the only architecturally coherent
answer, if this is ever pursued, is **the environment's Dev Server**, not
`backend-go` itself, the same conclusion `ephemeralVm.*`/`browser.*` reach
for their own execution-plane work — which would first require this
feature to grow the dev-server/worktree resolution step it deliberately
doesn't have today (a product redesign, not a backend wiring fix), plus the
new agent-side model-download/ONNX-execution capability that would imply.
This proposal does not sketch that design — per the investigation above,
there is no current evidence it's warranted, and sketching a design nobody
asked for is exactly the "don't force an implementation design" this
proposal is declining to do.

## Test plan

None — no `backend-go` code is proposed. If `'speech'` is added to
`DESKTOP_ONLY_NAMESPACES`, that change's own existing test coverage for the
suppressor (verifying listed namespaces are silenced) extends to it
automatically; no new test is needed beyond confirming the constant
includes the new entry.

## References

- `desktop/src/main/runtime/orca-runtime-mobile-dictation.ts:45-46` — the
  load-bearing comment: dictation "Always targets this (paired) desktop —
  speech never routes to a worktree's SSH host"
- `specs/backend-go/tdd/services/infra-fleet-service.md` §8 — pod
  statelessness / horizontal scaling, why there is no durable
  single-machine analogue in `backend-go`
- `specs/backend-go/tdd/services/ai-provider-service.md` §1-§5 (bounded
  context: AI-coding-agent provider accounts only, nothing speech-shaped),
  `:133` (`dev_server_id UUID NOT NULL` — why its accounts are the wrong
  credential concept to reuse for a personal speech key)
- `desktop/src/main/speech/openai-api-key-store.ts:9-10` — the dedicated,
  separate `openai-speech-token.enc` store, confirming the credential
  conflation risk
- `specs/backend-go/tdd/services/tenant-service.md:72-73,162` —
  `GetUserProfile`/`UpdateUserProfile` and `user_profiles.settings JSONB`,
  the real (but, per above, not currently worth using) place
  `enabled`/`selectedModelId`/`dictationMode` could live
- `desktop/src/main/speech/model-catalog.ts:1-161` — the full catalog,
  `provider: 'local' | 'openai'` split
- `desktop/src/main/speech/model-manager.ts:151-260,312-496` —
  `downloadModel`/`downloadFile`, confirming the local-model download path
  is Electron-main-process-specific and disk-durable-single-process shaped
- `desktop/src/main/speech/model-manager.ts:164-166`,
  `desktop/src/main/speech/speech-model-deletion.ts:60-62` — desktop's own
  rejection of download/delete for non-local (`openai`) models, ported
  as-is for the "cheap half"
- `mobile/src/vendor-shared/shared/runtime-types.ts:638-654` —
  `RuntimeSpeechModelSummary`/`RuntimeSpeechSetupState`, the response shape
  a real `speech.models.list` would need to fill
- `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts:30-72`
  — `DESKTOP_ONLY_NAMESPACES` and its header comments for `mobile`/
  `orcaProfiles`/`remoteWorkspace`, the precedent this proposal's verdict
  follows; confirms `speech` is currently absent
- `backend-go/services/api-gateway/internal/adapter/wscompat/registry.go:195-197`
  — `notImplementedHandler`, the raw message currently leaking through
  today
- `mobile/src/dictation/mobile-dictation-setup.ts:1-58` — the live mobile
  consumer, its existing (non-firing, for this case) legacy-error handling
- `specs/backend-go/bugs/missing-v3/BUG-006-speech-models-channels-not-implemented.md`
  — problem statement this resolves
- `specs/backend/api/desktop-only-rpc-parity-gaps.md` §A/§C — the
  precedent methodology for classifying a namespace as a deliberate
  non-port rather than an open gap, applied here
