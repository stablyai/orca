# Cloud SQL rollout lease

A compare-and-swap lease on one Cloud Storage object, used to serialize Cloud SQL
**connection-budget** rollouts across two repositories.

`concurrency.group: production-cloud-sql-rollout` only serializes runs inside a single repository.
Once the relay workflows live in `stablyai/orca` and the app workflows stay in
`stablyai/orca-cloud`, there are two independent queues pointed at one shared Cloud SQL instance.
`relay-cloud-sql-connection-budget.mjs` computes `rolloutOverlap` as a `Math.max` over the relay
director, api, auth and relay-cell candidates, which is only sound when exactly one rollout is in
flight. This lease is what keeps that assumption true. Keep the per-repo concurrency groups **and**
the lease; they solve different halves of the problem.

## What it protects

No workflow runs a Cloud SQL schema migration. Every locked workflow either deploys a Cloud Run
revision or applies a GCE instance template against the shared instance, so the lease must cover
**all rollouts**, not just migrations.

## Usage

The lease step must run **after** `google-github-actions/setup-gcloud`, and after
`actions/checkout` — `uses: ./.github/actions/...` resolves against the checked-out workspace.
It belongs in the first job of the workflow that holds a GCP credential, which is not always the
gate job: `deploy-relay-production-same-cap`'s gate runs no `gcloud`, so its first acquire happens
in the first cell job.

```yaml
- uses: google-github-actions/auth@v2
    with: { workload_identity_provider: ..., service_account: ... }
- uses: google-github-actions/setup-gcloud@v2
- uses: ./.github/actions/cloud-sql-rollout-lease
  with:
    bucket: onorca-cloud-terraform-state
    object: terraform/state/cloud-sql-rollout/production.lock
```

Buckets and objects in use:

| Environment | Bucket                                 | Object                                              |
| ----------- | -------------------------------------- | --------------------------------------------------- |
| production  | `onorca-cloud-terraform-state`         | `terraform/state/cloud-sql-rollout/production.lock` |
| staging     | `onorca-cloud-staging-terraform-state` | `terraform/state/cloud-sql-rollout/staging.lock`    |

Workflows that serve both environments (`deploy-relay-asia-topology`,
`operate-relay-asia-admission`) select the pair with an `inputs.environment == 'production'`
ternary on both `bucket` and `object`. `deploy-staging` keeps its own `deploy-artifacts-staging`
concurrency group but takes the staging lease, because it rolls the staging API revision.

The object sits beside `terraform/state/relay-fence-broker/<env>.lock`. The IAM grant names both the
relay and app service accounts, so it is a **foundation-root** resource: `roles/storage.objectAdmin`
conditioned on the `terraform/state/cloud-sql-rollout/` prefix, **plus** an unconditioned
`roles/storage.legacyBucketReader`. Without the second role the generation-matched write fails in a
way that looks like a permissions flake.

## One lease per run, not per job

`deploy-relay-production-capacity` calls its reusable job six times and
`deploy-relay-production-same-cap` four times. Each call is a separate job on a separate runner, so
a naive per-job acquire/release would leave the object free between waves — for runs that have taken
up to 85 minutes.

The lease is therefore keyed to the **run**, not the job. `holder-key` defaults to
`${{ github.repository }}/${{ github.run_id }}`, and a job that finds its own holder key on a live
lease **re-enters** it: the record is refreshed, not rejected. Every job in the chain acquires; only
the last one releases.

```yaml
jobs:
  gate:
    steps:
      - uses: ./.github/actions/cloud-sql-rollout-lease
        with: { bucket: ..., object: ..., release: 'false' } # intermediate

  wave-1: # ... release: 'false' on every wave job

  release_lease:
    needs: [gate, wave-1, wave-2, wave-3, wave-4]
    if: always()
    steps:
      - uses: google-github-actions/auth@v2
      - uses: google-github-actions/setup-gcloud@v2
      - uses: ./.github/actions/cloud-sql-rollout-lease
        with: { bucket: ..., object: ..., release: 'true' } # final
```

