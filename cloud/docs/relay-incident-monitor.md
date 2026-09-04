# Relay incident monitor

Status: monitor core and dedicated identity boundaries are implemented locally;
the targeted production bootstrap and live negative-permission proof remain
required before dispatch.

This monitor is read-only. It probes Relay endpoints and reads Cloud Monitoring, Compute
inventory, and authenticated aggregate director status. It does not drain, restart, resize,
deploy, change admission, or write to Google Cloud.

## Production workflow

Run `Monitor Relay Production` manually. Choose:

- `dry-run` for the required 15-minute pre-drain gate.
- `monitor` for a 90-minute incident watch.

Use the default `strict` migration policy for ordinary mutations. Select
`recover-forward` only after a drain attempt has durably registered migrations
and enter its exact existing-only recovery source cell. Recovery evidence tolerates
only the aggregate count of registered migrations whose target control is not
currently active for that source. Blocked or expired/unregistered migrations and every other
health threshold remain unchanged.

Enter the exact selector generation and all three disjoint membership sets:
`existing-only`, `migration-only`, and `general`. Every configured cell must
appear exactly once. Generation zero is the only mode that reads the legacy
boolean admission field; selector-era generations use only the durable
tri-state membership. Any generation or membership mismatch freezes the gate.
The workflow verifies dependencies and restored evidence before
authentication. It has no shared-deploy fallback and accepts only the dedicated
monitor provider and service-account production environment variables. Do not
dispatch it until the targeted identity bootstrap is applied and its live
negative-permission checks pass.

The job polls every 60 seconds and writes private aggregate evidence at 0, 5, 15, 30, 45, 60, 75,
and 90 minutes where applicable. It uploads state JSON, checkpoint JSONL, and Markdown for 14
days. No tokens, request bodies, logs, user IDs, host IDs, or relay device IDs are recorded.
Reruns keep one stable incident ID, restore the immediately preceding private
artifact, verify its commit/run/attempt provenance and content hashes, and pass
`--restart`. A missing or mismatched artifact fails closed. A missing, stale,
or collector-failed sample is durably recorded and resets the active continuous
window. The next fresh sample starts a new 15- or 90-minute window under the
same incident lineage.

Exit code `2` means the gate froze or a dry run failed. Missing, stale, malformed, unauthorized, or
unavailable telemetry fails closed.

## Local use

The active `gcloud` identity must be a service account that can mint an ID token for the exact
audience `https://relay.onorca.dev/v1/admin/drain`, and it needs read access to the monitored GCP
resources. A user account normally needs Token Creator on an approved service account.

For a short run, an already minted JWT may instead be supplied through
`ORCA_RELAY_ADMIN_ID_TOKEN`. The token must remain valid for the whole run and is never persisted.
Use refreshable service-account credentials for the 90-minute mode.

```sh
pnpm incident:relay -- \
  --environment production \
  --incident-id relay-incident-20260728 \
  --expected-selector-generation 2 \
  --expected-existing-only-cells production-gce-c1 \
  --expected-migration-only-cells production-gce-c2 \
  --expected-general-cells production-gce-c3,production-gce-c4,production-gce-c5,production-gce-c6
```

Add `--pre-drain-dry-run --duration-minutes 15` for an ordinary gate. Add
`--migration-policy recover-forward --recovery-source-cell-id <source>` only
for a committed forward-recovery gate. Durable files default to
`.relay-incidents/`. If the process stops, rerun the identical command with `--restart`. A runner
gap resets the active window at the next fresh sample and preserves the prior
window evidence. A threshold freeze never clears automatically.

A production candidate or multi-target mutation must download the exact
dry-run artifact by workflow run ID and attempt. It verifies the artifact
hashes and provenance, requires a green completed 15-minute state no older
than five minutes, then rechecks the live selector and one complete fresh
sample of every safety signal immediately before running the mutation command.
The signed state binds `strict` evidence to ordinary mutations and
`recover-forward` evidence to the exact recover-forward source; neither can
authorize the other.
The monitor and mutation jobs share one production lock. A passing dry-run is
durably marked consumed before mutation and cannot authorize another run.

