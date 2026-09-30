# Relay improvement: implementation checklist, lanes, and disruption

Companion to [`relay-improvement-roadmap-2026-09.md`](./relay-improvement-roadmap-2026-09.md) (item numbers
match). This file answers three questions per item: what are the concrete steps, what can run in parallel,
and will a user notice.

## Status as of 2026-09-06 16:30Z

Three buckets. "Merged" means the code is on `main` and nothing in production has changed yet. "Deployed" means users are already getting it. "Awaiting owner" means I will not touch production without a go.

**Deployed to production**
- Roll 2 relay image `4916ed67` (stablyai/orca #18959 + #18722 + #18720 flag unset): director since 2026-09-06 01:02Z, all 19 general cells by 16:29Z. Control lease 6 h ± 30 min, accept abandonment, per-cell inventory locks, pool `statement_timeout`. Record: findings doc, "Roll 2" section.
- Auth instance cap 20 + dead-family audit fix (orca-cloud #474) as revision `orca-cloud-auth-00031-tox`.
- Dynamic NAT ports in both regions (stablyai/orca #18693). Zero drops and zero proxy dial errors since.
- Nine alert policies with log metrics: 4 auth (#475), 3 relay Cloud SQL/NAT (#18693), 1 cell process-exit (#18717), all on the relay Slack channel.

**Merged, not yet live**
- Cells dial Cloud SQL with `--private-ip` when configured (#18720). Deployed in Roll 2 with the flag unset; inert until 2.1 applies.
- Phone shows a clear "sign in on the desktop again" state when the desktop is signed out (#18698).

**Merged, ships with the next auth deploy**
- Refresh rotation grace window (orca-cloud #478). Startup adds one nullable column (brief exclusive lock on `refresh_tokens`).
- Pruning job code (orca-cloud #476) is in the image; the job itself is Terraform-disabled until 1.2.

**Merged, ships with the next desktop release**
- Never replay a refresh token after a timeout; ±10 % jitter on relay lease renewal (#18719).
- Renderer learns when a cloud session is revoked (#18694).

**Merged, not applied**
- Incident dashboard (#18717) blocked behind the runtime-metric label drift (5.x first item).
- Monitor probe fix (#18723) is live in the workflow; the same-cap roll gate has not yet produced a green dry-run since.

**Awaiting owner go (production mutations)**
1. Roll 1 cell image roll (1.1): dry-run gate, then c8 canary, then batches.
2. Auth deploy carrying #478 (3.1): quiet minute for the column add.
3. orca-cloud #477 private IP (2.1): merge arms an instance restart and a one-way door. Recommendation: hold.
4. Runtime-metric `region` label drift (5.x): intentional replacement of 21 metrics, or drop the label.
5. Enable pruning (1.2): first budget 20k rows; needs a Terraform apply.
6. Paging channel for auth alerts (5.2): needs the destination from you.

**Open code follow-ups (no gate, nobody assigned)**
- Monitor summary Markdown does not render `tolerated: true` continuity events (added by #18798); the state artifact has them, the checkpoint table does not.
- Relay container boot races the `cloud-sql-proxy` sidecar: c13's fresh container exited twice (`applyPostgresSchema` connection timeout, 2 s each) before the proxy was listening. Make schema apply wait for the proxy or order the containers.
- `cloud-deploy-relay-production-capacity-job.yml` (~line 416) has the same wave-0 single-shot preflight carve-out that #18778 removes from the same-cap job; its single-evidence path never retries freshness-only failures.
- `cloud/package.json` `test` names every dev-script test file explicitly; an unregistered `*.test.mjs` is silently never run in CI (found by #18769). Needs a glob or a ratchet that fails on an unlisted test file.
- Same-cap job's verify step uses bare `curl --fail-with-body` against the just-rolled cell; one 503 at the LB warm-up edge failed c8 canary #2 (run 33935407461) after the transition verifier had already passed. Needs a bounded retry, same rule as #18723/#18740.
- `verify-mutation` in `cloud-deploy-relay-production.yml`, the multi-target workflow, and the capacity workflow still binds to an exact commit; same exposure #18754 fixed for the same-cap and rehome paths.
- `incident-live-preflight-cli.ts` reports only `source/code` (`active-probe/threshold_max`) with no signal name or observed value, so a failed mutation preflight (c27 recovery #3, run 33986948522) cannot be attributed to an endpoint without an out-of-band probe. Print the signal and observed/threshold pair. Related: the 2 000 ms `endpointLatencyMs` bar is shared by US and Asia cells while Asia /health round trips from a US runner sit at 0.7–1.3 s idle; consider a per-region bar or the p50 of the gate window instead of one shot. Gates #44 and #45 (2026-09-05) both froze on `cell.production-gce-c27.latency_ms` at 2.6–2.7 s with c28 showing the identical tail under operator probes; the bar is now blocking Asia rolls. **Fix: stablyai/orca #18877** (per-region `cellEndpointLatencyMs`, us-central1 2 000 / asia-east2 4 000, plus signal/observed/threshold in preflight messages). Residual: `probeEndpointHealth` in `resource-inventory.ts` still uses the flat 2 000 bar to decide whether to retry after the 10 s readiness-cache wait, so a healthy Asia cell over 2 s costs one extra probe per sample (latency, not verdict); thread the region bar into the retry decision.
- The root oxlint config ignores `cloud/**`, so `check:code-quality:changed` never inspects relay-ops or the cloud dev scripts; typecheck + vitest is the only gate there.
- Monitor bars that froze on non-health today: `directorInstancesMin: 5` with `latest-sum` (one-minute instance recycle), `endpointLatencyMs: 2000` on a US-runner probe to asia-east2, `cloudDataMaxAgeMs: 180000` vs Cloud Monitoring publish lag up to 255 s. Recalibrate with a week of data.
- `parsed()` in `resource-inventory.ts` still returns null on a 200 with a malformed MIG body; a second path to `runtime_power_unknown`.
- Deploy script strips `ORCA_CLOUD_REFRESH_TOKEN_TTL_DAYS` on every release (3.1 first item).
- `assignOnce` placement lock still global (4.1 remainder).
- Region preference (4.2), retries-bar recalibration after a week of Roll 2 data (4.4), pruner `stopReason` alert (1.5).
- Full apps-root apply for 4 unrelated drifts (1.4), from a host with the 1Password account.

## Uplift ranking (reliability gained per unit of effort)

| Rank | Item | Why it ranks here |
|---|---|---|
| 1 | 1.1 cell image roll | Removes the only crash mode we have seen in production. 22 of 23 cells still have it. One afternoon. |
| 2 | 3.1 refresh rotation grace window | Turns the entire "slow auth → mass sign-out" class into a slowdown. One day. |
| 3 | 4.1 inventory lock contention | The floor under every 503 and slow phone accept, every day, not just incidents. One week. |
| — | 2.2 relay/auth database split | **Deferred 2026-09-04** to ~2026-11-01. Biggest structural fix, but the concrete cause is fixed and alerts now page; see roadmap 2.2 for re-open triggers. |
| 4 | 1.2 + 1.3 pruning and reclaim | Defuses the 63 M-row time bomb. Low effort, mostly waiting. |
| 5 | 5.1 + 5.2 crash alert, page a human | Cheapest detection uplift; today's incident ran 4 h unpaged. |
| 6 | 2.1 private IP | Durable version of a fix that already landed (dynamic NAT ports). Do it on the existing instance. |
| 7 | 4.3 + 3.2 desktop hardening | Small, ride the normal desktop release. |
| 8 | 4.2, 4.4, 5.4, 1.4, 1.5 | Housekeeping and quality-of-life. |

## The shared bottleneck: cell rolls

Every change to what runs on a cell (image, proxy flag, env, relay code) needs a same-cap roll: drain →
recreate → verify, one wave at a time, gated by the 15-minute monitor, about an afternoon. Each wave forces
the desktops on that cell to re-dial (c7 canary: 807 controls re-dialed in ~10 s) and phones on those
desktops reconnect on their normal retry. Users see a few seconds of "reconnecting" per wave.

So batch. Two rolls, not five:

- **Roll 1 (now):** current image only (1.1). Do not wait for anything else.
- **Roll 2 (week 2–3):** proxy `--private-ip` (2.1) + relay pool `statement_timeout` (2.3) + lock-contention
  fix (4.1), all in one image/template. Prerequisite: 2.1's peering and private IP exist first.

## Lanes (independent; different people can own them)

```
Lane A  data plane   1.1 roll ──────────────────► Roll 2 (2.1 flag + 2.3 + 4.1) ──► 4.4 recalibrate
Lane B  auth/DB      1.2 enable pruning ──(10 d)──► 1.3 reclaim      3.1 grace window (any time)
Lane C  network      2.1 peering + private IP ─────┐ (feeds Roll 2)   (2.2 DB split deferred)
Lane D  desktop      3.2 no same-token retry, 4.3 lease jitter (any release; wire-compatible)
Lane E  observability 1.5, 5.1, 5.2, 5.4 (Terraform only, any time)
Lane F  director     4.2 region preference (Cloud Run deploy, any time)
Misc                 1.4 full apps-root apply (any time; see its check)
```

Hard dependencies: Roll 2 waits on 2.1's network work; 1.3 waits on 1.2 finishing. Everything else is
independent. (2.2 deferred; if revived, do it after 2.1 so the new instance is private from day one.)

## Disruption summary

| Item | User-visible? | What they see | Mitigation |
|---|---|---|---|
| 1.1 / Roll 2 | **Yes, transient** | Per wave, desktops on that cell reconnect within seconds; phones follow on retry. | Waves gated by the monitor; run in the US night. Already rehearsed on c7. |
| 1.2 pruning | No | Background deletes, 5k rows per batch. | Small first budget; watch `stopReason` and Cloud SQL write throughput. Stop the scheduler if checkpoint alerts fire. |
| 1.3 reclaim | **Depends on tool** | `VACUUM FULL` takes an exclusive lock on `refresh_tokens`: sign-in and refresh block for its duration (minutes to tens of minutes on 16 GB). `pg_repack` holds only brief locks. | Use `pg_repack`. If VACUUM FULL, announce a maintenance window. |
| 1.4 full apps apply | Should be none, **verify** | Terraform will create a new auth revision (env added). Traffic is pinned to `00031-tox` by name, so the new revision should receive 0 %. | Confirm in the plan that no `traffic` change appears. If it does, stop: the Terraform image variable is not the serving image. |
| 1.5, 5.x alerts | No | | |
| 2.1 private IP | **Yes, certain** | Google: "Configuring an existing Cloud SQL instance to use private IP causes the instance to restart, resulting in downtime." No in-place path, HA does not avoid it. Expect 1–2 min DB unavailability: sign-in fails, relay renewals retry. **One-way door**: private IP cannot be disabled and the VPC link cannot be removed once set. The proxy flag change rides Roll 2. | Off-peak; only after Roll 1 (old image dies on a 2 min DB blip). Owner decision required before the foundation apply. |
| 2.2 DB split (deferred) | **Yes, scheduled** | Relay unavailable for the cutover (drain all cells → copy relay tables → flip `DATABASE_URL` → restart). Minutes if rehearsed. Desktops and phones reconnect automatically after. | Rehearse on staging; do it in the US night; announce. |
| 2.3 statement timeout | No beyond Roll 2 | | |
| 3.1 grace window | No | Auth deploys are no-traffic candidate → smoke → promote. | Security trade-off: a stolen token replayed inside the window is served once instead of revoking. 60 s is the usual choice. |
| 3.2, 4.3 desktop | No | Normal app update. | |
| 4.1 lock fix | No beyond Roll 2 | | Verify against real Postgres on 55440 with concurrent probes before shipping. |
| 4.2 region preference | **Minor, Asia users** | Phones that start being placed in Asia reconnect once to a nearer cell. | Roll out behind the existing region-preference flag. |
| 4.4 | No | | |

## Checklists

### 1.1 Cell image roll (Roll 1)
- [x] Confirm fleet is quiet: 15-min monitor dry-run passes. #19 green 23:07:53Z (run 33927238469). Canary then failed the evidence provenance check because main moved during the gate; re-gating with a same-commit chain.
- [x] Confirm director is on 519f4914 and c7 on 85bf6799 (confirmed 2026-09-04 via instance-template census; 20 serving cells still on `5aedbca5`) (`verify` mode of the same-cap workflow).
- [x] Dispatch `cloud-deploy-relay-production-same-cap` waves per the plan in the findings doc; one wave, verify, next. Done 2026-09-05 01:14Z–22:27Z: c8 canary, US batches c9–c10, c13–c16, c19–c26 at protocol 1, then Asia c27 (recovered via `mode=rollback` re-entry after gate freezes on the flat latency bar, fixed by #18877), c28, c29 as single-cell canaries at protocol 0.
- [x] After each wave: the transition verifier passed at migration-only and again at general on every cell (assignments carried, heartbeat fresh, hard cap 3 000); no `container die` fleet-wide across the whole roll. The 4408/1006 burst per wave was not measured separately; the verifier's assignment count before and after each restart is the recovery evidence recorded.
- [x] Record image census in the findings doc. 2026-09-05 22:27Z: all 19 general cells on `519f4914` except c7 on `85bf6799`; existing-only c1–c6, c11, c12 and migration-only c17, c18 untouched on their older images by design. Selector at gen 148.

### 1.2 Enable pruning
- [x] `auth_token_pruner_image` = digest of `orca-cloud-auth-00031-tox` (`343a0915…`; it contains the entrypoint). orca-cloud #479 merged.
- [x] `auth_token_pruner_enabled = true`, `auth_token_pruner_max_rows_per_run = 20000` for the first day (orca-cloud #479).
- [x] Targeted plan asserted 9 create / 0 change / 0 destroy. Applied 2026-09-05 02:06Z.
- [x] Trigger one run by hand; read the summary event. 02:18Z: `time-budget`, 73 batches, 365k scanned, 1 040 deleted (1 021 revoked, 19 expired), no errors. Scan-bound.
- [ ] Raise the budget to the default 200k after a clean day; watch Cloud SQL write MB/s and the checkpoint alert.
- [ ] 1.5: log metric + policy on `stopReason != complete`.

### 1.3 Reclaim
- [ ] Wait for steady-state runs deleting ~0 rows.
- [ ] `pg_repack -t refresh_tokens` off-peak (needs the extension; check `pg_available_extensions`). Not `VACUUM FULL` without a window.
- [ ] Confirm table + index size and `disk/utilization` dropped.

### 1.4 Full apps-root apply
- [ ] Run from CI or a host with the 1Password account (local plan fails on the Cloudflare data source).
- [ ] Plan shows exactly the four known drifts and **no traffic change** on `google_cloud_run_v2_service.auth`.
- [ ] Apply; confirm `status.traffic` still pins `00031-tox` at 100 %.

### 2.1 Private IP (PRs open: orca-cloud #477 foundation, stablyai/orca #18720 relay flag)
- [ ] **Owner decision**: the foundation apply restarts the instance and is irreversible on Google's side. Merging #477 arms the next foundation apply; hold the merge until the window is chosen.
- [ ] Director is out of scope: it uses the Cloud Run built-in connector (managed Google path, not the relay VPC NAT), so it consumed none of the exhausted ports; moving it needs Direct VPC egress + a separate DSN secret. Own PR if ever wanted.
- [ ] Step 7 (`ipv4_enabled=false`) is blocked until humans have IAP/bastion access and the director is moved; it breaks both today.
- [ ] Allocate a `/24` private services range on the relay VPC; `google_service_networking_connection`.
- [ ] Add `ip_configuration.private_network` to `google_sql_database_instance.auth` (foundation root). Plan must show update, not replace.
- [ ] Apply off-peak; expect a possible restart. Watch auth 5xx alert and relay `sqlFailures`.
- [ ] Cell template: proxy args add `--private-ip` (code merged #18720; flag not set). Director: Direct VPC egress or connector, then the same flag. Both ride Roll 2.
- [ ] After Roll 2: NAT `port_usage` for relay gateways drops to ~0; then consider `ipv4_enabled = false` (removes the public IP; breaks the local `cloud-sql-proxy --token` workflow unless it also goes private).

### 2.2 Database split (deferred to ~2026-11-01; checklist kept for when it is revived)
- [ ] New `google_sql_database_instance.relay` (private IP from day one, its own size and flags). Staging first.
- [ ] Relay schema applies cleanly to an empty instance (it does at startup).
- [ ] Rehearsal on staging: drain → `pg_dump` relay tables → restore → flip `relay_database_url` secret → restart director + cells → phones/desktops reconnect. Time it.
- [ ] Production: announce a window; same steps; verify `orca_relay_runtime_metrics` controls recover to pre-cutover count.
- [ ] Update `production-cloud-sql-app-consumers` budget test and both alert policies' `database_id`.

### 2.3 Relay pool statement timeout (deployed in Roll 2, 2026-09-06)
- [x] `statement_timeout` on the relay `pg.Pool` (5 s, env-configurable; schema pool untimed; `57014` retryable), below the control-renewal deadline; DDL on an untimed connection (same pattern as auth #476).
- [x] Postgres test on 55440: a held lock fails the query fast and the bounded retry takes over.
- [x] Deployed fleet-wide in Roll 2 (`4916ed67`), 2026-09-06.

### 3.1 Refresh rotation grace window (orca-cloud #478 merged 2026-09-04; deploy pending owner go)
- [ ] Fix the deploy-script env strip for `ORCA_CLOUD_REFRESH_TOKEN_TTL_DAYS` (pre-existing; found by #478).
- [x] `rotateRefreshToken`: if `rotated_at` within 60 s and not revoked, return the existing successor (idempotent), no revoke, no audit.
- [x] Outside the window or a third presentation: unchanged (revoke + audit).
- [x] Tests: replay inside window returns same successor; outside revokes; concurrent double-present yields one successor.
- [x] Deploy via `deploy-auth-production` (candidate → smoke → promote). Deployed 2026-09-04 23:15Z as `orca-cloud-auth-00035-gos`, cap 20 kept, 0 5xx; `successor_material` column present; sealed successors being written. (candidate → smoke → promote).

### 3.2 / 4.3 Desktop (merged stablyai/orca #18719; ships next desktop release; relay side of 4.3 deployed in Roll 2)
- [x] 3.2: on refresh timeout, re-read stored session before retrying; do not re-send a token already rotated locally.
- [x] 4.3: ±10 % jitter on control lease renewal; unit test on the distribution; wire-compatible (server accepts early renewals already).
- [x] 4.3 relay side: control lease 55 min → 6 h ± 30 min (#18959), deployed in Roll 2, 2026-09-06.

### 4.1 Lock contention (partial: stablyai/orca #18722 deployed in Roll 2, 2026-09-06)
- [x] Replace the global `FOR UPDATE` over `relay_cells` with per-cell row locks; counters delta-only. Remaining: `assignOnce` placement lock is still global (optimistic snapshot follow-up). with per-cell row locks or `pg_advisory_xact_lock(cell)`; counters delta-only.
- [x] Postgres tests on 55440 with concurrent probes (in #18722). Staging load run still owed; `postgres_retries` per hour drops in staging load run.
- [x] Shipped in Roll 2 (2026-09-06). Director retries first 6 h on the new image: 13 vs 85 on the predecessor's prior 6 h.
- [ ] 4.4: recalibrate the retries bar from a week of data (after 2026-09-13).

### 4.2 Region preference
- [ ] Director: honor requested region when the preferred region has headroom, else sticky. Behind the existing flag.
- [ ] Measure with `orca_relay_runtime_metrics` region counters before/after.

### 5.x Observability
- [x] **Relay-root runtime-metric drift**: resolved by dropping the `region` label to match live state (stablyai/orca #18734). Applied 2026-09-04 23:11Z: 8 never-applied `control_*` renewal metrics + the incident dashboard created, 0 destroyed, 21 live metrics untouched.
- [x] 5.1 `container die` log metric per cell (`relay_cell_process_exit`, applied 2026-09-04 via #18717), > 3 / 15 min, relay channel.
- [ ] 5.2 Add a paging channel (**needs owner input**: destination) to `auth_alert_notification_channels` for refresh rejections + latency.
- [x] 5.4 One dashboard (applied 2026-09-04 23:11Z): `orca_relay_cloud_sql_wal_checkpoint`, NAT drops, `orca_auth_refresh_401`, summed `controls`.
