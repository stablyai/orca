# Orca mobile push gateway

`orca-cloud-push` is a public Cloud Run service in `onorca-cloud` that turns a desktop
notification into an APNs or FCM push for a paired phone. The desktop registers each phone's
native token with it and calls `POST /v1/send` after the socket fan-out it already does; the
phone treats APNs/FCM as the sole ordinary OS-banner path. The notification socket is retained only
for live dismissal and reconnect tray reconciliation; it does not create or recover banners. Desktop
notification categories remain authoritative. The service is the only place the Apple
`.p8` signing key is readable, which is the reason it exists as a service at all.

The request schemas live in `packages/push-contract/src/`. This document covers Terraform
ownership, deployment, credential rotation, and recovery.

**There is no staging push gateway.** That is a decision, not an omission. `push_gateway_enabled`
is false in `environments/staging.tfvars` and true in `environments/production.tfvars`, and every
resource in `infra/terraform/push-gateway.tf` is behind it. A staging gateway would be a tfvars
edit plus a second set of Apple credentials.

## Shape

| Setting           | Value                                                  | Where                                        |
| ----------------- | ------------------------------------------------------ | -------------------------------------------- |
| Cloud Run service | `orca-cloud-push`                                      | `push_cloud_run_service_name`                |
| Region            | `us-central1`                                          | `region`                                     |
| Instances         | min 1, max 2                                           | `push_min_instances`, `push_max_instances`   |
| Database pool     | 2 per instance                                         | `push_database_pool_max`                     |
| Concurrency       | 80                                                     | `push_concurrency`                           |
| Ingress           | all                                                    | `INGRESS_TRAFFIC_ALL`                        |
| Invoker           | IAM disabled                                           | `invoker_iam_disabled = true` on the service |
| Runtime identity  | `orca-cloud-push@onorca-cloud.iam.gserviceaccount.com` | `google_service_account.push_runtime`        |
| Database          | `orca_push` on dedicated HA PostgreSQL 17           | `google_sql_database.push_dedicated`                   |
| Hostname          | `push.onorca.dev`                                      | `push_base_url`                              |

The minimum of one instance is deliberate and did not move when the ceiling came down to two. A
cold start delays a notification past the point where it is worth showing, so the floor is what
keeps a notification prompt. The
ceiling is a different question, answered below.

Push uses its approved dedicated two-vCPU HA database. Two instances with a two-connection
pool draw four connections; three simultaneous revision resources draw twelve. Tagged
candidates can run outside the service-wide cap, so Terraform bounds instances × pool × 3
at 64 connections, leaving dedicated capacity for maintenance and operators. Increase pool
sizes only after measuring contention. The shared Relay budget excludes push entirely.

Authentication is the host proof in `POST /v1/host/challenge`, not Cloud Run IAM, so the service
opts out of invoker IAM with `invoker_iam_disabled = true`, exactly as the relay director does.
The project's domain-restricted-sharing policy refuses an `allUsers` invoker binding, so that is
the only way to reach an open service here.

## Environment

Set on the container by Terraform:

| Variable                      | Source                                                   |
| ----------------------------- | -------------------------------------------------------- |
| `PORT`                        | Cloud Run, container port 8080                           |
| `ORCA_PUSH_PUBLIC_URL`        | `push_base_url`                                          |
| `ORCA_PUSH_FCM_PROJECT_ID`    | `project_id` (required for standalone runtime)          |
| `ORCA_PUSH_DATABASE_URL`      | Secret `orca-cloud-push-dedicated-database-url`, pinned version  |
| `ORCA_PUSH_DATABASE_POOL_MAX` | `push_database_pool_max`, 2 per instance                 |
| `ORCA_PUSH_APNS_KEY`          | Secret `orca-cloud-push-apns-key`, version `latest`      |
| `ORCA_PUSH_APNS_KEY_ID`       | Secret `orca-cloud-push-apns-key-id`, version `latest`   |
| `ORCA_PUSH_APPLE_TEAM_ID`     | Secret `orca-cloud-push-apple-team-id`, version `latest` |

