# Orca Relay capacity testing

This harness covers two different launch gates. The deterministic model proves that phase spreading produces the required aggregate heartbeat and auth-refresh rates without a synchronized cliff. The control harness opens real WebSockets, completes the host-key challenge, answers heartbeats, refreshes authorization, and reconnects with full jitter.

Neither mode sends phone payloads or terminal content. Reports contain aggregate counts only. Access tokens and signing keys must be supplied through the documented secret paths and are never printed by the harness.

## Deterministic 4k/10k model

Run:

```sh
pnpm load:relay:model
```

The default profiles are 4,000 and 10,000 standing controls over 15 modeled minutes. The command fails unless:

- 15-second heartbeats produce approximately 267 and 667 pings per second;
- uniformly distributed 180–240-second token refreshes produce approximately 19 and 48 exchanges per second;
- one-second heartbeat and refresh bins remain inside the reviewed burst bounds.

This is a schedule gate, not evidence that a cell can hold those connections.

## Real control load

Use a relay-scoped token source in one of two ways:

1. Set `ORCA_RELAY_LOAD_ACCESS_TOKEN` and pass `--auth-origin`. Every control and refresh then uses the real auth-plane relay-token exchange.
2. Pass `--signing-key-file` containing the environment's auth signing key. This operator-only mode isolates relay capacity from auth capacity. Prefer memory-backed process substitution directly with `node`; `pnpm` may close that file descriptor.

Never put either credential in command-line arguments, URLs, shell history, or reports.

For staging, keep the signing key process-local and out of the filesystem:

```sh
node dev/scripts/load-relay-controls.mjs \
  --director-origin https://relay-staging.onorca.dev \
  --auth-origin https://auth-staging.onorca.dev \
  --signing-key-file <(gcloud secrets versions access latest \
    --secret=orca-cloud-auth-signing-key \
    --project=onorca-cloud-staging) \
  --controls 840 \
  --ramp-seconds 210 \
  --duration-seconds 900
```

Against a local or legacy combined service only:

```sh
pnpm load:relay:controls -- \
  --target-origin http://127.0.0.1:8080 \
  --auth-origin http://127.0.0.1:8081 \
  --signing-key-file "$KEY_FILE" \
  --controls 800 \
  --ramp-seconds 210 \
  --duration-seconds 900
```

Against the stable director and stamped cells:

```sh
ORCA_RELAY_LOAD_ACCESS_TOKEN="$ACCESS_TOKEN" pnpm load:relay:controls -- \
  --director-origin https://relay-staging.onorca.dev \
  --auth-origin https://auth-staging.onorca.dev \
  --controls 800 \
  --ramp-seconds 210 \
  --duration-seconds 900
```

The director form performs a real assignment for every generated relayHostId and follows the returned cell URL/epoch. Stamped GCE cells require this durable assignment; `--target-origin` cannot bypass it. Fresh identities must not exceed `hardCap - controlRebindReserve - unobservedBound` for the target cell. At the reviewed 1,000/60 policy, that placement ceiling is 840 even though the cell can hold 900 already-assigned ordinary controls.

## Sharding

Run one process per shard when the client machine becomes the bottleneck. Every shard receives a disjoint host/user index space:

```sh
pnpm load:relay:controls -- \
  --director-origin https://relay-staging.onorca.dev \
  --auth-origin https://auth-staging.onorca.dev \
  --controls 1000 \
  --shard-count 4 \
  --shard-index 0
```

Start shard indexes `0..3` with the same count and timing. `--controls` is per shard. Compare the combined client reports with Cloud Monitoring rather than summing only successful connection messages.

## Required observations

Capture these before and throughout a launch-gate run:

- active controls, total connections, pending and active splices;
- auth successes/failures and refresh arrival rate;
- reconnect arrival distribution and close codes;
- SQL query failures and maximum interval latency;
- process queued bytes, heap, and event-loop p99;
- GCE instance CPU/memory, LB request/backend latency and 5xx metrics, plus Cloud Run director request/concurrency metrics;
- Cloud SQL CPU, connections, locks, and failover state.