`release: 'false'` still acquires and still runs its `post` step; `post` only skips the delete. A
single-job workflow leaves `release` at its `true` default and needs no extra job. So does a
workflow whose several jobs can never hold the lease at once: `prove-relay-staging-capacity`'s two
lease-holding jobs are guarded by complementary `inputs.mode` conditions, and the contract test
checks that exclusivity rather than assuming it.

If the final job never runs (runner killed, run cancelled hard), the lease expires on its TTL.

## Timing

- **TTL 35 minutes**, matching `apps/relay-fence-broker/src/mutation-lease.ts`.
- **Renewal every 5 minutes.** `main` spawns a detached background Node process that rewrites
  `expires_at` on the same generation-matched path; `post` kills it by pid read back from
  `$GITHUB_STATE`. The renewer stops on its own the moment the object stops being ours, and has a
  six-hour backstop in case `post` never runs. Its log is written to
  `$RUNNER_TEMP/cloud-sql-rollout-lease-renewer.log` and echoed by `post`.
- Renewal is mandatory, not optional: capacity runs have taken 85 minutes, well past any sane TTL.

## Failure behaviour

| Situation                        | Behaviour                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Object absent                    | Acquire with `ifGenerationMatch: 0`.                                                                              |
| Live lease, our own holder key   | Re-enter. Refresh `expires_at`, keep `acquired_at`. Never fails.                                                  |
| Live lease, another holder       | **Fail the job immediately**, printing the holder's repository, workflow and run URL. Never queues, never steals. |
| Expired lease                    | Take over with the observed generation and emit `::warning::` naming the stale holder.                            |
| `412` on write                   | Someone raced us. Fail as a conflict.                                                                             |
| Bucket unreachable, `403`, `5xx` | **Fail closed.**                                                                                                  |
| Record present but unparseable   | **Fail closed.** A record we cannot read is never treated as free; an operator must inspect and delete it.        |
| Release finds a foreign holder   | Warn and leave it alone. Our lease had already expired.                                                           |
| Release fails                    | Warn only. `post` never fails a job over a release; the TTL bounds the damage.                                    |

## Why `monitor-relay-production` must not use this

`monitor-relay-production` is in the `production-cloud-sql-rollout` concurrency group but is
**read-only**: its identity holds only monitoring, logging, Cloud SQL and compute _viewer_ roles,
and it runs `gcloud sql instances describe`, never a mutation. It consumes no connection budget.
Putting it on the durable lease would let a monitoring run block a real rollout, and a rollout block
monitoring exactly when an operator most needs it. Keep its same-repo concurrency group; keep it off
the lease. The lock census contract test records it in the not-a-candidate map with this reason.

## Token acquisition

`gcloud auth print-access-token`, not a hand-rolled exchange of the `external_account` credentials
file. Every consuming workflow already runs `setup-gcloud`, gcloud already handles every ADC flavour
including the service-account impersonation leg, and this action must stay zero-dependency because
it is duplicated by hand into the public repo. The GCE metadata server that
`apps/relay-fence-broker/src/google-metadata.ts` uses does **not** exist on GitHub or Blacksmith
runners; only the compare-and-swap algorithm is shared with the fence broker.

## Duplication

This directory is copied verbatim into `stablyai/orca`. It has no `package.json`, no
`node_modules`, and imports nothing outside itself — `action-contract.test.mjs` enforces all three.
Cross-repo consumption via `uses: stablyai/orca/.github/actions/...@<sha>` was rejected: it would
put public-repo code inside private app deploys that hold a production credential, and neither
repository protects `main` today.

## Tests

```
node --test .github/actions/cloud-sql-rollout-lease/
```

`storage-lease.test.mjs` drives the real compare-and-swap path against an in-memory Cloud Storage
fake that enforces generations. No network.
