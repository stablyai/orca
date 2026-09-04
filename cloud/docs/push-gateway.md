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
| Instances | min 1, max 4 | `push_min_instances`, `push_max_instances` |
| Concurrency | 80 | `push_concurrency` |
| Ingress | all | `INGRESS_TRAFFIC_ALL` |
| Invoker | IAM disabled | `invoker_iam_disabled = true` on the service |
| Runtime identity | `orca-cloud-push@onorca-cloud.iam.gserviceaccount.com` | `google_service_account.push_runtime` |
| Database | `orca_push` on the shared Cloud SQL instance | `google_sql_database.push` |
| Hostname | `push.onorca.dev` | `push_base_url` |

The minimum of one instance is deliberate. A cold start delays a notification past the point
where it is worth showing, and the three-second coalescing window lives in instance memory.

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
foundation-owned and already names it; a dedicated identity could not take that lease from this
root. Its authority over the gateway is exactly three bindings in `push-gateway.tf`: Cloud Run
developer on this one service, service-account user on the runtime account, and token creator on
the runtime account.

The run, in order:

1. Takes the production Cloud SQL rollout lease and holds it for the whole run. The gateway
   applies its schema while the new revision starts, so the revision **is** the schema step;
   there is no separate migration command to wrap.
2. Builds `apps/push/Dockerfile` with the `cloud/` build context and pushes to the existing
   `orca-cloud` Artifact Registry repository as `push:sha-<commit>`, then resolves the digest.
3. Records the currently serving revision as the rollback target.
4. `gcloud run deploy --no-traffic` with a per-run traffic tag, so the candidate boots and
   applies schema while every phone still reaches the previous revision.
5. Probes the tagged candidate's own `/ready`, up to 30 times at five-second intervals.
6. Sends a validate-only FCM message as the runtime identity, by impersonation. See below.
7. Shifts 100% of traffic to the candidate, verifies it is the only revision serving, and
   checks `https://push.onorca.dev/ready`.
8. Always removes the traffic tag, so tags do not accumulate across runs.

Rolling back is a traffic move, printed in the run summary:

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
they fail the run before traffic moves. Probing as the deploy identity instead would prove
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

## DNS: one record the other repository owns

The Cloud Run domain mapping is created here, and Google issues and renews the certificate. The
`onorca.dev` zone is not in this root: it belongs to the apps root in `stablyai/orca-cloud`. The
mapping stays pending until that repository publishes:

```text
push.onorca.dev.  CNAME  ghs.googlehosted.com.
```

`terraform -chdir=infra/terraform output push_dns_record` prints the same three fields, and
`push-gateway.tf` carries the matching TODO next to the mapping.