`ORCA_PUSH_APNS_TOPIC` is left to its application default (`com.stably.orca.mobile`). Add it here
only when it has to differ from the code default, so that a code-side change stays visible rather
than silently overridden.

Terraform owns the three Apple secret **names, labels, and replication, and never a version.**
The `.p8` is issued by the Apple developer portal, so a Terraform-managed version would put the
private key in state and would fight the rotation below. The database URL secret is different:
Terraform generates that password, so it owns that version, exactly as `relay-database.tf` does.
That puts the generated password and the full database URL in the state bucket, which the shared
deploy identity can read; the Apple key never appears there. The three Apple secrets and the
`orca_push` database carry `prevent_destroy`, so disabling the gateway fails the plan instead
of deleting the only copy of the signing key or every live device token.

## Importing what already exists

The runtime account, the three Apple secrets, and their accessor bindings were created out of
band alongside the Apple credentials. They are declared so a plan is clean, and imported once.
Run these from `cloud/` after `pnpm infra:init --env production`, review the resulting plan, and
expect the imported resources to show no changes.

```sh
terraform -chdir=infra/terraform import -var-file=environments/production.tfvars \
  'google_service_account.push_runtime[0]' \
  projects/onorca-cloud/serviceAccounts/orca-cloud-push@onorca-cloud.iam.gserviceaccount.com

terraform -chdir=infra/terraform import -var-file=environments/production.tfvars \
  'google_project_iam_member.push_runtime_fcm_admin[0]' \
  'onorca-cloud roles/firebasecloudmessaging.admin serviceAccount:orca-cloud-push@onorca-cloud.iam.gserviceaccount.com'

terraform -chdir=infra/terraform import -var-file=environments/production.tfvars \
  'google_project_iam_member.push_runtime_service_usage_consumer[0]' \
  'onorca-cloud roles/serviceusage.serviceUsageConsumer serviceAccount:orca-cloud-push@onorca-cloud.iam.gserviceaccount.com'

terraform -chdir=infra/terraform import -var-file=environments/production.tfvars \
  'google_secret_manager_secret.push_provider["orca-cloud-push-apns-key"]' \
  projects/onorca-cloud/secrets/orca-cloud-push-apns-key

terraform -chdir=infra/terraform import -var-file=environments/production.tfvars \
  'google_secret_manager_secret.push_provider["orca-cloud-push-apns-key-id"]' \
  projects/onorca-cloud/secrets/orca-cloud-push-apns-key-id

terraform -chdir=infra/terraform import -var-file=environments/production.tfvars \
  'google_secret_manager_secret.push_provider["orca-cloud-push-apple-team-id"]' \
  projects/onorca-cloud/secrets/orca-cloud-push-apple-team-id

terraform -chdir=infra/terraform import -var-file=environments/production.tfvars \
  'google_secret_manager_secret_iam_member.push_provider_runtime_accessor["orca-cloud-push-apns-key"]' \
  'projects/onorca-cloud/secrets/orca-cloud-push-apns-key roles/secretmanager.secretAccessor serviceAccount:orca-cloud-push@onorca-cloud.iam.gserviceaccount.com'

terraform -chdir=infra/terraform import -var-file=environments/production.tfvars \
  'google_secret_manager_secret_iam_member.push_provider_runtime_accessor["orca-cloud-push-apns-key-id"]' \
  'projects/onorca-cloud/secrets/orca-cloud-push-apns-key-id roles/secretmanager.secretAccessor serviceAccount:orca-cloud-push@onorca-cloud.iam.gserviceaccount.com'

terraform -chdir=infra/terraform import -var-file=environments/production.tfvars \
  'google_secret_manager_secret_iam_member.push_provider_runtime_accessor["orca-cloud-push-apple-team-id"]' \
  'projects/onorca-cloud/secrets/orca-cloud-push-apple-team-id roles/secretmanager.secretAccessor serviceAccount:orca-cloud-push@onorca-cloud.iam.gserviceaccount.com'
```

