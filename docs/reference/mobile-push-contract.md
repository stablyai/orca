# Mobile push: contract and build spec

Tracking issue: stablyai/orca#8129. Design page: `/tmp/orca-mobile-push/orca-mobile-push.html`.
This document is the single contract every lane builds against. Do not deviate without updating it.

## Summary

A small Orca-hosted push gateway (`cloud/apps/push`) holds the APNs key and FCM credentials and sends
to phones. The desktop host registers each paired phone's native push token with the gateway and asks
the gateway to push on every mobile notification it already fans out over the socket. The phone dedupes
by `notificationId#notificationSeq`. No ack gate, no generic mode, no staging gateway, one auth path for
signed-in and accountless hosts.

## Identities

- **Host public key**: the desktop's existing X25519 E2EE public key (`src/main/runtime/e2ee-keypair.ts`),
  32 bytes, base64. The phone already stores it per host as `publicKeyB64`.
- **hostFingerprint**: `sha256(hostPublicKey)` base64url, first 16 chars. Identical derivation to
  `deriveRelayHostId` in `src/main/runtime/relay/relay-http-client.ts`. Both desktop and phone can compute it.
- **deviceId**: the desktop's `DeviceEntry.deviceId` for the paired phone. Opaque UUID.
- **registrationId**: gateway-assigned opaque id for one (hostFingerprint, deviceId) pair.

## Gateway HTTP API

Base URL: `https://push.onorca.dev` (dev override via env). JSON bodies, `Content-Type: application/json`.
All schemas are zod, `.strict()`, exported from `cloud/packages/push-contract`.

### Host authentication: challenge, proof, session

The host keypair is X25519 (box), so it cannot sign. Reuse the relay's challenge shape.

`POST /v1/host/challenge`
```json
{ "v": 1, "hostPublicKeyB64": "<32 bytes b64>" }
```
→ 200
```json
{ "challengeId": "<opaque>", "gatewayEphemeralPublicKeyB64": "<32 b64>", "nonceB64": "<24 b64>",
  "ciphertextB64": "<b64>", "expiresAt": <epoch ms> }
```
- Gateway generates an ephemeral box keypair per challenge, a 24-byte nonce, and a 32-byte secret.
- `plaintext = "orca-push-host-challenge/v1\0" || u32be(len(transcript)) || transcript || secret(32)`
- `ciphertext = nacl.box(plaintext, nonce, hostPublicKey, gatewayEphemeralSecretKey)`
- Transcript is the relay's length-prefixed field encoding (`field(name, value)` =
  u32be(len(name)) || name || u32be(len(value)) || value), fields in this exact order:
  `protocol="orca-push-host-proof/v1"`, `version=0x01`, `gatewayOrigin`, `gatewayEphemeralPublicKey`,
  `challengeNonce`, `challengeId`, `issuedAt` (u64be ms), `expiresAt` (u64be ms), `hostFingerprint`,
  `hostPublicKey`.
- Challenge TTL 10 s, and 10 s is the whole window the gateway honours. The 30 s clock skew tolerance
  is the host's alone: it validates a timestamp the gateway chose, so it needs the allowance and the
  gateway does not. A gateway that subtracted the tolerance from its own check would run a 40 s TTL.
  Store challenge (id, secret hash, host fingerprint, host public key, expiry) in DB so any Cloud Run
  instance can verify. Expired rows are pruned 30 s late so a slow proof reads as expired rather than
  as an unknown challenge.
- Issuing a challenge writes no `push_hosts` row. It is unauthenticated, so a `push_hosts` row would be
  a free permanent write for any caller. The row is upserted in `POST /v1/host/session` once the proof
  verifies, from the public key the challenge row carries.

`POST /v1/host/session`
```json
{ "v": 1, "challengeId": "<opaque>", "proofB64": "<32 b64>" }
```
- Host opens the box with its secret key, validates every transcript field (same checks as
  `validateTranscript` in `src/main/runtime/relay/relay-host-proof.ts`, adapted to the push fields),
  and returns `proof = HMAC-SHA256(secret, "orca-push-host-proof/v1\0ack\0" || transcript)`.
