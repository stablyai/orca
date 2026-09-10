# Mobile push: contract and build spec

Tracking issue: stablyai/orca#8129. Design page: `/tmp/orca-mobile-push/orca-mobile-push.html`.
This document is the single contract every lane builds against. Do not deviate without updating it.

## Summary

A small Orca-hosted push gateway (`cloud/apps/push`) holds the APNs key and FCM credentials and sends
to phones. The desktop host registers each paired phone's native push token with the gateway and asks
the gateway to push each eligible desktop notification. Native APNs/FCM delivery is the only ordinary
mobile OS-banner path. The notification socket is retained only for live dismissals and reconnect tray
reconciliation; ordinary notification frames never create banners. Reconciliation compares the current
native tray with durable host dismissal history and does not replay alerts. Desktop notification
categories are authoritative. Legacy category, replay-notification, and summary fields remain on the
wire only for mixed-version compatibility. No ack gate, no generic mode, no staging gateway, one auth
path for signed-in and accountless hosts.

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
  Store challenge (id, expected-proof digest, host fingerprint, expiry, consumption time) in DB so any Cloud Run
  instance can verify. Expired rows are pruned 30 s late so a slow proof reads as expired rather than
  as an unknown challenge.
- No host registry or public-key/transcript copy is stored. The encrypted challenge and expected-proof
  digest provide proof verification; session and device rows retain host ownership.

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
  "apnsEnvironment": "sandbox" | "production" }  // ios only, required for ios
```

→ 200 `{ "registrationId": "<opaque>" }`. Upsert keyed by (hostFingerprint, deviceId); a new token
replaces the old. `deviceId` is caller-chosen, so a host is capped at 64 registrations: the 65th
distinct `deviceId` → 409 `{ "error": "too_many_devices" }`. Re-registering a `deviceId` the host
already owns is always accepted, and deleting a registration frees its slot. `GET /v1/devices` is
bounded at 1024 rows to match its response schema, which the per-host cap keeps well out of reach.
The gateway stores no category filters. The host enforces desktop category eligibility, phone-specific
away-only and sound preferences, and a mandatory seven-day registration lease renewed by mobile use.
iOS tokens are variable-length, hex-encoded byte strings; Android tokens are FCM registration strings.

`DELETE /v1/devices/:registrationId` (Bearer) → 204. Only the owning host may delete.

`GET /v1/devices` (Bearer) → `{ "devices": [{ registrationId, deviceId, platform, dead: boolean }] }`.

### Send

`POST /v1/send` (Bearer)

```json
{ "v": 1,
  "registrationIds": ["<id>", "..."],
  "notification": {
    "notificationId": "<max 2048 chars, may be absent for terminal-bell>",
    "notificationSeq": <int>, "notificationEpoch": "<uuid>",
    "source": "agent-task-complete" | "terminal-bell" | "plugin",
    "agentState": "needs-input" | "finished" | null,
    "title": "<max 80 chars>", "body": "<max 180 chars>",
    "worktreeId": "<max 2048 chars|absent>" } }
