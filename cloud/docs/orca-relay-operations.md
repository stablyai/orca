# Orca Relay operations runbook

This runbook applies to the stable Cloud Run director and the production-shaped GCE cells in both environments. It does not authorize a full Terraform apply: staging and production contain unrelated drift, so inspect a saved targeted plan and its destroy count before every apply.

The relay is automatically active for entitled signed-in desktops. There is no rollout flag, cohort, or user toggle. The emergency product kill switch is the auth plane refusing relay-token exchange; use cell drains only to move or terminate existing data-plane work.

## Safety rules

- Never put relay JWTs, access tokens, invite/resume credentials, or signing keys in URLs, shell history, logs, or reports.
- Mint the admin identity token with the exact configured audience, which is the stable director origin plus `/v1/admin/drain`, even when calling another admin path.
- A drain response contains only `recovery: resolve-director`. Never provide a recovery URL from a cell.
- Start the target revision and commit its assignment before asking the source control to drain. Keep the source revision alive while the desktop registers the verified target; existing source splices, installs, and confirmations stay origin-owned until their leases settle or grace ends.
- Treat `4401`, `4404`, and `4429` as endpoint-scoped. `4409`, `4503`, transport failure, `1006`, `503`, and `504` recover through the configured director.
- Resume recovery uses bounded `POST /v1/resolve`; an unexpired invite may use only the director compatibility WebSocket.
- Public assignment and resume recovery share two public database slots. A bounded
  resolve waiter takes the next slot ahead of new assignments, leaving the third
  director-pool connection for non-public work.
- Stop if a plan or command includes an unrelated service, database, bucket, destroy, or a `REPLACE_*` value.

Set environment-specific values without printing the resulting token:

```sh
export PROJECT_ID=onorca-cloud-staging
export REGION=us-central1
export DIRECTOR_ORIGIN=https://relay-staging.onorca.dev
export DEPLOY_SERVICE_ACCOUNT=orca-cloud-staging-gha-deploy@onorca-cloud-staging.iam.gserviceaccount.com
export ADMIN_AUDIENCE="${DIRECTOR_ORIGIN}/v1/admin/drain"
ADMIN_TOKEN="$(gcloud auth print-identity-token \
  --impersonate-service-account="${DEPLOY_SERVICE_ACCOUNT}" \
  --audiences="${ADMIN_AUDIENCE}")"
```

Unset `ADMIN_TOKEN` when the operation finishes.

## Preflight and stop conditions

Before any rebalance, evacuation, deploy, or game day:

1. Confirm `/health` on the stable director and every native target service URL.
2. Confirm the target cell is enabled, has a fresh heartbeat, and has reservation headroom for source units plus its migration lease.
3. Check active controls, splices, pending splices, queued bytes, auth failures, reconnects, SQL failures/latency, heap, and event-loop delay.
4. Confirm Cloud SQL is healthy and the auth JWKS endpoint is serving the expected current and rotation keys.
5. Start a timestamped operator log containing only resource names, epochs, aggregate counts, and response codes.

Stop and roll back or leave the source intact if the target cannot register, source-owned operations do not drain, SQL errors rise, queue/heap alerts fire, or reconnect arrivals form a cliff.

## Staging sleep and wake

The `Power Relay Staging` workflow may stop staging outside internal test windows; it never targets
the production project. Its nightly 09:00 UTC sleep is guarded and fails safely when any cell
reports an active lease, request unit, migration, or observed connection. A successful sleep
disables cell admission, proves quiescence again, makes the active auth/director Cloud Run revisions
scale-to-zero compatible, scales every staging MIG to zero, and finally stops Cloud SQL.
After selector generation 1, scheduled sleep fails closed because waking would
require prohibited re-enablement. Selector-era wake restores every retained
cell process and verifies admission without rewriting it.

Before staging testing, dispatch `wake` with the default `configured` selection. It starts Cloud
SQL, c1, and c2, waits for health, readiness, and authenticated heartbeats, and restores the
Terraform-declared admission cells; disabled c3 stays off. Before any staging Terraform apply or
candidate workflow, wake `all` cells. The local apply command deliberately rejects a stopped or
partially awake staging topology.

Use `status` for a read-only view of SQL activation, MIG target sizes, and the minimum-instance
setting of the active Cloud Run revisions. If a sleep fails after admission was disabled, the
workflow attempts to restore previously enabled cells and leaves SQL and MIGs running. If status
shows SQL stopped while a MIG is nonzero, do not retry sleep: wake staging and inspect the partial
state first.