- Gateway verifies with `timingSafeEqual`, consumes the challenge (single use), and returns
```json
{ "sessionToken": "<opaque 32 b64url>", "expiresAt": <epoch ms>, "hostFingerprint": "<16 chars>" }
```
- Session TTL 24 h. Stored hashed (sha256) in DB. Bearer on every other call:
  `Authorization: Bearer <sessionToken>`. 401 with `{ "error": "session_expired" }` on expiry; host
  re-runs the challenge.

### Device registration

`POST /v1/devices` (Bearer)
```json
{ "v": 1, "deviceId": "<uuid>", "platform": "ios" | "android", "token": "<native token>",
  "apnsEnvironment": "sandbox" | "production",   // ios only, required for ios
  "filter": { "sources": ["agent-task-complete", "terminal-bell", "plugin"],
              "agentStates": ["needs-input", "finished"] } }
```
→ 200 `{ "registrationId": "<opaque>" }`. Upsert keyed by (hostFingerprint, deviceId); a new token
replaces the old. `deviceId` is caller-chosen, so a host is capped at 64 registrations: the 65th
distinct `deviceId` → 409 `{ "error": "too_many_devices" }`. Re-registering a `deviceId` the host
already owns is always accepted, and deleting a registration frees its slot. `GET /v1/devices` is
bounded at 1024 rows to match its response schema, which the per-host cap keeps well out of reach.
`filter` is stored but enforced by the host (see desktop); gateway stores it only so a
host restart can re-read it. iOS token is 64 hex chars; Android token is the FCM registration string.

`DELETE /v1/devices/:registrationId` (Bearer) → 204. Only the owning host may delete.

`GET /v1/devices` (Bearer) → `{ "devices": [{ registrationId, deviceId, platform, dead: boolean }] }`.

### Send

`POST /v1/send` (Bearer)
```json
{ "v": 1,
  "registrationIds": ["<id>", "..."],
  "notification": {
    "notificationId": "<string, may be absent for terminal-bell>",
    "notificationSeq": <int>, "notificationEpoch": "<uuid>",
    "source": "agent-task-complete" | "terminal-bell" | "plugin",
    "agentState": "needs-input" | "finished" | null,
    "title": "<max 80 chars>", "body": "<max 180 chars>",
    "worktreeId": "<string|absent>" } }
```
→ 200
```json
{ "results": [{ "registrationId": "<id>", "status": "queued" | "dead" | "rate_limited" | "error" }] }
```
- `queued` means accepted into the coalescing window. `dead` means the provider reported the token
  unregistered; the host must drop the registration. Never block the socket fan-out on this call.
- Quota: 60 sends per hostFingerprint per rolling hour, 200 per registration per rolling day. Over quota
  → `rate_limited` per result, HTTP 200. Whole request over a hard cap of 20 registrationIds → 400.
  The cap counts the ids as sent; the gateway then dedupes them, so a repeated id spends quota once,
  yields one result, and counts once toward `coalescedCount`. `results` may therefore be shorter than
  `registrationIds`, and callers must match a result by its `registrationId`, never by position.
- Both quota counters are reserved under a per-host lock held for the whole transaction. PostgreSQL
  reads at READ COMMITTED, so a concurrent count-then-insert would otherwise admit a whole burst.

### Request limits and unauthenticated abuse

- Every POST is capped at 16 KiB by a streaming body limit, not by `Content-Length` alone: a chunked
  body declares no length. Over the cap → 413 `{ "error": "request_too_large" }`.