The real harness fails when fewer than 95% of requested controls become active, fewer than 95% remain active after ramp-up, or any steady-state connection, excess ramp retry, excess unexpected close, protocol, refresh, or socket error occurs. Public-load tests may set explicit small ramp-retry and close budgets; both default to zero and remain visible in the aggregate report. Use `--ramp-start-delay-ms` to desynchronize independent client shards. Failure reasons are reported only as bounded aggregate categories. `--allow-partial` exists only for diagnosing a known capacity boundary; a run using it cannot satisfy a launch gate.

For hard-capped candidates, separately verify director placement stops at
`hardCap - controlRebindReserve - unobservedBound` and target ordinary socket
admission stops at `hardCap - controlRebindReserve`. Then overlap up to 100
same-host replacement sockets that present valid authorization, assignment,
generation, and resume data and receive an encrypted host challenge, without
admitting unrelated controls into that reserve. The boundary mode proves
pre-activation socket headroom; activation and generation replacement remain
separate protocol tests. Above 100 concurrent replacements, verify the deployed
clients use the recorded bounded retry path.

Use two independent staging proofs. The temporary 1,000/0 policy permits 900
fresh assignments and exposes the exact physical boundary:

```sh
node dev/scripts/load-relay-controls.mjs \
  --director-origin https://relay-staging.onorca.dev \
  --auth-origin https://auth-staging.onorca.dev \
  --signing-key-file <(gcloud secrets versions access latest \
    --secret=orca-cloud-auth-signing-key \
    --project=onorca-cloud-staging) \
  --controls 900 \
  --rebind-probes 100 \
  --rebind-hold-ms 4000 \
  --ramp-seconds 210 \
  --duration-seconds 900
```

The command must keep all 100 replacements open for the complete hold, require
the next physical socket to receive HTTP 503, and pass the 15-minute soak.

Then apply the final 1,000/60 policy and start a separate 840-control process.
During its explicit delay, rerun the reviewed 1,000/60 transition so the no-op
cell plan performs one exact C3 restart. The boundary checks begin only after
all 840 controls recover:

```sh
CAPACITY_SA="$(gh variable get STAGING_GCP_RELAY_CAPACITY_SERVICE_ACCOUNT --env staging)"
ORCA_RELAY_ADMIN_ID_TOKEN="$(gcloud auth print-identity-token \
  --impersonate-service-account="${CAPACITY_SA}" \
  --project=onorca-cloud-staging \
  --include-email \
  --audiences=https://relay-staging.onorca.dev/v1/admin/drain)" \
node dev/scripts/load-relay-controls.mjs \
  --director-origin https://relay-staging.onorca.dev \
  --auth-origin https://auth-staging.onorca.dev \
  --signing-key-file <(gcloud secrets versions access latest \
    --secret=orca-cloud-auth-signing-key \
    --project=onorca-cloud-staging) \
  --controls 840 \
  --placement-overflow-probes 1 \
  --capacity-cell-id staging-gce-c3 \
  --capacity-hard-cap 1000 \
  --capacity-unobserved-bound 60 \
  --rebind-probes 100 \
  --allow-planned-transition-retries \
  --skip-rebind-overflow-check \
  --rebind-delay-seconds 1800 \
  --rebind-hold-ms 4000 \
  --ramp-seconds 210 \
  --duration-seconds 900
```

The inline environment assignment keeps the one-hour admin token process-local; do
not export, print, or persist it. Before probing, the harness requires two advancing director
heartbeats after recovery with exact 840-connection telemetry, no pending connection
reservations, and the reviewed 1,000/60 policy. This run requires the 841st fresh
placement to receive the capacity-specific HTTP 503 response, then requires a newer
exact director heartbeat while all 840 ordinary controls remain unchanged. This proves at
least 100 replacement sockets remain available, and completes the normal soak.
The explicit planned-transition flag permits only connection retries before the
recovery gate. Expected drain closes and transition retries remain separately
counted; any missing recovery or steady-state error fails the proof. Never
persist generated host keys or resume credentials.

## Cap transition and rollback order

Changing the reviewed cap is a fail-closed operation. The capacity workflow
first builds and prunes a capacity-protocol-2 director rollback pair. It drains
C3, validates the saved Terraform plan, updates the director inventory, and
requires the old cell heartbeat to become stale. It then validates and applies
only C3's instance-template replacement and MIG pointer. A fresh heartbeat must
report the exact cap and unobserved bound before C3 returns to general
placement. Ordinary director deploys do not prune historical revisions.