## Legacy staging tagged-revision deployment

The blue/green script remains for historical protocol fixtures, but live staging now uses GCE cells. This procedure is staging-only and must not be used to replace a production GCE cell. For each stamped cell the script:

1. Adds a drain tag to the exact current 100%-traffic revision and queries its actual tag URL.
2. Registers the candidate cell as disabled, deploys its tagged revision with no traffic and the tag as its cryptographically bound public origin, queries that tag URL, and passes `/health`.
3. Clones the old image into a no-traffic previous-tag keeper with the old cell ID and its tag as the bound public origin. This is the safe return target for recently dormant assignments; the exact original revision remains the source of live controls.
4. Atomically records the keeper URL while disabling new source assignments, enables the candidate, starts bounded aggregate evacuation batches, and drains the exact original revision so desktops resolve the committed target.
5. Waits for every migration lease to report a key-proven target registration, shifts service traffic only after the verified count matches, then completes migrations only as source activity reaches zero.

The workflow obtains Google identity tokens in memory and emits aggregate counts only. It retains drain/previous tags and disabled source-cell rows so live origin-owned work can finish and recently dormant assignments remain routable until normal dormant-TTL reassignment. Do not delete old tags while any assignment still resolves to their cell IDs.

If the workflow stops before source disable, leave the disabled no-traffic candidate in place for inspection. If it stops after migrations begin, do not edit epochs or reservations and do not blindly re-enable the source. Follow the rollback rules below; a migration that never registered a target automatically returns to the source after its lease expires with another newer epoch.

## Production GCE candidate deployment

Production publishes an immutable relay image first, then declares a distinct disabled candidate cell in a reviewed targeted Terraform change. The candidate must have a new cell ID, exact hostname, route, backend service, fixed-one `RECREATE` MIG, and durable incarnation. Never replace the backend behind an existing cell origin.

Run `Deploy Relay Production Candidate` in `preflight` mode before any mutation. The workflow verifies exact-host TLS, `/health`, dependency-backed `/ready`, a fresh authenticated heartbeat, the runtime service account, served digest, fixed-one topology, private-only networking, and survivor request-unit headroom. All production cells remain disabled until an explicit go-live decision.

After launch, `execute` additionally requires the exact `EVACUATE` confirmation. It enables the proven candidate, disables new source assignment, and performs bounded target-first evacuation. Preserve the source route, backend, and MIG until every source-owned splice, install, confirmation, assignment, reservation, and migration lease is drained. Remove those resources only in a later reviewed Terraform change.

## Production multi-target evacuation

Use `Deploy Relay Production Multi-Target` when one candidate cannot hold the
source below the reviewed connection ceiling. Targets are sorted by cell ID,
and active assignments are apportioned deterministically before any mutation.
The workflow rejects a plan when projected or observed target connections
reach 600, request-unit reservations do not fit, or target topology and served
digests do not match Terraform. Current targets expose counts through their
authenticated runtime status. A legacy source without that field must have a
runtime-metrics log no older than 90 seconds; missing or stale telemetry is a
hard stop.

Preflight separately proves that every source assignment can reserve one target
control. It subtracts enforced units and pending reservations from each target's
normal-admission pause instead of using the physical hard cap. Missing, stale, or
internally inconsistent connection-capacity telemetry is a hard stop.

Only new-image cells explicitly configured with
`ORCA_RELAY_CELL_CONNECTION_HARD_CAP=600` and
`ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=<load-proven bound>` use the hard
cap. Configure the same values in the director's cell inventory. Existing
cells without both values retain their current 900-unit admission behavior.
Never add the limit to an old-image cell.

For a limited cell, authenticated status and heartbeat report physical
connections, in-flight upgrades, pending host-data units, and their enforced
sum. The director admits one new control only while:

```text
enforced connection units
  + durable pending-control leases
  + configured unobserved-arrival bound
  < 600 - 100 control-rebind reserve
```

Missing, stale, wrong-incarnation, mismatched-cap, or internally inconsistent
telemetry makes that cell ineligible. The unobserved bound is the isolated
test's maximum arrivals over one heartbeat plus reaction latency and maximum
pre-auth/in-flight units, with 20% safety margin. Record p99 separately as an
SLO, not the safety bound.