- `POST /v1/host/challenge` and `POST /v1/host/session` are the only unauthenticated routes. They share
  one token bucket per client IP, 30 requests per minute, refilling continuously. Over the bucket → 429
  `{ "error": "rate_limited" }`. The client IP is the **last** `x-forwarded-for` hop, not the first:
  Cloud Run appends the connecting peer, so everything left of that value is caller-supplied and can be
  a fresh forgery on every request, which would hand a flood a new bucket each time.
  `ORCA_PUSH_TRUSTED_PROXY_HOPS` (default 0) says how many appenders sit between the platform and the
  client, so a future load balancer sets it to 1. A header with fewer hops than that depth is not
  trusted at all. Falls back to `x-real-ip` and then to a single shared bucket. The bucket is per
  instance and in memory, so the effective cap scales with the instance count; it exists to blunt a
  flood, not to meter.

### Coalescing (gateway)

Per registrationId, hold sends for 3 s. If one event arrives, send it as-is. If N>1 arrive, send one
summary: title `Orca`, body `<N> agents need attention` (or `<N> updates` when no needs-input), data
carries the latest event's fields plus `coalescedCount`. Collapse id for a summary is
`host:<hostFingerprint>` so a later summary replaces it. The window is held in memory per gateway
instance, so with more than one instance a burst can produce up to one summary per instance; accepted
for this release, and the collapse id keeps the phone showing one banner.

### Provider payloads

APNs (HTTP/2, `api.push.apple.com` or `api.sandbox.push.apple.com` by `apnsEnvironment`; JWT auth
from key id + team id + `.p8`, token cached and refreshed every 50 min):
- headers: `apns-topic: com.stably.orca.mobile`, `apns-push-type: alert`, `apns-priority: 10`,
  `apns-expiration: now+4h`, `apns-collapse-id: <notificationId truncated to 64 bytes, or host:<fp>>`
- body: `{"aps":{"alert":{"title","body"},"sound":"default","thread-id":"<hostFingerprint>"},
  "orca":{ hostFingerprint, worktreeId, notificationId, notificationSeq, notificationEpoch, source,
  agentState, coalescedCount }}`
- Dead token: 410, or 400 with `BadDeviceToken`/`Unregistered`/`DeviceTokenNotForTopic`.

FCM (V1 `projects/onorca-cloud/messages:send`, bearer from the runtime service account via the GCE
metadata server or `GOOGLE_APPLICATION_CREDENTIALS` locally):
- `{"message":{"token","notification":{"title","body"},"android":{"priority":"HIGH","ttl":"14400s",
  "collapse_key":"<sha256(collapseId) hex 32>","notification":{"channel_id":"orca-desktop","tag":"<collapseId>"}},
  "data":{ all orca fields as strings }}}`
- Dead token: `UNREGISTERED`, or `INVALID_ARGUMENT` whose message names the token.

### Gateway storage (Postgres in prod, SQLite in tests, same pattern as `cloud/apps/relay/src/database.ts`)

- `push_hosts(host_fingerprint pk, host_public_key, created_at, last_seen_at)`, written only on a
  verified proof and pruned after 30 d of no contact when no `push_devices` row still names the host
- `push_challenges(challenge_id pk, host_fingerprint, host_public_key, secret_hash, transcript,
  expires_at, consumed_at)`
- `push_sessions(token_hash pk, host_fingerprint, expires_at, created_at)`
- `push_devices(registration_id pk, host_fingerprint, device_id, platform, token, apns_environment,
  filter_json, dead_at, created_at, updated_at, unique(host_fingerprint, device_id))`
- `push_send_log(host_fingerprint, registration_id, sent_at)` for quota, pruned after 25 h.

Logging: aggregate counters only. Never log tokens, titles, bodies, or raw fingerprints (log the first
4 chars of a fingerprint at most).

### Gateway env

