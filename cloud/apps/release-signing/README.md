# Windows release signing gates

Windows releases wait for SignPath approval without reserving a runner. The same
GitHub Actions run builds unsigned inner binaries, waits at an environment gate,
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

## Deployment and activation

Do not activate the production workflow until the rehearsal below passes. The release
preflight intentionally fails when the coordinator or protection configuration is missing.
No service, App or webhook is created by merely merging these files.

1. Register a dedicated GitHub App owned by `stablyai`. Grant **Actions: read**,
   **Contents: read**, **Deployments: read/write**, subscribe to
   `deployment_protection_rule`, and install only on `stablyai/orca`. This service
   does not need a user access token or repository administration access. Enable
   the App's custom deployment protection rule support in GitHub settings.
   Record its App ID and installation ID, and generate a private key. Leave the
   webhook inactive until the service URL is available.
2. Create five separate Secret Manager secrets in the chosen GCP project:
   `release-signing-github-private-key`, `release-signing-github-webhook`,
   `release-signing-signpath-webhook`, `release-signing-reconcile`, and
   `release-signing-signpath-api-token`. Generate distinct random 32-byte secrets
   for the two webhooks and reconciliation. Store the App PEM as the first secret
   and an Orca SignPath API credential as the last. Do not put credentials in git,
   chat, the image, or ordinary Terraform environment settings.
3. Build the coordinator from the cloud workspace and push it to an existing
   Artifact Registry repository. Cloud Run requires a Linux amd64 image:

   ```sh
   docker buildx build --platform linux/amd64 \
     -f cloud/apps/release-signing/Dockerfile \
     -t REGION-docker.pkg.dev/PROJECT/REPOSITORY/release-signing:COMMIT \
     --push cloud
   ```

4. Use the **separate** Terraform root `cloud/infra/release-signing`, with a protected
   remote state backend (configure using an ignored backend override for your GCS
   bucket). Copy `terraform.tfvars.example` to ignored `terraform.tfvars`; fill App
   IDs, project and immutable image digest. Enable Cloud Run, Secret Manager and
   Cloud Scheduler APIs. Supply `TF_VAR_reconcile_token` from the reconciliation
   secret. That value enters Scheduler and Terraform state; restrict access to both.
   Run `terraform init`, `terraform plan`, then `terraform apply`. This root grants
   the coordinator access only to its five secrets and uses no relay credentials.
   Secret rotation requires a new service revision; Scheduler's header must match
   the deployed reconciliation secret.
5. Set the App webhook URL to `<service URL>/webhooks/github`, its webhook secret
   to the GitHub webhook secret, and activate it. Require successful GitHub ping
   delivery. Configure the four environments using a repository administrator token:

   ```sh
   GH_TOKEN="$(gh auth token)" SIGNING_GATE_APP_ID=APP_ID \
     node config/windows-signing/configure-environments.mjs
   ```

   The script creates `windows-{inner,installer}-signing` and
   `windows-rehearsal-{inner,installer}-signing`, disables administrator bypass,
   restricts branches to `main`, and enables the App rule. It refuses to overwrite
   existing reviewer/timer or unexpected branch rules. For pre-merge rehearsal,
   explicitly set `SIGNING_REHEARSAL_BRANCH` and the coordinator's rehearsal policy
   branch to the review branch; restore both to `main` after merge.
6. Set repository variables `SIGNING_GATE_URL`, `SIGNING_GATE_APP_ID`, and
   `SIGNPATH_TEST_CERTIFICATE_THUMBPRINT` (the 40-hex SHA-1 thumbprint of the SignPath
   test signing certificate). `GET <service URL>/ready` must return the App ID,
   repository and all four protected environments.
7. **In SignPath's webhook UI:** URL `<service URL>/webhooks/signpath`,
   Authorization header `Bearer <value of release-signing-signpath-webhook>`.
   Leave the experimental custom body template **off**. The standard payload is:

   ```json
   {"OrganizationId":"c37aa192-a27a-4377-9c90-5d6c95912dc0","SigningRequestId":"REQUEST_UUID","Status":"Completed"}
   ```

8. Dispatch `windows-signing-rehearsal.yml` against an existing stable/RC tag.
   Verify both gates enter waiting before runner allocation and resume through the
   App. Confirm the SignPath API reports `origin.buildData.url` as the GitHub run URL
   (optionally `/job/ID`) and `origin.repositoryData.commitId` as the run's `head_sha`.
   The built tag commit is separately pinned in the checkpoint. If actual API
   semantics differ, correct the binding and regression tests before activation;
   do not relax provenance checks. Exercise denial, duplicate delivery, rerun
   finalization, and missed-webhook recovery via `/reconcile`. Download the evidence
   and verify the nested installer payload passed under the pinned test certificate.
9. After successful rehearsal and review, activate the production caller. A real
   release requires the normal Foundation approvals. Confirm both signing gates and
   the signed installer evidence before allowing publication.

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
