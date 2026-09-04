# Orca mobile push gateway

`orca-cloud-push` is a public Cloud Run service in `onorca-cloud` that turns a desktop
notification into an APNs or FCM push for a paired phone. The desktop registers each phone's
native token with it and calls `POST /v1/send` after the socket fan-out it already does; the
phone dedupes by `notificationId#notificationSeq`. The service is the only place the Apple
`.p8` signing key is readable, which is the reason it exists as a service at all.

The contract every lane builds against is `docs/reference/mobile-push-contract.md` in the
repository root. This document covers only the deploy surface: what Terraform owns, how the
credentials rotate, and what the other repository still has to publish.

**There is no staging push gateway.** That is a decision, not an omission. `push_gateway_enabled`
is false in `environments/staging.tfvars` and true in `environments/production.tfvars`, and every
resource in `infra/terraform/push-gateway.tf` is behind it. A staging gateway would be a tfvars
edit plus a second set of Apple credentials.

## Shape

| Setting | Value | Where |
| --- | --- | --- |
| Cloud Run service | `orca-cloud-push` | `push_cloud_run_service_name` |
| Region | `us-central1` | `region` |
| Instances | min 1, max 2 | `push_min_instances`, `push_max_instances` |
| Database pool | 2 per instance | `push_database_pool_max` |
| Concurrency | 80 | `push_concurrency` |
| Ingress | all | `INGRESS_TRAFFIC_ALL` |
| Invoker | IAM disabled | `invoker_iam_disabled = true` on the service |
| Runtime identity | `orca-cloud-push@onorca-cloud.iam.gserviceaccount.com` | `google_service_account.push_runtime` |
| Database | `orca_push` on the shared Cloud SQL instance | `google_sql_database.push` |
| Hostname | `push.onorca.dev` | `push_base_url` |

The minimum of one instance is deliberate and did not move when the ceiling came down to two. A
cold start delays a notification past the point where it is worth showing, and the three-second
coalescing window lives in instance memory, so the floor is what keeps a notification prompt. The
ceiling is a different question, answered below.

The maximum and the pool are set by the connection budget, not by the gateway's own appetite. Two
instances times a two-connection pool is a draw of 4, and a rollout doubles it to 8, because the
tagged candidate is directly addressable and sits outside the service-wide cap. The shared Cloud
SQL instance's 400 connections were already spoken for by the relay cells, the directors, auth,
and the API, which left five. Four is the whole of the room there was, and the gateway fits in
it.

Two connections per instance is enough for the work. A send runs two or three short queries, so
at concurrency 80 requests queue against the pool for microseconds rather than holding it. A
`lifecycle` precondition refuses a plan whose instances times pool exceeds 4, because a fifth
connection puts the checked budget over its ceiling and blocks `Deploy Relay Asia Topology`,
which gates on it. `dev/scripts/relay-cloud-sql-connection-budget.mjs` counts the gateway and
prints the whole picture.

Authentication is the host proof in `POST /v1/host/challenge`, not Cloud Run IAM, so the service
opts out of invoker IAM with `invoker_iam_disabled = true`, exactly as the relay director does.
The project's domain-restricted-sharing policy refuses an `allUsers` invoker binding, so that is
the only way to reach an open service here.

## Environment

Set on the container by Terraform:

| Variable | Source |
| --- | --- |
| `PORT` | Cloud Run, container port 8080 |
| `ORCA_PUSH_PUBLIC_URL` | `push_base_url` |
| `ORCA_PUSH_FCM_PROJECT_ID` | `push_fcm_project_id`, empty means `project_id` |
| `ORCA_PUSH_DATABASE_URL` | Secret `orca-cloud-push-database-url`, version `latest` |
| `ORCA_PUSH_DATABASE_POOL_MAX` | `push_database_pool_max`, 2 per instance |
| `ORCA_PUSH_APNS_KEY` | Secret `orca-cloud-push-apns-key`, version `latest` |
| `ORCA_PUSH_APNS_KEY_ID` | Secret `orca-cloud-push-apns-key-id`, version `latest` |
| `ORCA_PUSH_APPLE_TEAM_ID` | Secret `orca-cloud-push-apple-team-id`, version `latest` |

`ORCA_PUSH_APNS_TOPIC` and `ORCA_PUSH_COALESCE_MS` are left to their application defaults
(`com.stably.orca.mobile` and `3000`). Add them here only when one of them has to differ from
the code default, so that a code-side change stays visible rather than silently overridden.

Terraform owns the three Apple secret **names, labels, and replication, and never a version.**
The `.p8` is issued by the Apple developer portal, so a Terraform-managed version would put the
private key in state and would fight the rotation below. The database URL secret is different:
Terraform generates that password, so it owns that version, exactly as `relay-database.tf` does.

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