`PORT`, `ORCA_PUSH_PUBLIC_URL`, `ORCA_PUSH_DATABASE_URL` (absent → SQLite under `ORCA_PUSH_DATA_DIR`),
`ORCA_PUSH_APNS_KEY` (PEM text), `ORCA_PUSH_APNS_KEY_ID`, `ORCA_PUSH_APPLE_TEAM_ID`,
`ORCA_PUSH_APNS_TOPIC` (default `com.stably.orca.mobile`), `ORCA_PUSH_FCM_PROJECT_ID` (default
`onorca-cloud`), `ORCA_PUSH_COALESCE_MS` (default 3000), `ORCA_PUSH_TRUSTED_PROXY_HOPS` (default 0,
proxies appending to `x-forwarded-for` after the client).
Secret Manager names (already exist in `onorca-cloud`): `orca-cloud-push-apns-key`,
`orca-cloud-push-apns-key-id`, `orca-cloud-push-apple-team-id`. Runtime SA:
`orca-cloud-push@onorca-cloud.iam.gserviceaccount.com` (already has FCM admin + secret accessor).

## Desktop (`src/main`, `src/shared`)

- Capability `NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY = 'notifications.remote-push.v1'` in
  `src/shared/protocol-version.ts`, advertised statically.
- RPC `notifications.registerPush` params `{ platform, token, apnsEnvironment?, filter }` (same shapes
  as the gateway `POST /v1/devices` minus deviceId, which comes from `ctx.pairedDeviceId`). Returns
  `{ registered: true, registrationId } | { registered: false, reason: 'gateway_unreachable' |
  'gateway_rejected' | 'not_mobile' | 'registration_storage_failed' }`. Persists `pushRegistration:
  { registrationId, platform, filter, registeredAt }` on `DeviceEntry` in `device-registry.ts` (new
  optional field, tolerated by old registries). When the gateway accepted the token but the host could
  not store it — the device left mobile scope mid-call (`not_mobile`) or the registry write threw
  (`registration_storage_failed`) — the host queues the gateway delete in the unregister outbox rather
  than leaking a registration nothing will ever push to. Phones must treat any `registered: false` as
  "retry later", so an unknown reason string is safe to add.
- RPC `notifications.unregisterPush` params null → `{ unregistered: boolean }`. Removes the field and
  enqueues a gateway delete in a durable outbox (`src/main/runtime/push/push-unregister-outbox.ts`,
  modelled on `relay-revoke-outbox.ts`). Unpair/revoke (`revokeMobileDevice`) enqueues the same. The
  drain re-reads the queue as it goes, so a delete queued mid-drain lands in the same pass, and a pass
  that leaves retryable items schedules an unref'd backoff retry (30 s, doubling, capped at 10 min)
  instead of waiting for the next launch.
- Both RPCs added to `runtime-rpc-mobile-method-allowlist.ts`.
- Push client `src/main/runtime/push/push-gateway-client.ts`: challenge/proof/session with token cache,
  register, delete, send. Node `fetch`. Gateway URL from `profile-cloud-auth-config.ts`
  (`pushGatewayUrl`, default `https://push.onorca.dev`, env override `ORCA_PUSH_GATEWAY_URL`).
- Host proof answering: new `src/main/runtime/push/push-host-proof.ts`, a copy of the relay's
  `answerRelayHostChallenge` with the push transcript fields. Shared code with the relay proof is
  welcome if it stays a pure refactor.
