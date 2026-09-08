# BUG-005: `starNag.*` channels not implemented in backend-go

**Service:** `api-gateway` (dispatch) — no owning service exists, and none is a natural fit
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/*.go`
**Severity:** Low — this is a purely cosmetic growth/engagement prompt ("please star Orca
on GitHub" nag card/toast), not a workflow-blocking feature. A paired/web client on a
remote backend-go target simply never sees the nag (and can't dismiss/defer/complete/
disable one, or fire the "value moment" trigger) — no data loss, no broken core flow.
**Status:** ❌ Open — capability gap; no owning service found anywhere in backend-go.

---

## Description

`starNag.*` drives a "star Orca on GitHub" nag UI (`StarNagCard.tsx`,
`star-nag/StarNagToastHost.tsx`, `star-nag/StarNagAgentValueMomentObserver.tsx`) shown at
value moments (onboarding completion, agent task completion, etc.), backed by a
single desktop-process `StarNagService` singleton
(`desktop/src/main/star-nag/service.ts:46`) that tracks prompt visibility/cooldown/
threshold state.

The frontend's hybrid RPC client routes every one of the 10 request/response methods
(plus a `subscribe`/`unsubscribe` streaming pair not counted in this namespace's 10, see
below) through the same `{kind:'local'} → window.api.starNag.X` /
`{kind:'environment'} → callRuntimeRpc(target, 'starNag.X', ...)` shape used by every
other hybrid client in this codebase:

`frontend/src/renderer/src/runtime/runtime-star-nag-client.ts:79-177` — `dismissRuntimeStarNag`,
`deferRuntimeStarNag`, `completeRuntimeStarNag`, `disableRuntimeStarNag`,
`openWebRuntimeStarNag`, `starRuntimeOrcaFromNag`, `forceShowRuntimeStarNag`,
`prepareRuntimeStarNagAgentValueMoment`, `showRuntimeStarNagAgentValueMoment`,
`notifyRuntimeStarNagOnboardingCompleted` — the 10 methods this report covers
(`starNag.dismiss/later/complete/disable/openWeb/starOrca/forceShow/agentValueMoment/
showAgentValueMoment/onboardingCompleted`).

None of these 10 channel names appear in `wscompat`'s registered-channel list (grep of
all `*.go` files under `wscompat/` for `.Register("starNag` returns zero matches, out of
309 total registered channels), so every call falls through to `registry.go`'s
`notImplementedHandler`.

The companion streaming channel `starNag.subscribe` (+ `starNag.unsubscribe`) —
`frontend/src/renderer/src/runtime/runtime-star-nag-client.ts:29-77` — is also
unregistered but is a transport-level gap of the same kind BUG-035
(`missing-v1/BUG-035-ws-server-push-not-implemented.md`) already documents at the
infrastructure level (no server→client push/subscription registry exists in
`wscompat` at all yet); not re-litigated here as one of the "10 methods."

**This is not a "does this even make sense remotely" open question** — the old TS
`backend/` already ported all 12 `starNag.*` methods in full for its own server mode
(2026-08-16, see the `starNag.*` row in `specs/backend/api/desktop-only-rpc-parity-gaps.md`'s
"Đã fix trong phiên này" table: "port đầy đủ... 1 điều chỉnh thật: bỏ gate
`if (!BrowserWindow)`"), and `starNag` is correctly **absent** from
`frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts`'s
`DESKTOP_ONLY_NAMESPACES` (it was removed once ported — see that file's header
comment). So the feature is proven server-mode-appropriate and low-effort to
implement (no OS/window dependency once the `BrowserWindow` gate is dropped); this
is purely backend-go lagging behind a capability the old backend already has.

## What's missing

Desktop-local implementation this namespace mirrors, all delegating to the single
`StarNagService` instance:

- `desktop/src/main/runtime/rpc/methods/star-nag.ts:34-141` — `STAR_NAG_METHODS`, the
  desktop's own in-process RPC method table (paired client → desktop-as-host path)
- `desktop/src/main/star-nag/service.ts:46` — `StarNagService` class; methods `dismiss`
  (`:303`), `defer`, `markCompleted`, `disable`, `openWeb`, `starOrcaFromNag`,
  `forceShow`, `prepareAgentValueMoment` (`:265`), `showPreparedAgentValueMoment`
  (`:269`), `onboardingCompleted` (`:275`), `onVisibilityChanged` (`:231`) — also wired
  to raw Electron IPC at `:104-113` (`ipcMain.handle('star-nag:dismiss', ...)` etc.) for
  the desktop's own renderer.

## Owning service verdict: none found

A broad search for any star-nag/growth-nag/value-moment concept anywhere in
`backend-go/` (proto, usecase, adapter — grep for `star.?nag`, `StarNag`, `starOrca`,
`value.?moment`, `ValueMoment`) returns **zero real matches** (one incidental regex
false-positive in `channels_nativechat.go` on unrelated text, not a real hit). No
service — `tenant-service`, `project-service`, or otherwise — has any concept of
per-user GitHub-star nagging, onboarding-completion tracking for this purpose, or
"agent value moment" state. This is a **capability gap** with no natural owning
service; if ported to backend-go at all, it would need a new small piece of per-user
state (dismissal/cooldown/threshold), most plausibly hung off `tenant-service`'s
per-user profile store, but nothing today provides even a starting point.

## Missing channels

| Method | Frontend call site | Notes |
|---|---|---|
| `starNag.dismiss` | `runtime-star-nag-client.ts:79-87` | No backing service anywhere. |
| `starNag.later` | `runtime-star-nag-client.ts:89-97` | No backing service. |
| `starNag.complete` | `runtime-star-nag-client.ts:99-107` | No backing service. |
| `starNag.disable` | `runtime-star-nag-client.ts:109-117` | No backing service. |
| `starNag.openWeb` | `runtime-star-nag-client.ts:119-127` | No backing service. |
| `starNag.starOrca` | `runtime-star-nag-client.ts:129-137` | No backing service. Note: the legacy TS backend's `github.starOrca` was flagged elsewhere (`backend-agent-execution-boundary.md`) as a security-relevant path bypassing the multi-user CLI guard — `starNag.starOrca` is a distinct namespace/method from `github.starOrca` and calls into `StarNagService.starOrcaFromNag()`, not a shared-credential CLI exec path; that legacy concern does not obviously apply here but is worth re-checking if this is ever implemented. |
| `starNag.forceShow` | `runtime-star-nag-client.ts:139-147` | No backing service. |
| `starNag.agentValueMoment` | `runtime-star-nag-client.ts:149-157` | No backing service. |
| `starNag.showAgentValueMoment` | `runtime-star-nag-client.ts:159-167` | No backing service. |
| `starNag.onboardingCompleted` | `runtime-star-nag-client.ts:169-177` | No backing service. |

---

## References

- `frontend/src/renderer/src/runtime/runtime-star-nag-client.ts:1-177` — hybrid routing client, header "Why" comment
- `desktop/src/main/runtime/rpc/methods/star-nag.ts:1-142` — desktop-local RPC method table
- `desktop/src/main/star-nag/service.ts:46-113,231,265,269,275,303` — `StarNagService`
- `frontend/src/renderer/src/components/StarNagCard.tsx:1-60` — nag card UI, routes through the hybrid client (not `window.api` directly)
- `backend-go/services/api-gateway/internal/adapter/wscompat/registry.go` — `notImplementedHandler`
- `specs/backend-go/bugs/missing-v1/BUG-035-ws-server-push-not-implemented.md` — sibling transport-level gap covering `starNag.subscribe`'s push mechanism
- `specs/backend-go/bugs/missing-v1/README.md` — methodology/format precedent