Everything else in `push-gateway.tf` is new and is created by the apply: the `orca_push`
database and user, the database-URL secret and its accessor, the `roles/cloudsql.client` binding
on the runtime account, the Cloud Run service, the domain mapping, and the
three deploy-identity bindings. Save that plan and review it before applying; this root carries
unrelated standing drift, so an untargeted apply is never automatic.

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

It authenticates as the shared production deploy identity through
`PRODUCTION_GCP_RELAY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER` and
`PRODUCTION_GCP_RELAY_DEPLOY_SERVICE_ACCOUNT`, which are already published. No new GitHub
variable is required. That account was chosen because the Cloud SQL rollout lease grant is
foundation-owned and names only that account; a dedicated identity could not take that lease from
this root, and the gateway's schema rollout has to serialize against the relay's.

**That choice widens what this workflow can reach, and the widening is deliberate.** Adding
`push-deploy.yml` to the provider allowlist gives the run the account's whole existing authority,
not only the push bindings: Artifact Registry writer on `orca-cloud`, `roles/run.developer` on
the relay director and the fence broker, accessor and version-adder on the relay
regional-placement secret, and service-account user on the relay runtime identities. It was
accepted as the price of the lease. What `push-gateway.tf` adds on top is three bindings scoped
to the gateway alone: Cloud Run developer on this one service, and service-account user plus
token creator on the runtime account. The bound on the rest is the provider condition, which
admits this exact workflow file on `main` in the `production` environment only, and the workflow
itself, which is dispatch-only behind a typed confirmation.

The run, in order:

1. Builds `apps/push/Dockerfile` with the `cloud/` build context and pushes to the existing
   `orca-cloud` Artifact Registry repository as `push:sha-<commit>`, then resolves the digest.
   This happens **before** the lease is taken. Artifact Registry is not the Cloud SQL instance,
   and a multi-minute build inside the lease would block every relay deploy and rehome for its
   duration.
2. Takes the production Cloud SQL rollout lease and holds it from here to the end. The gateway
   applies its schema while the new revision starts, so the revision **is** the schema step;
   there is no separate migration command to wrap. The lease therefore covers exactly the
   connection-budget window: deploy, probe, shift.
3. Records the currently serving revision as the rollback target, and requires it to still hold
   the Terraform-owned floor and ceiling. The candidate inherits that scaling, so a drifted
   serving revision would be latched rather than corrected.
4. `gcloud run deploy --no-traffic` with a per-run traffic tag, so the candidate boots and
   applies schema while every phone still reaches the previous revision. The deploy passes no
   scaling flag: the shape is Terraform's, and the candidate's inherited ceiling is asserted
   instead.
5. Probes the tagged candidate's own `/ready`, up to 30 times at five-second intervals.
6. Sends a validate-only FCM message as the runtime identity, by impersonation. See below.
7. Shifts 100% of traffic to the candidate and verifies it is the only revision serving.
8. Writes the run summary, including the rollback command, before checking the public origin, so
   the summary exists even when the check that follows does not pass.
9. Checks `https://push.onorca.dev/ready`, up to 30 times at five-second intervals, since the
   origin can lag the traffic move by a few seconds.
10. Always removes the traffic tag, so tags do not accumulate across runs.

**Failure after the shift rolls itself back.** Everything from step 8 on runs with production
already on the candidate, so a failure there is not a failed deploy, it is a live gateway that
has to go back. The run returns traffic to the recorded rollback revision, verifies the move, and
reports it in the summary. A failure *before* the shift leaves production untouched and deletes
the candidate revision, which otherwise sits holding a warm instance and a Cloud SQL pool for
nothing.

To move traffic by hand, from the revision named in the run summary:

```sh
gcloud run services update-traffic orca-cloud-push \
  --project onorca-cloud --region us-central1 \
  --to-revisions <previous-revision>=100
```

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
that comes back registers again and gets a fresh `registrationId`, so a rising dead count is
normal churn; a dead count that spikes across many hosts at once is a credential or topic
problem, not device churn.

## Quotas

Two independent limits, both enforced in the gateway and both returning HTTP 200 with
`status: "rate_limited"` per result rather than failing the request:

| Limit | Scope |
| --- | --- |
| 60 sends per rolling hour | per `hostFingerprint` |
| 200 sends per rolling day | per `registrationId` |
| 20 `registrationIds` | per request, hard cap, HTTP 400 over it |

`push_send_log` backs the two rolling counts and is pruned after 25 hours. Upstream of all
three, FCM V1 bills project quota against `ORCA_PUSH_FCM_PROJECT_ID`, which is why the runtime
account holds `roles/serviceusage.serviceUsageConsumer`; a project-level FCM quota exhaustion
surfaces as `RESOURCE_EXHAUSTED` and is not something the per-host limits can prevent.

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
