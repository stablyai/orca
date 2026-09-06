# Windows release signing gates

Windows releases wait for SignPath approval without reserving a runner. The same
GitHub Actions run builds unsigned inner binaries and exports the NSIS uninstaller, waits at an environment gate,
packages those signed binaries into NSIS, waits at a second gate, then verifies
and uploads the signed installer to the draft release. Publication depends on
successful finalization and the other platforms. Both signing waves remain
sequential because NSIS must contain the signed inner binaries before it is signed.

The coordinator approves a GitHub custom deployment protection rule only after
reading the immutable checkpoint artifact and the matching SignPath request. It
checks the repository, workflow, branch, run, workflow commit, signing policy and
artifact configuration. Webhook payloads only wake the coordinator; their reported
status never authorizes publication. Failed, denied and canceled requests reject
the gate. Unexpected responses leave it closed.

GitHub-hosted runners perform every signing stage. The existing isolated macOS
workflow can continue using Blacksmith. SignPath Foundation human approval is
unchanged. Rehearsal uses this exact stage graph with separate environments, the
test-signing policy and a pinned test certificate; it never publishes release assets.
The uninstaller shares the first signing request, so there is no third approval.
Its signed bytes and fresh embedding receipt survive checkpoint restoration; the
rehearsal additionally checks the uninstaller extracted or installed from the final EXE.
Tool caches use separate test/production keys and an isolated directory, including
versioned NSIS bundles resolved by the existing cached-elevate script.

## Recovery

- The GitHub gate event handles a SignPath callback that arrived before the wait.
- Duplicate callbacks and concurrent reconciliation do not submit signing requests.
- Cloud Scheduler calls authenticated `/reconcile` every five minutes. One damaged
  run does not prevent other waiting runs from progressing.
- Reruns reuse attempt-one checkpoints and request IDs. Finalization can retry
  downloads, verification and upload. A missing checkpoint or a failure before the
  installer checkpoint requires a fresh release dispatch; never resubmit from a rerun.
- Checkpoints retain the exact unpacked tree and NSIS cache for 30 days and validate
  identity, archive hash and allowed paths before restoration. GitHub's own workflow
  and environment-wait limits still apply; this is not an indefinite queue.
- If submission succeeds but checkpoint upload fails, cancel the orphan request in
  SignPath before a fresh dispatch. The coordinator cannot approve without a checkpoint.
- Service/API outages keep releases waiting. Check Cloud Run logs and Cloud Scheduler
  failures. Do not remove the protection rule to recover a waiting release.

## Setup: complete these steps before merging

Merging changes the production release workflow immediately. It does **not** create
any infrastructure. If merged before setup, new release builds stop at signing
preflight. Deploy and rehearse from this PR branch first; merge after that succeeds.
There is no live coordinator URL yet. You enter the SignPath webhook settings in
**step 8**, after deployment gives you that URL.

The cloud/repository administrator performs steps 1–7; the SignPath configurator
performs step 8. The administrator then runs step 9. Commands below use Bash
(macOS/Linux or Git Bash on Windows), with authenticated `gh`, `gcloud`, Docker
Buildx and Terraform. Replace all capitalized placeholders with your own values.

### 1. Create and install the GitHub App