```

→ 200

```json
{ "results": [{ "registrationId": "<id>", "status": "queued" | "dead" | "rate_limited" | "error" }] }
```

- `queued` means the logical event, recipient, and pending delivery payload have committed to SQL. A
  worker resumes pending work after restarts; provider acceptance is not proof of visible delivery.
- Each host gets 300 logical alerts and, independently, 300 dismissals per rolling 15 minutes. Fanout
  across phones counts the event once. There is no daily per-phone quota. Over quota returns
  `rate_limited` per result with HTTP 200; requests above 20 registration IDs return HTTP 400.
- Optional notification `kind` is `alert` (default) or `dismiss`; optional `expiresAt` is an absolute
  Unix-millisecond deadline capped at five minutes from first acceptance. These fields require the
  updated gateway; deploy the gateway before the updated desktop sender.
- Notification JSON remains limited to 3000 UTF-8 bytes. Duplicate event identity with changed content
  is rejected. Retries retain the original deadline and do not spend additional quota.
- Event and recipient identities/outcomes remain for 24 hours; payloads are cleared at completion or
  expiry by minute-level cleanup. Quota reservation and enqueue share a per-host SQL transaction.

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
  trusted at all and falls back to a single shared bucket. The bucket is per
  instance and in memory, so the effective cap scales with the instance count; it exists to blunt a
  flood, not to meter.
- Authenticated routes use a per-host bucket of 600 requests/minute per instance, so normal usage by
  one desktop does not consume another desktop's budget behind the same office IP. Invalid bearers
  spend a separate 30/minute IP budget. Session lookups have bounded concurrent and waiting admission.
- The gateway cannot prove that a host owns the token it registers: any host with a session may
  register any well-formed token and send text to it, within its own quota. The phone drops such a push
  in the foreground because the fingerprint resolves to no paired host, and never routes a tap on it,
  but the OS banner shows while the app is backgrounded. Reaching it needs the victim's native token,
  which the gateway never returns and which only the phone and its host ever see.

### Individual delivery (gateway)

Each accepted event immediately creates one queued delivery per eligible registration. Bursts retain
their original title, body, routing fields, and replacement identity; the gateway does not generate
summary text or summary membership. APNs groups alerts visually by the host thread identifier. Android
uses a distinct notification tag for each event and relies on platform behavior rather than a custom
summary notification. Quota accounting still counts logical alerts, not deliveries or recipients.

Four worker lanes per instance claim deliveries with expiring, renewed SQL leases. Retry state
is persistent, with exponential backoff and provider minimum delays. Retry-After is never shortened
to fit event lifetime: expire instead. Device validity is checked before each attempt. Dismissals
cancel the matching pending alert and use silent provider messages. Mobile OS
background execution remains best effort, particularly after force-quit on iOS.

The queue stores one notification object per delivery. The existing `push_delivery_batches` table
name remains to avoid a cosmetic schema change; there are no summary readers, split operations,
or storage workarounds for old workers.

This feature is unpublished and its old deployment contains only test data. Before deploying this
storage-format change, stop old gateway revisions and clear the old push delivery fixtures; clear
old combined notifications from test-device trays as well. Do not run old and new workers together
against this queue format. No legacy data migration or summary compatibility is provided. Pairing
registrations and unrelated application data do not need to be reset.

Before deploying the registration-filter removal, stop old gateway revisions and run
`ALTER TABLE push_devices DROP COLUMN IF EXISTS filter_json;` on the dedicated PostgreSQL push
database. This removes only unused filter metadata and preserves registrations. Fresh databases
already use the new schema. Update the test desktop/mobile builds together and reopen mobile to
register; persisted host registrations without a finite expiry are discarded. Old unpublished builds
are not supported by the new registration API.

Shutdown stops admission and work acquisition, waits for active work within the platform grace, and
leaves unfinished deliveries recoverable after their leases expire. A provider acceptance followed by a
crash before SQL completion can still cause a repeated send; collapse identity mitigates this without
promising exactly-once delivery.

### Provider payloads

APNs (HTTP/2, `api.push.apple.com` or `api.sandbox.push.apple.com` by `apnsEnvironment`; JWT auth
from key id + team id + `.p8`, token cached and refreshed every 50 min):

- headers: `apns-topic: com.stably.orca.mobile`, `apns-push-type: alert`, `apns-priority: 10`,
  `apns-expiration: fixed event deadline (at most five minutes)`, `apns-collapse-id: <sha256(host + notification identity)>`
  (identity-less events use their epoch and sequence)
- body: `{"aps":{"alert":{"title","body"},"sound":"default","thread-id":"<hostFingerprint>"},
"orca":{ hostFingerprint, worktreeId, notificationId, notificationSeq, notificationEpoch, source,
agentState }}`
- Dismissals use `apns-push-type: background`, priority `5`, no collapse header, and
  `aps: {"content-available": 1}` with `orca.kind: "dismiss"`. They carry no alert or sound.
- Dead token: 410, or 400 with `BadDeviceToken`/`Unregistered`/`DeviceTokenNotForTopic`.

FCM (V1 `projects/onorca-cloud/messages:send`, bearer from the runtime service account via the GCE
metadata server or `GOOGLE_APPLICATION_CREDENTIALS` locally):

- `{"message":{"token","notification":{"title","body"},"android":{"priority":"HIGH","ttl":"<remaining event lifetime, at most 300s>",
"collapse_key":"<sha256(collapseId) hex 32>","notification":{"channel_id":"orca-desktop","tag":"<collapseId>"}},
"data":{ all orca fields as strings }}}`
- Dismissals are data-only (`kind: "dismiss"`); omit both `message.notification` and
  `android.notification`. No visible alert or sound is requested.
- FCM notification messages are inherently collapsible while offline, and FCM supports only a small
  number of concurrent collapse keys per device. Per-event `collapse_key` and Android `tag` preserve
  individual replacement identity while a message is retained, but excess offline pending messages
  may be discarded and every alert is not guaranteed to appear. Android automatic grouping remains
  platform-owned and is unverified on physical devices. Socket reconnect never recovers missed OS
  banners; the tray is not an event log.
- Dead token: `UNREGISTERED`, or `INVALID_ARGUMENT` whose message names the token.

### Gateway storage (Postgres in prod, SQLite in tests, same pattern as `cloud/apps/relay/src/database.ts`)

- `push_sessions` holds one row per host, enforced by a unique index and transaction lock. Minting a
  session deletes the host's earlier one, since a desktop holds a single session and only re-proves once it is gone.
- `push_challenges(challenge_id pk, host_fingerprint, secret_hash,
expires_at, consumed_at)`
- `push_sessions(token_hash pk, host_fingerprint, expires_at, created_at)`
- `push_devices(registration_id pk, host_fingerprint, device_id, platform, token, apns_environment,
dead_at, created_at, updated_at, unique(host_fingerprint, device_id))`
- `push_events` holds logical event identity, content fingerprint, quota timestamp, and expiry.
  Omitted `kind` and explicit `kind: "alert"` have the same fingerprint; changed content still conflicts.
- `push_event_recipients` records accepted event/phone pairs for idempotent fanout.
- `push_delivery_batches` holds individual payload envelopes, retry deadlines, and renewable worker
  leases.
- `push_dismissed_events` fences older alerts from replaying after dismissal.
- Queue identities and dismissal fences are retained for 24 hours; completed payloads are cleared.

Logging: aggregate counters only. Never log tokens, titles, bodies, or raw fingerprints (log the first
4 chars of a fingerprint at most).

### Gateway env

`PORT`, `ORCA_PUSH_PUBLIC_URL`, `ORCA_PUSH_DATABASE_URL` (absent → SQLite under `ORCA_PUSH_DATA_DIR`),
`ORCA_PUSH_APNS_KEY` (PEM text), `ORCA_PUSH_APNS_KEY_ID`, `ORCA_PUSH_APPLE_TEAM_ID`,
`ORCA_PUSH_APNS_TOPIC` (default `com.stably.orca.mobile`), `ORCA_PUSH_FCM_PROJECT_ID` (default
`onorca-cloud`), `ORCA_PUSH_TRUSTED_PROXY_HOPS` (default 0,
proxies appending to `x-forwarded-for` after the client).
Secret Manager names (already exist in `onorca-cloud`): `orca-cloud-push-apns-key`,
`orca-cloud-push-apns-key-id`, `orca-cloud-push-apple-team-id`. Runtime SA:
`orca-cloud-push@onorca-cloud.iam.gserviceaccount.com` (already has FCM admin + secret accessor).

## Desktop (`src/main`, `src/shared`)

- Capability `NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY = 'notifications.remote-push.v1'` in
  `src/shared/protocol-version.ts`, advertised statically.
- RPC `notifications.registerPush` params `{ platform, token, apnsEnvironment?, filter }`. The mobile
  filter includes only away-only and sound preferences; the host persists these locally.
  Its gateway `POST /v1/devices` sends no filter. `deviceId` comes from `ctx.pairedDeviceId`. The RPC returns
  `{ registered: true, registrationId } | { registered: false, reason: 'gateway_unreachable' |
'gateway_rejected' | 'not_mobile' | 'registration_storage_failed' | 'throttled' }`. A device may
  register at most 10 times per minute (`throttled` beyond that, its earlier registration untouched):
  each call is a gateway write plus a synchronous registry write on the main thread, and a paired
  phone could otherwise loop it. The unregister RPC is not throttled, since with nothing registered it
  is a lookup and with something registered it can only run once per successful register. The params
  schema is strict, so a caller-supplied `deviceId` is an error, not a key silently dropped. Persists
  `pushRegistration: { registrationId, platform, filter, expiresAt }` on `DeviceEntry` in
  `device-registry.ts` (new
  optional field, tolerated by old registries). Unreadable unregister history refuses new registration
  with `registration_storage_failed` until a readable restart can settle prior cleanup.
  When the gateway accepted the token but the host could
  not store it — the device left mobile scope mid-call (`not_mobile`) or the registry write threw
  (`registration_storage_failed`) — the host queues the gateway delete in the unregister outbox rather
  than leaking a registration nothing will ever push to. Registration, unregister, and outbox deletes
  are serialized per device; re-registration first settles earlier cleanup. Authentication failure
  never drops a durable delete. Stale send responses only clear the exact local registration observed,
  while provider dead-token updates match the token/platform/environment that was sent. Phones must
  treat any `registered: false` as "retry later", so an unknown reason string is safe to add.
- RPC `notifications.unregisterPush` params null → `{ unregistered: boolean }`. Removes the field and
  enqueues a gateway delete in a durable outbox (`src/main/runtime/push/push-unregister-outbox.ts`,
  modelled on `relay-revoke-outbox.ts`). Unpair/revoke (`revokeMobileDevice`) enqueues the same. The
  drain processes one queue snapshot per pass; every enqueue requests a flush, so the outer loop
  takes another snapshot for work arriving during a pass. Retryable failures schedule an unref'd
  backoff retry (30 s, doubling, capped at 10 min)
  instead of waiting for the next launch.
- Both RPCs added to `runtime-rpc-mobile-method-allowlist.ts`.
- Push client `src/main/runtime/push/push-gateway-client.ts`: challenge/proof/session with token cache,
  register, delete, send. Node `fetch`. Gateway URL from `profile-cloud-auth-config.ts`
  (`pushGatewayUrl`, default `https://push.onorca.dev`, env override `ORCA_PUSH_GATEWAY_URL`).