The target reserves two units for each accepted phone: the phone socket and
its future host-data socket. The second leg transfers that reservation instead
of competing for capacity. Exactly 100 units are exclusive to same-host
control rotation/rebind overlap; first controls, phones, and unreserved data
sockets stop at the target's exact 500-unit ordinary limit and cannot borrow
them. The director stops placement earlier at
`500 - unobserved-arrival bound`. Authenticated runtime status publishes both
thresholds so rollout automation can gate their exact values. At the hard ceiling the
target returns HTTP 503 for new work and leaves established sockets open. A
503 causes clients to consult the configured director, but a healthy assignment
normally resolves to the same cell; it is backpressure, not an automatic
migration. Rebind rejection within the tested 100-concurrent replacement
bound, or a new-phone rejection rate above the load-proven threshold, stops
rollout; excess simultaneous rebinds use the tested bounded retry path.

Run `preflight` first with every target admission-disabled. `execute` requires
`EVACUATE_MULTI`, disables the source, enables targets serially, publishes each
target's fixed quota serially, and then rechecks all targets. It refuses
`/drain` unless the oldest active migration has at least ten minutes remaining.

Any `/drain` attempt is rollback-unsafe because a lost response cannot prove
the old source did not accept it. Before that attempt, the workflow may restore
source admission only when no target registered. After it, keep the source
disabled and use `recover-forward`; never restore its old assignment epochs.
If the durable attempt is still exactly `prepared`, recover-forward may acquire
the original send permit once and send its original trace and grace. A
`send-may-have-started` attempt without an application receipt remains
ambiguous and must freeze; it is never resent.
For immutable legacy c3, the director durably records the exact cell
incarnation before the workflow sends `{v:1,graceMs:120000}`. A lost response
is never retried before the grace deadline plus 30 seconds. If authenticated
legacy aggregate counts still show active controls/splices then,
`recover-forward` may durably record and send at most one
`{v:1,graceMs:0}` request. It does not add unsupported fields to c3.
Before recover-forward, run the 15-minute production monitor with its explicit
`recover-forward` migration policy and exact existing-only source cell. That
signed policy permits only already registered migrations from that source whose
target control is inactive, which the recovery drain is intended to reconnect.
Recovery registers a conservative capacity snapshot and catches up newly active
source assignments for at most five passes; it still requires exact zero before drain.
Ordinary execute evidence remains strict, and
blocked or expired/unregistered migrations, inactive target runtimes, selector
drift, stale telemetry, and all capacity and database thresholds still stop
both the gate and immediate live recheck.

If the old source has zero controls, splices, pending splices, activity leases,
and reserved units but closing transports prevent completion, run
`fence-source` with `FENCE_SOURCE`. It additionally requires every migration to
have a key-proven active target and zero source activity. The workflow resizes
the fixed-one source MIG to zero, proves no instance remains and its heartbeat
is stale, records a short-lived exact-incarnation fence attestation, then
completes through the shared strict database guard. A new heartbeat invalidates
the attestation.
If the resize response or workflow is interrupted, rerun the same fence mode;
an already-zero source resumes only after the retained topology and database
guards pass.

Terraform intentionally ignores only operational MIG `target_size` drift, so a
later apply cannot recreate a fenced source. All other MIG topology remains
managed and preflighted. Do not resize a relay MIG directly: the guarded
workflow is the only supported zero-size path.

## Dormant return and dormant rebalance

A normal assignment may move only after every activity count is zero and the bounded dormant TTL has elapsed. A returning desktop with a stale epoch resolves/assigns through the director and accepts only the newer authenticated epoch.

For an explicitly selected dormant assignment:

```sh
curl --fail-with-body --request POST "${DIRECTOR_ORIGIN}/v1/admin/rebalance-dormant" \
  --header "Authorization: Bearer ${ADMIN_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data "{\"v\":1,\"userId\":\"${USER_ID}\",\"relayHostId\":\"${RELAY_HOST_ID}\",\"targetCellId\":\"${TARGET_CELL_ID}\"}"
```

`assignment_active` is a stop result, not permission to clear counters. Investigate leases and wait; do not manually rewrite assignment rows.

Validate that source reservations fall, target reservations rise by exactly one pending control, and the next returning desktop registers the returned epoch on the target.

## Cell admission selector

The director has three durable admission states:

- `existing-only` preserves current assignments and sticky resolution but receives no ordinary, dormant, or dead-cell placement.
- `migration-only` receives only explicitly published evacuation assignments.
- `general` receives ordinary placement and may also receive explicit evacuation assignments.

Before the selector boundary, the legacy `enabled` admin field remains compatible:
`false` means `existing-only` and `true` means `general`. Use the explicit
`state` field to stage migration-only targets. Once selector generation 1 is
committed, direct cell-state and cell-config admission changes fail closed.
Every later change must use the selector CAS.

Deploy the selector-compatible director before cutover. Blue/green deployment
creates a separate `selector-rollback` revision at minimum instances zero,
promotes a second compatible revision, and retains older revisions through the
stabilization window. Cutover removes every older revision and refuses to
proceed unless only the compatible active and rollback revisions remain.

First inspect the current generation and exact membership:

```sh
curl --fail-with-body --request POST \
  "${DIRECTOR_ORIGIN}/v1/admin/admission-selector/status" \
  --header "Authorization: Bearer ${ADMIN_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data '{"v":1}'
```

Apply one exact, complete partition of every configured cell:

```sh
curl --fail-with-body --request POST \
  "${DIRECTOR_ORIGIN}/v1/admin/admission-selector/apply" \
  --header "Authorization: Bearer ${ADMIN_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data @selector-request.json
```

`selector-request.json` must contain `v:1`, a unique 8–128 character
`attemptId`, the inspected `expectedGeneration`, and `membership` arrays named
`existingOnly`, `migrationOnly`, and `general`. A cell must appear exactly
once. For generation zero it must also contain `expectedMembershipSha256`: the
lowercase SHA-256 of the inspected membership's canonical UTF-8 JSON, with keys
in `existingOnly`, `migrationOnly`, `general` order and each array sorted. Hash
the current inspected membership, not the desired membership. Prefer the
audited `cutover-admission` operation, which derives this fingerprint directly
from its inspection. The transaction updates the compatibility boolean and all
tri-state membership atomically.

If the apply response is lost or ambiguous, do not create a new attempt.
Inspect status with the same `attemptId`. Continue only when it reports either
`committed` with the exact intended generation and membership or `unchanged`
with the exact previous generation and membership. `diverged` is a freeze and
review result. Reapplying the identical attempt is idempotent.

After the boundary is active, register new empty migration targets only through
`POST /v1/admin/admission-selector/add-migration-cells`. The request contains
one durable attempt ID, the exact current generation, and the complete new cell
configs, including canonical origins and reviewed connection limits. The
operation requires every cell and origin to be new, inserts inventory,
admission, and limit rows, extends migration-only membership, and advances the
selector exactly once in one transaction. Replay the same request after an
ambiguous response; changing its config or reusing its attempt ID fails closed.
One cell may be registered alone; evacuation and supersession still require
their reviewed multi-cell target sets.

Use `retire-migration-cell` to stop exactly one migration-only cell from
receiving new migrations before fencing it. Supply only that cell as the target,
an exact durable selector attempt ID, and `RETIRE_MIGRATION_CELL`. The mode
requires the cell to be migration-only and applies one generation-bound CAS
that moves it to existing-only while preserving every other membership.

For production, publish and blue/green deploy the selector-version-2 director
first. Add the disabled fixed-one Terraform cells, review a targeted plan with
zero destroys and replacements, and apply only their templates, MIGs, backend
services, and exact URL-map routes. Then run `Deploy Relay Production
Multi-Target` in `add-migration-cells` mode with `ADD_MIGRATION_CELLS`, a stable
attempt ID, and the reviewed unobserved bound. Wait for exact TLS, health,
readiness, digest, topology, and heartbeat evidence before including the new
generation in a preflight or monitoring gate.

After generation 1, an `existing-only` cell can never return to
`migration-only` or `general`. A proven migration-only cell may transition to
general as additive capacity through a later CAS. Compatible director
restarts verify this boundary and do not restore legacy admission.

Production cutover uses `Deploy Relay Production Multi-Target` in
`cutover-admission` mode with `CUTOVER_SELECTOR`. Supply the complete proven
general pool and migration-only target set. Every other Terraform cell becomes
existing-only in the single CAS. A lost response is inspected by attempt ID;
only the exact committed result is accepted.

