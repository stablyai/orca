# Staging Relay deploy identity rollout

Moves the five staging Relay workflows off the apps-owned `github_deploy`
account and onto the relay-owned `github_staging_relay_deploy` account
(`orca-cloud-staging-gha-relay`). This is a **rollout**, not state surgery, so
it lives beside [`terraform-root-split-runbook.md`](./terraform-root-split-runbook.md)
rather than inside it: that runbook is state-only and runs no apply, and every
step below applies.

Production is untouched. `local.relay_github_deploy_service_account_email`
still renders `orca-cloud-gha-deploy` there, and the production relay plan slice
is byte-identical to the pre-split single-root baseline.

## What moves, and what it costs

The staging Relay runtime allowlists exactly one deploy account
(`ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT`, `apps/relay/src/admin-token-verifier.ts`),
so the account, the director env, the four cell startup scripts, and the
workflow variables have to change together. Plan on a staging window in which
no Relay workflow runs.

| Change | Cost |
| --- | --- |
| 10 new identity resources | Create only. No compute. |
| 6 relay bindings repoint to the new account | Delete + create. The old account loses them. |
| `ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT` on the director | New Cloud Run revision. |
| Cells c1–c4 startup metadata | Four instance-template replacements, one MIG repoint each. |

## Preconditions

- [ ] PR 13 is merged, so both accounts are declared and the census test passes.
- [ ] No staging Relay workflow is running or queued. All five share the
      `relay-staging-mutation` concurrency group; `prove-relay-staging-capacity`
      and `recover-relay-staging-c4-image` are in it too.
- [ ] Staging is awake, or you accept waking it as part of step (e).

## (a) Compute-free identity apply

Targeted apply on the staging relay root. Verified against a post-surgery state
copy: **10 creates, nothing else**.

```sh
terraform -chdir=infra/terraform apply \
  -var-file=environments/staging.tfvars \
  -target='google_service_account.github_staging_relay_deploy[0]' \
  -target='google_iam_workload_identity_pool_provider.github_staging_relay_deploy[0]' \
  -target='google_service_account_iam_member.github_staging_relay_deploy_workload_identity_user[0]' \
  -target='google_storage_bucket_iam_member.github_staging_relay_deploy_state_list[0]' \
  -target='google_storage_bucket_iam_member.github_staging_relay_deploy_state[0]' \
  -target='google_artifact_registry_repository_iam_member.github_staging_relay_deploy_artifact_reader[0]' \
  -target='google_cloud_run_v2_service_iam_member.github_staging_relay_deploy_director_developer[0]' \
  -target='google_cloud_run_v2_service_iam_member.github_staging_relay_deploy_auth_developer[0]' \
  -target='google_service_account_iam_member.github_staging_relay_deploy_auth_runtime_user[0]' \
  -target='google_project_iam_member.github_staging_relay_deploy_compute_viewer[0]'
```

Reject the plan if it shows anything but those ten creates.

## (b) Publish the two variables

```sh
terraform -chdir=infra/terraform output -raw github_staging_relay_deploy_workload_identity_provider
terraform -chdir=infra/terraform output -raw github_staging_relay_deploy_service_account

gh variable set STAGING_GCP_RELAY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER --env staging --body '<reviewed output>'
gh variable set STAGING_GCP_RELAY_DEPLOY_SERVICE_ACCOUNT --env staging --body '<reviewed output>'
```

Nothing reads them until (c) merges, so this step is reversible on its own.

## (c) Repoint the workflows and flip the relay bindings

The workflow repoint ships in PR 13. Merging it and applying the six repointed
bindings is one step, because the new account cannot operate without them and
the old account must not keep them:

```sh
terraform -chdir=infra/terraform apply \
  -var-file=environments/staging.tfvars \
  -target='google_project_iam_member.github_staging_relay_power[0]' \
  -target='google_service_account_iam_member.github_relay_runtime_service_account_user[0]' \
  -target='google_service_account_iam_member.github_relay_director_runtime_service_account_user[0]' \
  -target='google_secret_manager_secret_iam_member.relay_regional_placement_deploy_accessor[0]' \
  -target='google_secret_manager_secret_iam_member.relay_regional_placement_deploy_adder[0]' \
  -target='google_secret_manager_secret_iam_member.relay_regional_placement_deploy_viewer[0]'
```