The staging proof uses reversible admission states. C3 moves to
`migration-only` and drains before replacement. After its fresh heartbeat, C3
becomes the sole general cell while C2 moves temporarily to `migration-only`,
so fresh load identities can only land on C3. The restore mode first makes C2
general as a safe fallback, verifies that C3 is healthy and non-draining, then
restores the reviewed C2/C3 general set. It never uses irreversible
`existing-only` for temporary isolation.

The cell rollout is the forward point of no return. To restore 600, keep the
new director code active, configure 600 there first, then roll the empty cell
back to 600 and require its fresh matching heartbeat. Only after that may an
older director image be considered. Never shift director traffic to a
pre-protocol-2 image while any cell is configured above 600.

## Soak profiles

For the accelerated three-cycle gate, use a test deployment whose lease/rotation intervals are explicitly shortened together and run at both modeled 4k and 10k aggregate levels. Keep enough shards/cells that no client or cell exceeds its reviewed ceiling. Record listener, timer, socket, queued-byte, heap, SQL, and event-loop bounds at every cycle.

For each real-time load-balancer canary, use exact GCE cell hosts through the public external HTTPS LB with the production 86,400-second backend timeout:

- run a low-scale socket past the actual 86,400-second cap to prove the observed LB termination and configured-director recovery path;
- run a separate production-jitter canary spanning at least three proactive rotations before that cap;
- force at least three fixed-one GCE instance terminations and record recovery through strictly newer director assignments.

The control harness is one input to those canaries. The full canary must also run real phone/data pairs and verify earlier-leg deadline handling, close/1006/502/503/504 recovery, subscription replay, deterministic rejection of ordinary in-flight RPCs, and idempotent credential reconciliation. These long-running canaries are public-launch gates; modest served load remains sufficient for implementation iteration.

## Legacy recovery-wave gate

After an isolated local or staging exercise, evaluate its aggregate report:

```sh
pnpm load:relay:recovery-gate -- --report "$AGGREGATE_REPORT"
```

The evaluator has no HTTP or GCP client and rejects production project IDs,
production origins, unknown fields, malformed values, and reports larger than
1 MiB. It exits nonzero unless the report proves all numeric gates:

- 760–840 draining desktops under 10,450–11,550 background requests/minute,
  including the observed assignment-heavy mix and 8,500–10,500 assignment
  `503` responses/minute;
- two targets, each capped at and observed below 600 connections, with every
  desktop recovered; the report must separate physical sockets, in-flight
  upgrades, pending host-data units, and their enforced sum;
- concurrent boundary probes proving every accepted phone can consume its
  reserved host-data leg, control rebind remains available, established
  sockets stay open, and failed upgrades release capacity exactly once;
- a 2-vCPU database, pool size 3, two total public slots, and one
  resolve-priority slot;
- the production one-to-two-instance director range, Cloud Run concurrency 80,
  and an observed two-instance peak during the wave;
- a separate old/new-revision rollout-overlap result that reaches four
  processes and eight public operations while preserving the same resolve,
  readiness, pool-wait, and database-CPU gates;
- zero migration expirations, migration aborts, retry exhaustion, readiness
  failures, and non-public maintenance failures;
- one key-proven target registration per desktop, at least ten minutes on the
  oldest migration lease at drain, and full-wave registration within five
  minutes;
- at least 90% of baseline assignment throughput, at least 95% eligible
  resolve success, and below 1% resolve overload;
- pool-wait p95 below 500 ms, pool-wait max below 5 seconds, database CPU p95
  below 70%, and database CPU max below 85%; and
- recovery within 14 minutes, one minute before the migration lease expires.

The report must come from a controlled production-shaped run that joins client
counts with relay metrics and Cloud SQL monitoring. The gate validates evidence;
it does not generate the reconnect wave or prove that supplied observations are
authentic. Never use a hand-authored passing report as launch evidence.

The rollout-overlap fields may come from a separate isolated sub-run. A
steady-state two-instance wave cannot substitute for the four-process overlap
created while old and new Cloud Run revisions coexist. The old side must run
the current production-equivalent shared gate with zero resolve-priority
slots; the new side must run the candidate two-public-slot scheduler with one
resolve-priority slot.