Also supply the exact `unobserved-connection-bound` produced by the passing
incident load gate. Before pruning old director revisions, the workflow proves
every proposed general or migration-only cell is a healthy fixed-one Terraform
deployment serving its pinned digest with a fresh heartbeat. Each must expose
the integrated runtime connection-capacity contract: hard cap 600, control
rebind reserve 100, the supplied unobserved bound, and the corresponding normal
admission pause. Cutover also requires fewer than 45 pre-auth connections and
enough pause headroom for current enforced units plus the director's durable
pending control reservations.

The cutover workflow depends on the hard-cap release exposing
`connectionCapacity` from cell runtime status and
`pendingControlReservations` from director cell status. Missing or mismatched
evidence is a hard stop; do not weaken the gate to deploy the selector branch
alone.

After cutover, candidate and multi-target workflows require existing-only
sources and migration-only targets. Pre-drain failure preserves that selector
membership and never restores legacy general admission.

## Hot-cell rebalance

1. Stop sending new assignments to a demonstrably unhealthy cell without changing already-issued client URLs:

```sh
curl --fail-with-body --request POST "${DIRECTOR_ORIGIN}/v1/admin/cell-state" \
  --header "Authorization: Bearer ${ADMIN_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data "{\"v\":1,\"cellId\":\"${SOURCE_CELL_ID}\",\"enabled\":false}"
```

The disabled state survives director restart. Before selector generation 1,
explicitly re-enable the cell through the same endpoint only after health and
capacity checks pass. After generation 1, use a reviewed selector CAS and
never re-enable a legacy existing-only cell.
2. Move fully dormant assignments first with `rebalance-dormant`.
3. Recompute source/target request-unit headroom. One control costs one unit; one splice costs two; invite/install/confirmation/migration leases also reserve their contract units.
4. Move active assignments one at a time or in a bounded batch using the target-first evacuation below.
5. Pause whenever target total connections approach 800, queued bytes exceed 48 MiB, or any runtime/SQL alert fires.

Do not infer required cells from DAU or phones. Use measured standing controls, splice/reservation distribution, startup/login bursts, and explicit safety margin.

## Target-first active evacuation

Start a durable migration on the director:

```sh
curl --fail-with-body --request POST "${DIRECTOR_ORIGIN}/v1/admin/evacuate" \
  --header "Authorization: Bearer ${ADMIN_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data "{\"v\":1,\"userId\":\"${USER_ID}\",\"relayHostId\":\"${RELAY_HOST_ID}\",\"targetCellId\":\"${TARGET_CELL_ID}\"}"
```

Record the returned `sourceCellId`, `targetCellId`, and strictly newer `assignmentEpoch`. The transaction reserves the target before publishing the epoch.

Ask the source control to resolve the committed assignment while the source revision remains alive:

```sh
curl --fail-with-body --request POST "${SOURCE_NATIVE_OR_TAG_ORIGIN}/v1/admin/drain" \
  --header "Authorization: Bearer ${ADMIN_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data '{"v":1,"graceMs":120000}'
```

Wait for the desktop to register a key-proven target control. Do not proceed on the basis of a socket open alone. Confirm the migration's target registration and that source-owned splices/install/confirmation work remains on the source control.

Complete each migration only after source activity reaches zero:

```sh
curl --fail-with-body --request POST "${DIRECTOR_ORIGIN}/v1/admin/migration-complete" \
  --header "Authorization: Bearer ${ADMIN_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data "{\"v\":1,\"userId\":\"${USER_ID}\",\"relayHostId\":\"${RELAY_HOST_ID}\",\"assignmentEpoch\":${ASSIGNMENT_EPOCH}}"
```

`migration_target_not_registered`, `migration_source_still_active`, and `migration_target_not_active` are safety stops. Do not bypass them.

### Dead-source completion

Use only `Deploy Relay Production Multi-Target` in `fence-source` mode. The
workflow is the authority that proves the source MIG is durably zero, no
instance remains, retained topology matches Terraform, and the exact
incarnation heartbeat is stale before creating the short-lived database
attestation. There is no per-assignment dead-source operator endpoint.

The aggregate operation is idempotent. A missing or expired attestation, new
source heartbeat, source activity, stale target heartbeat, inactive target
control, changed admission, request-unit drift, or aggregate reservation
mismatch is a stop result.

### Registered-target supersession