- Dispatch hook: in `RuntimeMobileNotificationController.dispatch`, after the socket fan-out, call
  `pushDispatcher.enqueue(eventWithSeq)`. The dispatcher applies each device's `filter`, skips `dismiss`
  events, maps `agentState` to `needs-input | finished` (blocked/waiting → needs-input, else finished),
  batches matching registrationIds into `POST /v1/send` requests of at most 20 registrations each (the
  gateway's per-request cap; extra devices get their own request rather than being dropped), and drops
  registrations the gateway reports `dead`. Fire-and-forget with one retry after 2 s per request; never
  throws into dispatch.
- Add `agentState` to `MobileNotificationDispatchEvent` and set it in `src/main/ipc/notifications.ts`
  from `args.agentState`. Fix `buildAgentTaskCompleteNotificationOptions` so `working|running|busy`
  never yields "finished" (title says "working" and the dispatcher treats it as not-final, i.e. no push).
- Headless serve: no renderer means no `notifications:dispatch`. Document in
  `docs/reference/headless-linux-server.md`; do not fix here.

## Mobile (`mobile/`)

- Commit `google-services.json` (from `/tmp/orca-mobile-push/google-services.json`) at `mobile/` and set
  `"android": { "googleServicesFile": "./google-services.json" }` in `app.json`. Add `"expo-notifications"`
  to `plugins` so prebuild writes the `aps-environment` entitlement.
- Token: `Notifications.getDevicePushTokenAsync()`; `data` is the APNs hex or FCM string. iOS
  `apnsEnvironment`: `__DEV__ ? 'sandbox' : 'production'` (dev-client builds are debug, TestFlight and
  App Store are release). Listen with `addPushTokenListener` and re-register on change.
- Settings (`mobile/app/notifications.tsx`): single "Background notifications" switch, default off,
  hint text exactly: "Get alerts while Orca is closed. Alerts show the same text as on your desktop. That
  text, your phone's push token, and opaque host and device ids pass through Orca's push service and Apple
  or Google. Turning this off or unpairing deletes the token." Below it, two sub-switches "Needs input"
  and "Task finished" (both default on) that set `filter.agentStates`; `sources` is fixed to all three.
  Hide the whole section, with copy "Update your desktop app to enable background notifications", when
  no paired host advertises `notifications.remote-push.v1`.
- Registration: on switch-on (after OS permission), and on every host reaching `connected` while the
  switch is on, call `notifications.registerPush` on that host if it advertises the capability. On
  switch-off call `notifications.unregisterPush` on every connected host and remember to retry on hosts
  that were offline. On host removal, best-effort unregister before deleting credentials.
- Receive: `addNotificationReceivedListener` (foreground) checks `data.orca.notificationId` +
  `notificationSeq` against the host session seen set in `notification-reconnect-catchup.ts`; if seen,
  suppress via `setNotificationHandler` returning no banner; otherwise show and mark seen. Background and
  killed: OS shows it.
- Tap: `data.orca.hostFingerprint` → hostId by computing the same sha256/base64url/16 derivation over each
  stored host's `publicKeyB64`; then existing `getNotificationNavigationTarget` + `useOpenNotificationRoute`.
- Reopen: existing replay catch-up runs unchanged. Dismiss events also
  `dismissNotificationAsync` any presented notification whose `data.orca.notificationId` matches.
- Old host without the capability: nothing changes.

## Infra (`cloud/infra/terraform`, `.github/workflows`)

- Cloud Run service `orca-cloud-push`, region `us-central1`, project from the environment tfvars, runtime
  SA `orca-cloud-push@<project>.iam.gserviceaccount.com` (exists in prod; declare and import), the three
  secrets mounted as env (exist; declare and import), Cloud SQL connector to the shared instance with its
  own database `orca_push`, min instances 1, max 4, concurrency 80, ingress all, unauthenticated invoke.
- IAM: `roles/firebasecloudmessaging.admin` and `roles/serviceusage.serviceUsageConsumer` on the runtime
  SA (exist in prod; declare and import). Secret accessor per secret.
- Hostname `push.onorca.dev`. The DNS zone lives in the apps root in `stablyai/orca-cloud`; add the
  Cloud Run domain mapping here and leave a TODO comment naming the record the other repo must add.
- Workflow `.github/workflows/cloud-push-deploy.yml`: gated on `vars.ORCA_CLOUD_OPERATIONS_ENABLED`,
  Workload Identity like `cloud-relay-*`, builds the image, deploys with `--no-traffic`, probes the new
  revision's `/ready` and a validate-only FCM send, then shifts 100% traffic. Uses
  `.github/actions/cloud-sql-rollout-lease` around the schema step.
- Add the new root files to `cloud/dev/contracts` and `cloud/dev/fixtures` partitions so
  `terraform-root-partition.test.mjs` and `Cloud Verify` pass.

## Non-goals for this release

Ack gate, generic-alert mode, staging gateway, iOS Notification Service Extension, Android data-only
messages, Live Activities, account-based quota tiers, dismissal via silent push.
