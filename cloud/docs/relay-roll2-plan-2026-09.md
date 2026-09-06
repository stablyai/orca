# Relay Roll 2 and close-out plan (2026-09-05)

Owner-approved scope 2026-09-05: finish the relay reliability work with one more cell image roll,
deferring the Cloud SQL private-IP move (2.1, orca-cloud #477) to a separate owner decision. Roll 1
is complete (see `relay-reconnect-2026-09-findings.md`, "Roll 1 complete"); every serving cell runs
`519f4914` except c7 on `85bf6799`.

Estimate: about two working days of effort over one week of calendar time. The cell roll itself is
6 to 7 hours of mostly unattended wall clock, run in the US night.

## Phase 0. Land the code (half a day, no production change)

### 0a. Split PR #18565

The branch mixes three relay/mobile/desktop fixes with the operator record. Split so the record
lands regardless of how the code review goes.

- **Docs PR** (new branch off main): `relay-reconnect-2026-09-findings.md`,
  `relay-improvement-checklist-2026-09.md`, `relay-improvement-roadmap-2026-09.md`, this file.
  Docs only, merge on CI green.
- **Code PR** (rebase #18565 onto main, resolve two conflicts):
  - `cloud/apps/relay/src/host-session-registry.ts`: conflict with #18698 (signed-out signal).
    Keep both; the accept-abandonment and lease changes are orthogonal to the signed-out path.
  - `src/main/runtime/relay/relay-origin-pool.ts`: **drop this branch's version**. #18719 already
    merged the desktop early-window jitter (1 to 6 min). Also drop
    `relay-session-broker.test.ts` additions that only exercise the dropped change.
  - Keep: relay accept abandonment (`orca_relay_client_accept_abandoned` event), relay-side lease
    jitter, mobile direct-probe fail-fast, and their tests.

### 0b. Lengthen the control lease (same code PR)

In `cloud/apps/relay/src/host-session-registry.ts`:

```
CONTROL_LEASE_MS        = 6 * 60 * 60 * 1000   // was 55 min
CONTROL_LEASE_JITTER_MS = 30 * 60 * 1000       // was 5 min
```

Why 6 h: the lease bounds how long a host stays on a cell after a missed drain and is the only
passive rebalancing; 6 h keeps both and cuts control-activation traffic on the inventory lock by
about 6x. Nothing else depends on it: the relay JWT (5 min) is refreshed by the desktop on its own
schedule and liveness is the 75 s silence watchdog. Wire-safe: the relay sends `leaseExpiresAt` in
the hello ack and old desktops schedule from that value.

Update the comment above the constants and the three assertions in
`host-session-client-accept.test.ts` that pin the lease arithmetic. Check that nothing in
`cloud/apps/relay-ops` or the monitor thresholds assumes a 55 min rotation period (grep
`55`, `CONTROL_LEASE`, `rotation`).

### 0c. Review and merge

Review rounds per the standing process (Opus review, then Codex pass). Merge order: docs PR first
(no dependency), then the code PR. Record the merge SHA of the code PR; that is the Roll 2 image
source.

## Phase 1. Build and stage the image (half a day)

Roll 2 image = code PR merge SHA. It carries, relative to `519f4914`:

| Change | PR | Effect |
|---|---|---|
| Per-cell inventory locks, delta counters | #18722 | Removes the global `relay_cells FOR UPDATE` behind the phone accept hang |
| Relay pool `statement_timeout` 5 s | #18722 | A relay query can no longer hang a cell |
| Accept abandonment | #18565 | Cell stops finishing accepts for phones that already closed |
| Control lease 6 h ± 30 min | #18565 | Fewer, spread-out rebinds |
| `--private-ip` proxy flag support | #18720 | Code only; flag stays unset until 2.1 |

Steps, in order (from the findings doc's post-merge dispatch plan):

1. `gh workflow run cloud-publish-relay-production.yml --ref main -f mode=publish`. Resolve the
   digest by tag, not from the log:
   `gcloud artifacts docker images describe us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay:sha-<merge-sha> --format='value(image_summary.digest)'`.
2. Staging: `cloud-deploy-relay-staging.yml` with the new digest; paired phone plus desktop smoke
   (connect, background, reconnect). Confirm `orca_relay_client_accept_abandoned` appears only when
   a client closes early, and that `sqlLatencyMsMax` no longer pins at the lock timeout.
3. Director: `cloud-deploy-relay-production-director.yml -f image-digest=<new>
   -f regional-placement-mode=preserve -f prune-incompatible-revisions=false
   -f expected-rehome-generation=12 -f bootstrap-runtime-identity=false
   -f predecessor-image-digest=<serving digest>`. Blue/green; prior revision stays as rollback.
   Watch director `orca_relay_postgres_transaction_retry` per minute before and after. The director
   goes first so the per-cell locks are live before any cell restart burst.
4. Same-cap `verify` mode against c7 with target=<new>, rollback=`519f4914`. Read-only.

Go/no-go for Phase 2: director serving the new image for at least 30 min, retries per minute at or
below the pre-deploy baseline, no `container die`, no auth 5xx.

## Phase 2. Roll the cells (one US night, mostly unattended)

Same machinery as Roll 1: `cloud-monitor-relay-production.yml` dry-run gate, then
`cloud-deploy-relay-production-same-cap.yml`. Cells roll one at a time by design (exact selector
assertions, single Terraform state, and one cell's ~1.2k-host reconnect burst per restart). Do not
add parallelism for this roll.

Inputs: target=<new digest>, rollback=`519f4914` (c7: rollback=`85bf6799`). Selector membership is
unchanged from the end of Roll 1 (gen 148; existing-only c1–c6, c11, c12; migration-only c17, c18).

Order:

1. **c7 canary** (`canary-apply`, protocol 1). c7 is the rehearsal cell and the only one not on
   `519f4914`.
2. **c8 canary**, then **batch c9, c10, c13, c14**.
3. **c15 canary**, then **batch c16, c19, c20, c21**.
4. **c22 canary**, then **batch c23, c24, c25, c26**.
5. **Asia c27, c28, c29** as three single canaries at protocol 0 (`PROTO=0`). Batch mode cannot
   take Asia cells yet and needs at least two cells.

Each batch needs a same-commit canary authority; each wave needs a fresh 15 min gate. Use the
chain script pattern from Roll 1 (wait gate green, check trusted-path ancestry, dispatch within 5 min,
log `CANARY <run> <status>`) under `caffeinate -i`. Budget: 11 to 13 min per cell plus 15 min per gate,
about 6 to 7 h total.

Per wave checks (same as Roll 1): transition verifier passes at migration-only and again at general
with assignments carried; no `container die` fleet-wide; selector generation advances by exactly 2
per cell. After the Asia cells: image census from MIG templates; every general cell on the new digest.

Failure handling: a failed canary re-enters through `mode=rollback` with rollback-digest = desired
image (Roll 1 c27 pattern). A gate freeze on an Asia latency probe despite the 4 000 ms bar is a
stop-and-investigate, not a retry. Monitor-side freezes (freshness, continuity deadline) re-gate
after a 2 min back-off; the chain does this on its own.

Record every gate and wave in the findings doc as in Roll 1.

## Phase 3. After the roll (spread over the following week)

- **4.4 Recalibrate the retries bar.** After one week of `orca_relay_postgres_transaction_retry`
  on the new image, re-derive the `postgres_retries` monitor threshold from the new baseline
  (PR against `cloud/apps/relay-ops/src/incident-monitor.ts` thresholds). About 2 h.
- **1.2 Pruner budget.** Raise `auth_token_pruner_max_rows_per_run` to the default 200k after a
  clean day; watch Cloud SQL write MB/s and the checkpoint alert. Then **1.5** log metric plus
  policy on `stopReason != complete`.
- **1.3 Reclaim.** Once pruner runs delete ~0 rows: `pg_repack -t refresh_tokens` off-peak (check
  `pg_available_extensions` first; not `VACUUM FULL`). Confirm table, index, and `disk/utilization`
  dropped.
- **Monitor residuals** already in the checklist: `probeEndpointHealth` retry decision still uses the
  flat 2 000 ms bar; operator protocol unbound for Asia; `probe-relay-rehome-trust` regex.
- Update the checklist status header; tick 2.3, 4.1, 4.3 relay-side as deployed.

## Deferred, owner decision required

- **2.1 Private IP** (orca-cloud #477). One-way door with a Cloud SQL restart. When chosen: apply the
  foundation off-peak, then a template-only change that sets the `--private-ip` proxy flag. That is
  another cell roll unless bundled with a future image.
- **5.2 Paging channel** for auth alerts: needs a destination.
- **Parallel cell rolls** (2 or 3 at a time): about 1.5 days (relax exact-selector assertions to
  "exact except in-flight", single coordinator Terraform apply, parallel job shape, tests). Only
  worth building if more image rolls are planned after Roll 2, and only once the per-cell locks are
  live so a multi-cell reconnect burst is safe.
- **2.2 Database split**: deferred to ~2026-11-01.

## Not in this plan

Desktop and mobile changes already merged (#18719 desktop early-window jitter and no same-token
refresh retry; #18565 mobile fail-fast once merged) ship with the next desktop and mobile releases
on their own schedules. No relay action needed.