Expect **six replacements plus one create**: the target on
`github_relay_director_runtime_service_account_user` drags
`google_service_account.relay_director_runtime`, which staging has never
created. That create is additive and does not move the director onto the new
identity; only applying `google_cloud_run_v2_service.relay` does that. Drop
that one `-target` if you would rather leave it to the staging drift
remediation, and accept that the new account then has no `serviceAccountUser`
on the director runtime account.

The director's `ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT` changes only through
`google_cloud_run_v2_service.relay`, and applying that address in staging also
carries the whole staging director backlog: the identity swap to
`orca-cloud-staging-relay-dir`, `timeout` 3600s to 30s, concurrency 1000 to 80,
the four-cell topology, and roughly twenty new env entries. Do it as part of
the staging identity remediation in the drift plan, in this same window, with
that plan reviewed on its own terms.

## (d) Roll the cells, one at a time

Use **Prove Relay Staging Capacity**. It authenticates only as
`STAGING_GCP_RELAY_CAPACITY_*`, that is `github_staging_relay_capacity`, never
the new deploy account, and the capacity identity's admin routes
(`RELAY_CAPACITY_ADMIN_ROUTES`) cover every call the roll makes. It is
therefore unaffected by this cutover in either direction.

Per cell the targeted apply is:

```text
-target='google_compute_instance_template.relay_gce_cell["staging-gce-c<N>"]'
-target='google_compute_instance_group_manager.relay_gce_cell["staging-gce-c<N>"]'
```

That plan is one template replacement plus one MIG update, and it also drags an
in-place update of `google_compute_health_check.relay_gce_liveness[0]` from the
standing staging log_config drift. Confirm it is in place, not a replacement.

Two gaps to plan around:

- `prove-relay-staging-capacity` has arms for **c3 and c4** only.
- `bootstrap-relay-staging-capacity` rolls **c2 and c3**, but it mints its admin
  token as the deploy account. Running it across the email change fails: it
  verifies a rolled cell with a token that cell no longer allowlists.
- **c1 has no workflow roller.** Roll c1, and c2 if you do not use bootstrap,
  by the same two-target apply under human review inside the window.

Wait for each MIG to report stable before starting the next cell.

## (e) Verify

Dispatch **Power Relay Staging** in `status` mode. It exercises the new
credential end to end: Workload Identity exchange on the new provider, the
state read, `gcloud sql instances describe` and the MIG reads through
`orcaRelayStagingPower`, `run services describe` on both the director and the
shared staging auth service, and an admin `cell-status` call that only succeeds
if the director allowlists the new account. Then run a `sleep` and a `wake` to
exercise the mutation paths.

## (f) Retire the staging Relay grants on the shared account

Follow-up PR against `infra/terraform-apps`. Once (e) passes, the staging
`github_deploy` account no longer needs the Relay-only reach it has today.
Narrow, in the apps root:

- `google_project_iam_member.github_compute_viewer` — kept only for the Relay
  candidate preflight; no staging app workflow reads GCE topology.
- `google_project_iam_member.github_cloud_run_developer` — project-wide today;
  the Relay services are now covered by the two service-scoped grants above, so
  the apps root can scope it to the API and auth services.
- `google_project_iam_member.github_artifact_writer` — still needed by the app
  deploys; verify before touching.

Leave alone: the AR mirror writer
(`google_artifact_registry_repository_iam_member.github_production_relay_staging_mirror_writer`)
names the **production** deploy account by literal and is unrelated to this
change; `github_runtime_service_account_user` and
`github_auth_runtime_service_account_user` are still used by the staging app
deploys.

## Rollback

Before (c): revert the two variables, or unset them. The job gates skip while
they are empty, and the old account still holds every grant.

After (c) but before the cells are rolled: re-apply the six bindings from the
previous commit, which points them back at `orca-cloud-staging-gha-deploy`, and
revert the workflow repoint. The new account and its provider can stay; they
grant nothing the old path needs.

After the cells are rolled: roll forward. Rolling four templates back costs the
same as rolling them forward and leaves the same window.