Use `Deploy Relay Production Multi-Target` in `supersede-target` mode with
`SUPERSEDE_TARGET`. The workflow requires the original source to remain
disabled, proves the failed target's retained topology, disabled admission,
MIG desired size zero, zero instances, and stale exact-incarnation heartbeat,
then records a short-lived fence attestation. It proves replacement health and
conservative connection headroom before enabling the replacement and invoking
the aggregate database operation. Rerun the same mode after a lost resize or
workflow response; it resumes from durable GCE and database state.

Target supersession runs only through the IAM-authenticated private broker. The
requester cannot access Terraform state, Compute mutations, or director
mutation routes. The broker permits one configured cell triple, binds its
gitless checkout to the immutable image commit, and holds a durable GCS lease
through the exact-plan operation. It retains that lease after a failure so only
the same request can resume before expiry. This repair does not consume or
weaken the normal 15-minute source-recovery gate; run that unchanged gate only
after failed-target contention is gone.

The transaction removes only the proven-dead target's leases, preserves
original-source activity, reserves replacement capacity, publishes exactly
`assignmentEpoch + 1`, and retires the old migration atomically. A repeated
identical request returns the same successor. A different concurrent
replacement, live current target, unavailable replacement, unexpected lease
topology, or accounting mismatch fails closed.

## Dead cell

Do not call an unreachable cell or trust it to supply a target. For each affected assignment:

1. Verify another cell has capacity.
2. Start the director evacuation to publish a newer target epoch.
3. Let desktop `1006`/transport recovery resolve the configured director and register the target.
4. Phones resolve through the director; unexpired invites use the director compatibility route.
5. Complete only after expired source activity leases release and the target control is active.

If the dead cell returns, leave its stale epoch fenced. Never decrement an epoch or restore an old assignment row.

## Global admission or memory pressure

At connection headroom, queue, heap, or event-loop alerts:

1. Preserve established controls/splices and reject new pre-auth work through the existing admission reserves.
2. Identify whether pressure is source-local, cell-wide, auth/JWKS, SQL, or a synchronized reconnect event using aggregate metrics only.
3. Move dormant work first. Evacuate active work only when a target has measured request and memory headroom.
4. If every cell is unsafe, make the auth plane refuse new relay-token exchanges, then issue authenticated drains with full-jitter client recovery. This is the kill switch; do not add a flag.

Never raise runtime admission or queued-byte limits during an incident without a load result proving memory headroom.

## Drain and SIGTERM

Planned drain uses the authenticated admin endpoint and a reviewed grace that permits target-first registration and origin-owned operations to settle. Phones and desktops always recover through the configured director.

SIGTERM is a degraded path. It may advertise zero grace, rejects new work, closes phone/data pairs together with `4503`, and cannot guarantee target registration first. Game-day this separately from planned drain.

After either path, verify close/`1006`/`504` observations, bounded reconnect arrival, subscription replay, deterministic ordinary in-flight rejection, and idempotent install/confirmation reconciliation.

## Rollback

Before target registration, an expired migration automatically releases target reservations and returns the assignment to the source with another strictly newer epoch. Verify:

- the migration is marked aborted;
- target pending-control and migration leases are gone;
- source reservation is restored exactly once;
- resolved epoch is newer than both the original and failed target epochs.

Once a target control is registered, do not force the pre-registration rollback. Keep the source control and operations alive, repair the target, or perform a new target-first evacuation to a healthy cell. Never edit epochs or reservation counters manually.

After a deployment traffic shift, preserve the old revision/tag until metrics and live reconnect checks pass. If the new revision is unhealthy, shift traffic back only while old controls are still valid, then issue a strictly newer director migration rather than reusing a prior epoch.

## Game-day matrix

Run and record each scenario in staging before launch:

- kill a cell instance mid-session and observe configured-director recovery;
- send zero-grace SIGTERM and compare it with authenticated drain;
- hold an invite install and a resume confirmation across drain;
- wedge a slow receiver until the bounded queue closes only that splice;
- delay mobile Blob conversion and confirm text/binary counter order;
- rotate JWKS while controls refresh;
- make auth unavailable through expiry plus 60-second existing-splice-only grace, then recover with distributed jitter;
- fail SQL during install/confirm and verify only `not-found` or the one committed result is externally visible;
- return a dormant host, overload a cell, kill a cell, evacuate active work, and exercise pre-registration rollback.

The served black-box relay suite validates the protocol/state transitions used by these procedures. The physical-device and real-GFE canaries remain separate launch gates; unit/black-box success cannot replace them.