Open **stablyai organization → Settings → Developer settings → GitHub Apps → New GitHub App**
([create App](https://github.com/organizations/stablyai/settings/apps/new)).

- Name: `Orca Release Signing` (or another available name).
- Homepage: `https://github.com/stablyai/orca`.
- Repository permissions: **Actions — Read**, **Contents — Read**, **Deployments — Read and write**.
- Subscribe to **Deployment protection rule** (`deployment_protection_rule`).
- Keep webhook delivery inactive until step 6.
- Create the App, then **Install App → stablyai → Only select repositories → orca**.
- From the App's General page, record its **App ID** and generate/download a private key.
- Record the **installation ID** from the installation settings URL (the number after `/installations/`).

These are two different IDs. Do not paste the private key into the PR or chat.

### 2. Confirm SignPath can sign every required file

In the Orca project, confirm `windows-inner-binaries-zip` covers the normal inner
PE files **and `uninstaller/orca-uninstaller.exe`**. The upstream uninstaller flow
could continue without that file; this PR deliberately stops the release if it is
missing or not signed. Keep `github-actions-windows-installer` for the outer EXE.
Both `release-signing` and `test-signing` must support this flow.

Record the **40-character certificate thumbprint** for the test-signing certificate.
This is a public certificate identifier, not an API token. Keep the existing
GitHub `SIGNPATH_API_TOKEN` Actions secret in place.

### 3. Store the coordinator's five credentials in Google Secret Manager

Choose the GCP project that will host this service. In that project's **Security →
Secret Manager**, create the following secrets with these exact names:

| Secret name | Secret value |
| --- | --- |
| `release-signing-github-private-key` | Entire downloaded GitHub App PEM file |
| `release-signing-github-webhook` | New random secret, at least 32 characters |
| `release-signing-signpath-webhook` | A different new random secret, at least 32 characters |
| `release-signing-reconcile` | A third new random secret, at least 32 characters |
| `release-signing-signpath-api-token` | SignPath API token with access to Orca signing requests |

Use a password manager to generate/store the three random values, or use
`openssl rand -hex 32` separately for each. The SignPath webhook secret is **not**
the SignPath API token. Never commit any of these values.

### 4. Build and push the service image from the PR branch

From the repository root:

```sh
git switch nwparker/async-release-signing
export SIGNING_PROJECT=YOUR_GCP_PROJECT
export SIGNING_REGION=us-central1
export SIGNING_REGISTRY=YOUR_EXISTING_ARTIFACT_REGISTRY_REPOSITORY
export SIGNING_IMAGE="$SIGNING_REGION-docker.pkg.dev/$SIGNING_PROJECT/$SIGNING_REGISTRY/release-signing:$(git rev-parse HEAD)"
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com artifactregistry.googleapis.com --project "$SIGNING_PROJECT"
gcloud auth configure-docker "$SIGNING_REGION-docker.pkg.dev"
docker buildx build --platform linux/amd64 \
  -f cloud/apps/release-signing/Dockerfile -t "$SIGNING_IMAGE" --push cloud
gcloud artifacts docker images describe "$SIGNING_IMAGE" --project "$SIGNING_PROJECT" --format='value(image_summary.fully_qualified_digest)'
```

Record the final `...@sha256:...` image reference. If there is no Artifact Registry
repository yet, create a **Docker** repository in the chosen region first.

### 5. Deploy the coordinator and the recovery scheduler

Copy `cloud/infra/release-signing/terraform.tfvars.example` to
`cloud/infra/release-signing/terraform.tfvars` (ignored by git). Fill in:

- `project`, `region`, and the full immutable image reference from step 4.
- `GITHUB_APP_ID` and `GITHUB_INSTALLATION_ID` from step 1.
- Leave the organization UUID and secret names at their supplied Orca values.
- In `SIGNING_POLICIES`, keep the **production** branch as `main`.
- Set the **rehearsal** branch to `nwparker/async-release-signing` for the pre-merge test.

For local Terraform runs, authenticate once with `gcloud auth application-default login`.
Use a protected remote Terraform state bucket for this separate root. Create
`cloud/infra/release-signing/backend_override.tf` (already ignored by git) containing:

```hcl
terraform {
  backend "gcs" {}
}
```

Initialize with your bucket below. Do not use the relay Terraform state.
The scheduler's secret enters Terraform state, so only its administrators should
have access to that bucket.

```sh
export TF_VAR_reconcile_token="$(gcloud secrets versions access latest --secret=release-signing-reconcile --project "$SIGNING_PROJECT")"
terraform -chdir=cloud/infra/release-signing init \
  -backend-config="bucket=YOUR_PROTECTED_STATE_BUCKET" \
  -backend-config="prefix=release-signing"
terraform -chdir=cloud/infra/release-signing plan
terraform -chdir=cloud/infra/release-signing apply
export SIGNING_GATE_URL="$(terraform -chdir=cloud/infra/release-signing output -raw url)"
unset TF_VAR_reconcile_token
```

The Terraform **`url` output is the actual service URL**. The service scales down
when idle; Cloud Scheduler calls it every five minutes to recover missed callbacks.

### 6. Connect the GitHub App and protect the environments

Return to the App's **General** settings:

- Webhook URL: append `/webhooks/github` to the service URL from step 5.
- Webhook secret: value of **`release-signing-github-webhook`**.
- Enable webhook delivery. Verify a successful ping under **Recent deliveries**.

Then, from the repository root, run this with a repository administrator's `gh` login:

```sh
GH_TOKEN="$(gh auth token)" SIGNING_GATE_APP_ID=YOUR_APP_ID \
  SIGNING_REHEARSAL_BRANCH=nwparker/async-release-signing \
  node config/windows-signing/configure-environments.mjs
```

It enables the App rule on four environments, disables administrator bypass, and
restricts production to `main` and rehearsal to the PR branch. It refuses to replace
unexpected pre-existing rules; inspect any reported conflict in **Repository Settings → Environments**.

### 7. Set repository variables and check readiness

Open **stablyai/orca → Settings → Secrets and variables → Actions → Variables**.
Create these **repository variables** (not secrets):

| Variable | Value |
| --- | --- |
| `SIGNING_GATE_URL` | Service URL from step 5, without `/webhooks/...` |
| `SIGNING_GATE_APP_ID` | App ID from step 1, not the installation ID |
| `SIGNPATH_TEST_CERTIFICATE_THUMBPRINT` | 40-character test certificate thumbprint from step 2 |

Open `<service URL>/ready` or run `curl --fail "$SIGNING_GATE_URL/ready"`.
It must return HTTP 200 with the correct App ID, `stablyai/orca`, and all four
signing environment names. If it fails, finish the App/environment configuration
before proceeding. `/health` alone does not verify the protection rules.

### 8. Enter the webhook in SignPath — this is the SignPath UI step

In SignPath's webhook configuration, enter:

| SignPath field | Exact value to supply |
| --- | --- |
| **URL** | Service URL from step 5 followed by **`/webhooks/signpath`** |
| **Authorization header** | **`Bearer `** followed by the value of **`release-signing-signpath-webhook`** |
| **Use custom body template (experimental)** | **Off** |

Include the space after `Bearer`. Use the dedicated SignPath webhook secret from
step 3; do not use either the API token or the GitHub webhook secret. Save/enable
the webhook before running the rehearsal. The standard SignPath body is supported.
If the UI offers event selection, include **Completed, Failed, Denied, Canceled**.

### 9. Rehearse before merging

In **GitHub Actions → Windows signing rehearsal → Run workflow**:

- Branch: **`nwparker/async-release-signing`**.
- Tag: an existing Orca stable or RC release tag.
- Run it. This uses the test certificate and does not publish release assets.

The operator must verify both waits release their runner and resume through the App;
SignPath's API provenance matches the GitHub run and workflow commit; and the evidence
contains verified inner binaries, `elevate.exe`, and the actual shipped uninstaller.
The uninstaller uses the first request, so there should still be only **two** requests.
Also exercise denial, duplicate delivery, rerun finalization, and missed-webhook
recovery. A green unit-test run is not a substitute for this live rehearsal.

### 10. Merge, then return rehearsal settings to main

After the live rehearsal, review, and required CI pass, merge the PR. The next
production release uses the new signing gates and still requires normal Foundation
approvals. Keep all four custom protection rules enabled.

For future rehearsals, change the branch policy on **each**
`windows-rehearsal-*-signing` environment from the PR branch to **`main`** in GitHub's
Environment settings. Change the coordinator's rehearsal branch in `SIGNING_POLICIES`
to `main` too, and apply the Terraform update (load `TF_VAR_reconcile_token` again as
in step 5). Production branch settings already remain on `main` throughout.

If credentials are rotated later, deploy a new Cloud Run revision; the scheduler's
Authorization value must match that revision's reconciliation secret.


## Checks

```sh
pnpm --dir cloud --filter @orca-cloud/release-signing typecheck
pnpm --dir cloud --filter @orca-cloud/release-signing test
node --test config/windows-signing/configure-environments.test.mjs
pwsh -NoProfile -File config/windows-signing/signing-control.test.ps1
terraform -chdir=cloud/infra/release-signing validate
```

The PowerShell checks use real nested 7-Zip archives and mocked Authenticode results;
Windows CI runs them without credentials or submitting signing requests. They do
not replace the live SignPath/Windows certificate rehearsal.

References: [SignPath webhooks and API](https://docs.signpath.io/build-system-integration#webhook-notifications),
[GitHub origin verification](https://docs.signpath.io/trusted-build-systems/github),
[GitHub custom deployment rules](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/create-custom-protection-rules),
[SignPath Foundation terms](https://signpath.org/terms).