The push resources already exist in production. Preserve their addresses, dedicated database
and identities; review the [database cleanup runbook](./push-database-cutover.md) before applying
changes. This root has unrelated standing drift, so an untargeted apply is never automatic.

Two things this root does **not** declare, because the carve assigns them elsewhere. Neither
affects whether this root's plan is clean, since an undeclared resource is invisible to it.

- `firebase.googleapis.com` and `fcm.googleapis.com` are project service enablement, which is
  `google_project_service.required` in the foundation root. They are already enabled; add them
  to the foundation root's list so a foundation plan stays clean.
- The Firebase attachment on `onorca-cloud` is project-level and belongs with foundation for the
  same reason. It exists already.

## Deploying

`Deploy Push Gateway Production` (`.github/workflows/cloud-push-deploy.yml`) is the only
supported path. Like every `cloud-*` workflow it does nothing until `ORCA_CLOUD_OPERATIONS_ENABLED`
is `true`, it runs only on `main`, and it needs the confirmation string `DEPLOY_PUSH_GATEWAY`.

It authenticates as the dedicated `orca-cloud-gha-push` identity through
`PRODUCTION_GCP_PUSH_DEPLOY_WORKLOAD_IDENTITY_PROVIDER` and
`PRODUCTION_GCP_PUSH_DEPLOY_SERVICE_ACCOUNT`. `push-deploy-identity.tf` restricts Workload Identity
to this exact dispatch workflow on main in the production environment. Its distinct principal
attribute cannot assume the shared Relay deploy identity.

The account can write images to Artifact Registry, deploy the push service, impersonate only
the push runtime account, and manage exactly `terraform/state/push-rollout/production.lock`
in the production state bucket. The relay root owns that conditional lease grant. It grants
no Terraform-state object access. Publish `github_push_workload_identity_provider` and
`github_push_deploy_service_account` as the production-environment variables above.

The workflow uses the `production-push-rollout` concurrency group with cancellation disabled
and the existing durable lease action on the push-specific object. Push and Relay deploy
independently; two push deploys cannot race traffic changes. Finish every old shared-lock push
run before enabling the new workflow and lease grant. See the cleanup runbook for the bounded
IAM transition and removal of any obsolete foundation-owned push membership.

The run builds the reviewed `source_sha` while the workflow stays on `main`. Buildx returns
its own pushed digest (no mutable-tag lookup); every subsequent check and deployment uses that
same digest. Before any production boot, a network-isolated container checks that the image
recognizes `ORCA_PUSH_MODE=validation` and rejects invalid modes. Older images that lack this
capability are refused before they can connect to production.

Under the production push rollout lease, it records the serving rollback revision and
asserts Terraform-owned scaling. It deploys a tagged, zero-traffic validation revision:

- Validation opens PostgreSQL with `default_transaction_read_only=on` and skips schema setup.
- No delivery worker or challenge, session, or delivery pruner starts.
- Only `/health` and `/ready` are available; all application routes return 503.
- `/health` attests `mode: validation`; `/ready` checks database connectivity only. It does not
  prove schema compatibility, provider delivery, or active-worker readiness. Container probes
  can still use `/health` without treating an inert process as unhealthy.

The build explicitly targets `linux/amd64` with provenance disabled so build metadata records a
single manifest digest, rather than an OCI index that Cloud Run resolves to a different digest.
The workflow verifies the exact image and scaling, probes readiness and mode, and checks the
runtime identity with a validate-only FCM request. Cloud Run rejects deletion of the latest
created revision even when it has no tag or traffic. Activation therefore creates a successor
before removing the validation tag and deleting validation. The dedicated 64-connection budget
reserves three simultaneous revision pools: serving, validation/rejected,
and active/recovery successor (12 configured pool connections at the current two-by-two shape).
Revision deletion is not proof of physical SQL session drain; verify termination and SQL sessions
in controlled rollout acceptance. There is no shutdown sleep used as a drain gate.