## Freeze thresholds

| Signal | Freeze condition |
| --- | ---: |
| Active probe age | over 60 seconds |
| Cloud/log data age | over 180 seconds |
| Cell heartbeat age | over 45 seconds |
| Endpoint latency | over 2,000 ms |
| Cloud SQL CPU | over 80% |
| Cloud SQL memory | over 90% |
| Cloud SQL backends | over 250 (62% of the verified 400-connection ceiling) |
| Cloud SQL waiting backends | over 20 |
| Cloud SQL deadlocks | over 0 |
| Relay pool waiters | over 800 |
| Relay pool wait | over 2,500 ms |
| PostgreSQL retries in five minutes | over 300 |
| Exhausted PostgreSQL retries | over 0 |
| Director instances | outside 5–6 |
| Director CPU or memory | over 80% |
| Director concurrency | over 64 |
| Unexpected director 5xx or auth 5xx in five minutes | over 0 |
| Connections per cell process | over 500 |
| Queued bytes per cell process | over 48 MiB |
| Blocked or expired/unregistered migration | over 0 |
| Registered migration with inactive target | over 0, except in `recover-forward` evidence |

Expected enabled cells must also have a powered runtime, healthy and ready endpoints, fresh
heartbeats, and matching live admission.

## Implementation log

- Recalibrated the relay pool freezes from 30 waiters / 1,000 ms to
  800 waiters / 2,500 ms (2026-08-27). Basis, measured from
  `orca_relay_runtime_metrics` (`databasePoolWaitersMax`,
  `databasePoolWaitMsMax`): healthy fleet-wide bursts reach 43 waiters and
  2.03 s several times an hour (52 burst-minutes over three days), a cell
  roll's reconnect surge peaks at 676 waiters, and the 2026-08-23 incident
  peaked at 356 waiters without ever crossing 2.5 s — amplitude does not
  separate incident from routine operation in either direction, and a
  15-minute gate had roughly one-in-six odds of freezing on a burst. The
  retry signals discriminate that incident at ~10x separation and keep their
  thresholds; the pool bars now fence only unbounded queueing.
- Recalibrated the Cloud SQL backends freeze from 160 to 250 (2026-08-26).
  Basis, measured from `cloudsql.googleapis.com/database/postgresql/num_backends`
  latest-sum over 24 healthy hours: mean ~100, 1-minute spikes to 216, with
  10 minutes over the old bar of 160 — enough to freeze roughly one in ten
  15-minute pre-drain gates on baseline noise. 250 clears measured healthy
  peaks and still fires well before the verified 400-connection ceiling;
  pool waiters, pool wait latency, and exhausted retries keep their strict
  thresholds.
- Recalibrated the PostgreSQL-retry freeze from 20 to 300 per five minutes
  (2026-08-26). Basis, measured from
  `jsonPayload.event="orca_relay_postgres_transaction_retry"` in production
  logs: healthy-day bursts reach 234/5min with zero exhausted retries and 26%
  of five-minute windows over 20, while the 2026-08-23 lock-contention
  incident ran roughly 2,200–3,000/5min. Exhausted retries stay at zero
  tolerance.
- Added a fail-closed state machine with latched threshold freezes,
  generation-scoped checkpoint boundaries, continuity-reset evidence, cadence
  accounting, restart-gap recovery, and the 15-minute pre-drain gate.
- Added Cloud Monitoring, active-probe, relay runtime, and authenticated director collectors.
- Added exact Cloud SQL instance and Cloud Run service filters, five-minute
  DELTA aggregation, and serialized aggregate admin reads so monitoring cannot
  load the director's three-connection database pool.
- Added private atomic state, idempotent JSONL checkpoints, and secret-safe Markdown evidence.
- Added the manual production workflow. It has not been dispatched.