- Host proof answering: `src/main/runtime/push/push-host-proof.ts` reuses the relay's
  `host-challenge-envelope` primitives with push-specific domains and transcript validation.
- Dispatch hook: in `RuntimeMobileNotificationController.dispatch`, after the socket fan-out, call
  `pushDispatcher.enqueue(eventWithSeq)`. The dispatcher requires desktop category eligibility, applies
  each device's away-only and sound preferences, and sends silent `dismiss` events independently of
  alert eligibility. Agent alerts map blocked/waiting/needs-input to `needs-input` and
  done/finished or omitted states to `finished`; other agent states are rejected. It batches
  matching registrationIds into `POST /v1/send` requests of at most 20 registrations each (the
  gateway's per-request cap; extra devices get their own request rather than being dropped), and drops
  unchanged registrations the gateway reports `dead`. Failure categories are counted without payload
  values and logged at most once per minute (with a final flush on shutdown). Fire-and-forget with
  one retry after 2 s per request; never throws into dispatch.
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
- Settings (`mobile/app/notifications.tsx`): one default-off **Enable notifications** switch
  controls native push registration. Hint: “Get agent alerts even when the app is closed.
  Delivered through Orca’s push service and Apple or Google.” Desktop category controls are
  authoritative and are not duplicated as phone overrides. Phone sound and viewing controls remain
  independent. Settings, onboarding and permission-based opt-in use one consent mutation function.
  It persists consent and cleanup intent, then schedules reconciliation once without waiting for
  network completion. A cleanup-intent write failure still schedules reconciliation and reaches the caller.
  Consent is stored only in `orca:pushNotificationsEnabled`; a missing preference
  remains off, and obsolete test-build push keys do not grant consent. **Only when away from desktop**
  defaults on (180 seconds of OS input idle, or locked). Unknown/headless presence does not suppress; it is never inferred from remote CPU
  activity. The detailed payload disclosure remains in the notification documentation.
- `notifications.remote-push.v1` is the single push capability, including category mirroring,
  away filtering and seven-day expiry. Settings retain pair/update guidance for hosts without
  push support and leave unanswered probes unresolved.
- All registrations receive a persisted seven-day `expiresAt` on the
  paired desktop. Delivery and transport retries exclude expired registrations. Only foreground
  mobile registration renews it: on connection, foreground return, and every 15 minutes while
  active. Background sockets, desktop use and notification delivery never renew a phone lease.
  Opening mobile and reconnecting restores delivery without replaying expired push sends.
- Registration: on switch-on (after OS permission), and on every host reaching `connected` while the
  switch is on, call `notifications.registerPush` on that host if it advertises the capability. On
  switch-off call `notifications.unregisterPush` on every connected host and remember to retry on hosts
  that were offline. On host removal, best-effort unregister before deleting credentials.
- Receive: `addNotificationReceivedListener` (foreground) validates that the host is paired, master
  consent is enabled, the destination is not currently viewed, and the event is not fenced by a
  persisted dismissal. A bounded process-local identity claim suppresses concurrent duplicates by
  host, epoch, sequence, and optional notification ID. Background and killed delivery remains owned by
  the OS and is best effort.
- Tap: `data.orca.hostFingerprint` → hostId by computing the same sha256/base64url/16 derivation over each
  stored host's `publicKeyB64`; then existing `getNotificationNavigationTarget` + `useOpenNotificationRoute`.
- Reopen: subscribe to socket notifications for live dismissals, but ignore ordinary
  notification frames for banner presentation. Reconnect reconciliation sends identities currently in
  the native tray in pages of 256 and applies only confirmed host/epoch/sequence identities;
  it requests no historical events and creates no banners. The server replay RPC remains compatible
  with independently updated clients. Live dismiss events also remove matching presented notifications.
- Old host without the capability: nothing changes.

## Infra (`cloud/infra/terraform`, `.github/workflows`)

- Cloud Run service `orca-cloud-push`, region `us-central1`, project from the environment tfvars, runtime
  SA `orca-cloud-push@<project>.iam.gserviceaccount.com` (exists in prod; declare and import), the three
  secrets mounted as env (exist; declare and import), Cloud SQL connector to the dedicated HA PostgreSQL instance with its
  own database `orca_push`, min instances 1, max 2 in production, concurrency 80, ingress all, unauthenticated invoke.
- IAM: `roles/firebasecloudmessaging.admin` and `roles/serviceusage.serviceUsageConsumer` on the runtime
  SA (exist in prod; declare and import). Secret accessor per secret.
- Hostname `push.onorca.dev`. The DNS zone lives in the apps root in `stablyai/orca-cloud`; add the
  Cloud Run domain mapping here and leave a TODO comment naming the record the other repo must add.
- Workflow `.github/workflows/cloud-push-deploy.yml`: gated on `vars.ORCA_CLOUD_OPERATIONS_ENABLED`,
  Workload Identity like `cloud-relay-*`, builds a reviewed full `source_sha`, deploys with `--no-traffic`, probes the new
  revision's `/ready` and a validate-only FCM send, then shifts 100% traffic. Uses
  `.github/actions/cloud-sql-rollout-lease` throughout rollout using
  `terraform/state/push-rollout/production.lock` and concurrency group `production-push-rollout`.
  The deploy identity can manage only that lease object. Push uses only its dedicated 2-vCPU HA
  database and is excluded from Relay's shared database budget. See
  [database operations](../../cloud/docs/push-database-cutover.md) for existing-schema preparation,
  obsolete resource ownership, and the lock transition before deployment.
- Add the new root files to `cloud/dev/contracts` and `cloud/dev/fixtures` partitions so
  `terraform-root-partition.test.mjs` and `Cloud Verify` pass.

## Non-goals for this release

Ack gate, generic-alert mode, staging gateway, iOS Notification Service Extension, Android data-only
alert messages, Live Activities, account-based quota tiers.

### Device delivery preferences

Completion detection remains active when desktop notifications are off; semantic validity checks still
precede delivery. IPC publishes `desktopAllowed: false` when the desktop master or source/category switch rejects an event. That
desktop category decision is authoritative for both desktop and phone alerts. Desktop focus and
native authorization remain desktop-only presentation gates and do not change mobile eligibility.

Updated mobile subscribes with `includeDesktopSuppressed: true` for mixed-version compatibility and
to receive dismissals, but it never turns ordinary socket notification frames into OS banners. The
optional subscribe/replay fields and replayed `notifications` retain their existing remote-wire
compatibility behavior. Push registrations carry no category overrides: hosts gate provider alerts
on `desktopAllowed`. Optional `emittedAt` and replay notification response fields remain compatibility
surface rather than a second delivery policy or banner path.

`filter.sound` is also host-local. False groups that device's requests separately and adds
optional `notification.sound: false` to gateway sends. The gateway omits APNs `aps.sound` and
uses Android's `orca-desktop-silent` channel. Missing sound preserves existing audible delivery.
Deploy the updated gateway before distributing hosts that send the optional sound field: older
gateways strictly reject unknown notification fields. No token or database migration is needed.

The phone's master switch disables native push registration. Sound and viewing preferences belong to
the receiving phone. The phone suppresses a foreground banner for its
currently viewed host/workspace only while active; it never assumes desktop focus means the
phone is viewing that workspace. Once registered, the host applies its persisted phone settings while
the phone is disconnected; preference changes synchronize when it reconnects. No live APNs/FCM
delivery is implied by simulator notification injection.

APNs/FCM is the sole ordinary OS-banner path whether the app is foregrounded, backgrounded, or
killed. Socket notification events do not wait, schedule a local fallback, or recover a missed native
alert. Hosts without push registration therefore have no mobile OS-banner fallback.

Native notification readers accept Expo's iOS `request.trigger.payload` as well as
`request.content.data`. APNs custom fields can exist only in the former; foreground identity claims,
dismissal, reconciliation, and tap routing all use the same reader. Only individual notification
payloads are supported; grouping is handled by the OS.

### Dismissal recovery and desktop presence

Automatic acknowledgement of a visible agent pane requires confirmed desktop presence from the
same three-minute native idle check used for push delivery. A focused window alone is insufficient.
Trusted input in the renderer confirms the user has returned. Unknown presence preserves unread
attention; explicit mark-read actions remain available, including in browser clients.

The runtime persists notification identities and dismissal sequence fences in its own user-data
directory before fanout. History is bounded to 4,096 records retained for seven days. It stores no
notification text or push tokens. On reconnect, mobile sends up to 256 `deliveredPushes` identities
from the current native tray in each `notifications.getMissedSince` request; updated hosts return
optional `dismissedPushes` for confirmed handled identities. Mobile processes only those dismissal
decisions. Unknown IDs, unknown epochs, and newer sequences are preserved. Dismissing a stable
notification ID also clears its recorded pre-restart identities, each through its own last recorded
sequence; sequence counters from different epochs are never compared. Older hosts ignore the
optional request field, and older clients ignore the additional response fields. Legacy replayed
`notifications` and epoch fields remain wire-compatible but do not drive current mobile banners.

On iOS, a local Expo module handles silent dismissals directly through the native notification
center, independent of JavaScript initialization. Native and JavaScript dismissal paths use the
same host/epoch/sequence fences; native dismissal fences retain up to 512 entries for 24 hours.
Android uses the JavaScript implementation. iOS requires the native module; its JavaScript background
task also suppresses late alerts using the dismissal ledger. A native callback test proves
processing only when invoked: iOS background push delivery remains best effort, including while
suspended or force-quit. Every delivered push represents one notification. Reconciliation inspects
up to 2,048 individual identities in pages of 256. It has no stored replay watermark: every connection
compares the current tray with host dismissal history and never replays an alert.

### Dismissal storage ownership

iOS requires the `OrcaNotificationDismissal` native module and uses its native ledger exclusively.
Android uses AsyncStorage. A missing iOS module is a build defect; native calls never switch to a
second JavaScript store. Reads still recheck when a concurrent dismissal overtakes a negative result.
Storage and tray-operation failures propagate to the caller instead of silently selecting a fallback
or treating an unsupported old native shell as successful cleanup.

### Session schema

One session per host is enforced by a unique index in the initial schema. Startup does not inspect
old index layouts or repair duplicate sessions from unpublished builds. Existing test databases
already carrying `push_sessions_host` need no change. If using an older test database without that
index and with duplicate sessions, stop old gateway revisions and clear `push_sessions` before
starting this version; hosts authenticate again. No device registrations need to be deleted.