**Activation deliberately starts production effects.** The distinct active revision uses the exact
validated digest with the validation override removed. Schema setup runs on its existing
one-connection untimed pool, followed by workers and pruners, before HTTP promotion. The workflow
checks digest, full runtime spec and secret-reference shape, scaling, readiness and active mode,
then moves HTTP traffic and checks the public origin. Those checks commit the new serving revision;
subsequent retirement failures do not trigger rollback to a possibly deleted previous revision.
The previous consumer is retired and all tags are cleared. Retain the previous immutable image
from the summary: later recovery redeploys that digest, because the previous revision is deleted.

Before any candidate creation, the workflow requires exactly one revision resource, the sole HTTP
serving revision. Existing historical revisions or leftovers from interrupted runs require explicit
operator review and cleanup under the lease first; the workflow does not blindly delete them.
This gate and retirement after every successful rollout prevent repeated runs accumulating workers.
Terraform still owns configuration and scaling; removing validation mode adds no ignored field.

On failure before public checks pass, any attempted traffic shift is first rolled back and verified.
If partial activation created a successor, recovery retires non-latest validation first; deletion
failure stops recovery before a fourth resource can be created. Recovery then deploys the captured
known-good digest as a tagged, zero-traffic successor with normal mode. It verifies template shape,
secret references and scaling, probes tagged readiness and active mode, promotes the recovery
revision, verifies traffic and public health, and only then deletes rejected and previous revisions.
The latest recovery revision remains serving. Known-good recovery schema and workers can execute
before promotion; neither recovery nor traffic rollback undoes schema changes or sent notifications.

Partial creates record deterministic names before mutation. Failed recovery or deletion requires
operator cleanup under the lease; the next automated run refuses leftover resources. A canceled
runner can require the same intervention. Traffic restoration alone does not stop queue consumers.

Manual recovery must preserve the three-resource bound and keep the successor serving:

```sh
# Hold the rollout lease; inspect latest, traffic, tags and existing revisions first.
# If three resources remain after partial activation, retire non-latest inert validation first.
# Restore previous traffic if its revision still exists and a failed candidate took traffic.
gcloud run deploy orca-cloud-push \
  --project onorca-cloud --region us-central1 --image <known-good-image-at-digest> \
  --remove-env-vars ORCA_PUSH_MODE --no-traffic \
  --tag <unique-recovery-tag> --revision-suffix <unique-recovery-suffix>
# Verify exact digest, template spec/secret references/scaling, tagged /ready and active /health.
gcloud run services update-traffic orca-cloud-push \
  --project onorca-cloud --region us-central1 --to-revisions <recovery-revision>=100
# Verify traffic and public /ready and /health before retiring old consumers.
gcloud run services update-traffic orca-cloud-push \
  --project onorca-cloud --region us-central1 --clear-tags
gcloud run revisions delete <rejected-or-previous-revision> \
  --project onorca-cloud --region us-central1
# Repeat only for reviewed obsolete revisions; retain the latest serving recovery revision.
```

Never merely remove validation mode while the template still holds a rejected image. Terraform
owns environment configuration but ignores the image, so that would activate rejected code.
Remove a tag only if it remains present. Verify the recovery revision is serving, the template is safe,
and obsolete revision deletion and connection drain completed;
already accepted provider sends cannot be undone. Activation-time schema changes must be additive
and compatible with the rollback image: rollback does not reverse migrations or queue mutations.
The inert phase intentionally cannot validate a new schema by applying it to production. Review
migrations and validate them against isolated PostgreSQL before dispatch. No actual Cloud Run
rollout, provider delivery or physical-device acceptance is implied by local contract tests.

### Incompatible queue rollout prerequisite

The queue stores one notification object per delivery. Before deploying a revision that changes this
format, stop every older push gateway revision and clear only unpublished push delivery fixtures from
the push database. This is an unpublished feature, so do not preserve or migrate queued fixtures; no
production mutation is implied by this prerequisite.

### Why the FCM probe impersonates the runtime account

A gateway that boots and answers `/ready` can still be unable to send: the FCM grant lives on
the runtime service account, not on anything the readiness check touches. The probe therefore
mints an access token for `orca-cloud-push@onorca-cloud.iam.gserviceaccount.com` and posts
`validate_only: true` with a token that cannot exist. `validate_only` stops Google before any
delivery, and a healthy credential answers `INVALID_ARGUMENT` because the device token is
garbage. `PERMISSION_DENIED`, `401`, and `403` are the failures the step exists to catch, and
they fail the run immediately, before traffic moves. Those four answers are the only conclusive
ones: a `429`, a `5xx`, or a transport failure says nothing about the credential, so the send is
retried up to five times at five-second intervals rather than read as either verdict. Probing as the deploy identity instead would prove
something true about the wrong account.

## Rotating the APNs key

Apple keys do not expire, so this is for a suspected compromise or a routine rotation. Order
matters: the new key must be serving before the old one is revoked, or every iOS push fails in
the window between.

1. In the Apple developer portal, create a **new** APNs authentication key. Download the `.p8`
   once; Apple will not show it again. Note the new key ID. A team may hold two APNs keys at a
   time, which is what makes this overlap possible.
2. Add a version to each changed secret, without printing the value:

   ```sh
   gcloud secrets versions add orca-cloud-push-apns-key \
     --project onorca-cloud --data-file /path/to/AuthKey_NEW.p8
   printf '%s' '<new key id>' | gcloud secrets versions add orca-cloud-push-apns-key-id \
     --project onorca-cloud --data-file=-
   ```

   The team ID does not change, so `orca-cloud-push-apple-team-id` is untouched.

3. Dispatch `Deploy Push Gateway Production`. The container reads `latest` at start, so only a
   new revision picks the key up; there is no in-place reload.
4. Verify from a real device that an iOS notification still arrives. The workflow's FCM probe
   covers Android only, and APNs has no validate-only equivalent.
5. Only then revoke the old key in the Apple portal, and disable the superseded secret versions:

   ```sh
   gcloud secrets versions disable <old-version> \
     --project onorca-cloud --secret orca-cloud-push-apns-key
   ```

   Disable rather than destroy, so a rollback to the previous revision still works. Destroy
   after the next clean deploy.

Delete the downloaded `.p8` from disk when you are done. It is the whole credential.

## Dead tokens

A push token stops working when the app is uninstalled, when the user restores to a new device,
or when iOS reissues it. Both providers report this, and the shapes differ:

- APNs: HTTP 410, or 400 with `BadDeviceToken`, `Unregistered`, or `DeviceTokenNotForTopic`.
  `DeviceTokenNotForTopic` also fires when a sandbox token is sent to the production host, which
  is a configuration bug rather than a dead token; check `apns_environment` on the registration
  before concluding the device is gone.
- FCM: `UNREGISTERED`, or `INVALID_ARGUMENT` whose message names the token.

The gateway marks the registration `dead_at` and returns `status: "dead"` for it, and the
desktop drops the registration when it sees that. Nothing here retries a dead token. A phone
that comes back re-registers the same host/device pair, retaining its `registrationId` and
clearing `dead_at`. The per-minute `delivery_dead` counter measures delivery outcomes, not
currently dead registrations. A spike across many hosts warrants checking credentials and topics.

## Quotas

Two independent limits, both enforced in the gateway and both returning HTTP 200 with
`status: "rate_limited"` per result rather than failing the request:

| Limit                                         | Scope                                   |
| --------------------------------------------- | --------------------------------------- |
| 300 logical alerts per rolling 15 minutes     | per `hostFingerprint`                   |
| 300 logical dismissals per rolling 15 minutes | per `hostFingerprint`, separate budget  |
| 20 `registrationIds`                          | per request, hard cap, HTTP 400 over it |

Fanout to several phones counts one logical event; there is no per-phone daily allowance.
Unauthenticated handshakes and invalid bearer attempts have separate 30/minute IP buckets.
Authenticated routes use a 600/minute host bucket and a shared 6,000/minute client-IP bucket
per instance. The IP budget cannot be reset by generating another host key. It is shared by
clients behind one NAT and is an abuse safeguard, not a global provider-spending cap. Auth database lookup concurrency
and waiting work are bounded independently of HTTP concurrency.

`push_events` backs quota accounting. `push_event_recipients` deduplicates fanout and
`push_delivery_batches` retains its historical name and persists individual deliveries, worker
leases, retries and outcomes. Identity metadata
is retained for 24 hours. Payloads expire within five minutes and are cleared on completion or by
minute-level expiry cleanup. FCM project-level provider quotas remain independent of host limits.

Logging is aggregate counters only. Never log a token, a title, a body, or a full fingerprint;
the first four characters of a fingerprint are the most that may appear.

## DNS: one hand-managed record

The Cloud Run domain mapping is created here, and Google issues and renews the certificate. The
`onorca.dev` zone is not in this root: it is a Cloudflare zone whose Terraform-managed records
live in the apps root in `stablyai/orca-cloud`, and whose relay and auth records are managed by
hand. The push record follows the relay's precedent and was created by hand on 2026-09-04:

```text
push.onorca.dev.  CNAME  ghs.googlehosted.com.   (DNS only, not proxied)
```

`terraform -chdir=infra/terraform output push_dns_record` prints the same three fields. If the
record is ever lost, recreate it exactly like that; Cloudflare proxying blocks certificate
issuance and breaks Cloud Run host routing.

### Recovery and delivery guarantees

Candidate tags and deterministic revision names are recorded before deployment. Promotion intent is
recorded before changing traffic, so a failed verification or ambiguous mutation result still triggers
rollback. A known-good successor must exist before the rejected latest revision can be deleted.
After verified recovery promotion and public checks, rejected and previous consumers are retired;
the recovery revision remains serving. Failed cleanup blocks subsequent rollout admission.
The summary runs even if candidate discovery or traffic verification fails.

Push uses the relay's schema-startup retry implementation through `@orca-cloud/postgres-schema`.
Session replacement is serialized per host and a unique host index upgrades older databases by
retaining their newest session. Cloud Verify runs push concurrency tests against PostgreSQL.

Accepted sends commit quota and pending work together before returning `queued`. Workers resume
unfinished deliveries after restarts without relying on desktop retries. The durable queue and
expiring leases coordinate replicas. All provider attempts retain the original five-minute deadline
and respect provider backoff; no retry extends alert life. Silent dismissal messages have their own
quota and cancel matching unsent alerts. Mobile OS delivery/execution is not guaranteed.

Shutdown stops admission and new claims; unfinished leases remain recoverable. Provider acceptance
and SQL completion cannot be atomic, so repeated transport delivery remains possible after a crash.
Stable per-event replacement identities reduce duplicates without promising exactly-once visible
delivery. FCM notification messages are inherently collapsible while offline and support only a
small number of concurrent collapse keys per device, so excess pending messages may be discarded and
every offline alert is not guaranteed to appear. Socket reconnect reconciles dismissals against the
current native tray; it has no stored replay watermark and never recovers a missed OS banner.

### Dedicated database operations

Push has one dedicated database attachment, with stable Terraform addresses and deletion
protection. There is no switch to shared storage. Follow the [database operations runbook](./push-database-cutover.md)
for deployment prerequisites, legacy resource ownership, capacity and recovery.
