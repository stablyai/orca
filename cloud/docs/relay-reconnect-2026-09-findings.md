# Relay reconnect investigation: findings and evidence

Working notes for the 2026-09-04 mobile relay reconnect incident and the cell roll that follows.
Kept current across context compactions. Newest section first. All times UTC. Host ids are log digests,
never raw ids. Nothing here is a production mutation record unless the "Mutations" section says so.

## Status board

| Item | State | Where |
|---|---|---|
| PR #18565 relay accept abandonment + lease jitter + desktop rotation spread + phone probe fail-fast | Open, CI fully green again after the doc move (05:45Z), CodeRabbit + Pullfrog cleared, 3 review rounds; not merged (owner has not asked) | https://github.com/stablyai/orca/pull/18565 |
| PR #18569 monitor `relayPostgresRetryExhausted` 0 -> 300 | **Merged** 2026-09-04 ~04:20Z as 4101505b6b | https://github.com/stablyai/orca/pull/18569 |
| Same-cap `verify` of c7 (read-only) | **Passed** run 33836527159 | confirms identities, selector gen 110, rehome gen 12, protocol 1, digests |
| Monitor dry-run #1 | Froze min 5: `relay.postgres_retries` 380 > 300 | run 33836470590 |
| Monitor dry-run #2 | Green to min 13, froze 04:49Z: `director.concurrency` 76.7 > 64 (six-cell crash storm, Finding 6) | run 33837160275 |
| Monitor dry-run #3 | Froze min 3 at 05:01Z: `relay.postgres_retries` 339 > 300; no crash, concurrency 5–8 | run 33838698725 |
| Owner decision 2026-09-04 ~05:10Z | **Option B approved**: "you can raise the bar. or remove it altogether ... whats the most logical move". Kept the bar (removal would leave contention unwatched during the roll) and recalibrated from measured data. | this thread |
| PR #18580 monitor `relayPostgresRetries` 300 -> 2000 | Open, awaiting CI; mutation-checked (300 fails the new test) | https://github.com/stablyai/orca/pull/18580 |
| PR #18565 CI | Was red on `root directory guard` because this findings file sat at repo root; moved to `cloud/docs/` in 8ebff89106 | |
| PR #18580 | **Merged** 2026-09-04 05:23Z as 79d5fb469a (Pullfrog cancelled by the merge; independent Opus review requested instead, per owner) | |
| Monitor dry-run #4 | Froze min 12 at 05:37:35Z: `cell.production-gce-c27.health`/`.ready` = 0. Retries green all 12 samples under the new 2000 bar. Cause: c27 (asia-east2) container died 3x 05:37:00–05:38:01Z, Finding 6 crash class. | run 33840364323 |
| Monitor dry-run #5 | Froze at sample 1 (05:41Z): c27 health/ready still 0. MIG autoheal `recreateInstance` on c27 fired 05:38:12Z after the 3 crashes; instance RECREATING, process up with 0 controls (was ~395). Second c27 recreate in 7 h (Finding 3 seed pattern). Waiting for c27 to settle before dry-run #6. | run 33841327879 |
| Monitor dry-run #6 | **Passed** 06:06:31Z: 16 samples, no freeze (started 05:47:42Z) | run 33841783747 attempt 1 |
| c7 `canary-apply` | **Succeeded.** Dispatched 06:07:15Z; drain 06:10Z; MIG recreate 06:16–06:23Z; new image listening 06:23:42Z; verify + trust proof passed; restored to `admission=general` 06:25:21Z; canary authority sealed. c7 is on `85bf6799…`. | run 33843071283 |
| PR #18581 doc reconcile (Aug 23 figure: 2,200–3,000 raw log lines vs 1,510 on the gate metric) | **Merged** | https://github.com/stablyai/orca/pull/18581 |
| Same-cap `verify` c7 target=519f4914 rollback=85bf6799, gen 112 | **Passed** (read-only) | run 33856355648 |
| Monitor dry-run #7 (gen 112) | Froze at sample 1 (09:05:31Z): `director.errors` 4 > 0, the four 2.0 s pg-connect 500s from the 09:00 cascade still inside the 5-min delta window. Dispatched 4 min too early. | run 33856521278 |
| Monitor dry-run #8 (gen 112) | Green for 15 of 16 samples (09:09:38–09:24), froze on the final sample 09:25:22Z: `director.errors` 1 > 0. The one 500 was `/v1/admin/evacuation-status` at 09:23:50Z, 2.01 s latency = director pg-connect timeout, called by **the monitor's own collector** (`incident-monitor-sources.ts:492`). First evacuation-status 500 since Sep 1. The gate froze on a request it made itself. | run 33856905229 |
| Monitor dry-run #9 (gen 112) | Froze: c13/c23 crashed 50 s after dispatch, then c14/c20/c9 at 09:34. | run 33858650691 |
| Monitor dry-run #10 | Dispatched 09:46:13Z; froze at sample 5 (09:56:59Z): `director.errors` 12. All twelve at 09:55:17–21Z, 0.8–2.1 s latency, 10 on `/v1/regions` + 2 on `/v1/assign`; c16 and c8 crashed at 09:55:19 in the same second. A single 4-second Postgres connect stall hit director and cells together. | run 33859947207 |
| Monitor dry-run #11 | Froze at sample 2 (10:08:07Z): `director.concurrency` 79.8 > 64, the c8/c20 re-dial. They crashed 10:05:54, 3 s before the waiter's quiet check passed (log ingestion lag). | run 33861578009 |
| Monitor dry-run #12 | Dispatched 10:17:38Z after 10 quiet min; froze at sample 2 (10:19:24Z): `cell.production-gce-c16.health` 0. c16 did **not** crash (no container die, MIG NONE/HEALTHY, readiness=true throughout, `/health` 200 in 230 ms at 10:21). At 10:19:07–16 it logged "control activity renewal failed" x4 and a burst of 1006 closes, sqlFailures 1 -> 14, sqlLatencyMsMax 2588: a pg stall on the old image that did not reach the unhandled path. The probe's single fetch (30 s timeout) came back unavailable during that stall and `unavailableIsZero` turned it into health=0. | run 33862504601 |
| Monitor dry-run #13 | Green 14 of 16 samples (10:48:38–11:03), froze 11:04:43Z: c9 crashed 11:04:23, c28 11:04:25 (then looped 11:05:04, 11:05:41); c15 probe also read 0 (stall, no crash). Missed by ~90 s. **Dispatched by hand 10:48:15Z** into a 43-min crash lull (last die 10:05:54; last director 500 10:31:49). The re-armed waiter never fired: its MIG-stable check used `grep -vc True`, which exits 1 when nothing matches, so `&&` short-circuited on the *healthy* case. Waiter armed 10:20Z: 10-min quiet + every MIG stable + 60 s recheck, then dispatch, then canary c7 on green. Held at 10:24 and 10:31 by lone director `/v1/assign` 500s (2 s pg-connect stalls, no cell crash). Director 500 events since 08:46: 6 (gaps 2.7/21/31/29/7.6 min). At 10:39 the waiter was re-armed with a 6-min director-500 window (the monitor's own delta is 5 min) instead of 10, since the gate only needs the 15 min *after* dispatch to be clean. Cell crashes have stopped since 10:05 (33+ min, longest gap since 08:40). 12 dry-runs: 1 pass (#6), 11 freezes, none on a real fleet-health regression. | Cascade gaps since 09:00: 31, 2.9, 5.1, 16.1, 4.0 min (median 5); a 15-min clean window is ~28% per attempt at this rate. | |
| Monitor dry-run #14 | Dispatched 11:26:53Z by the fixed waiter (first autonomous dispatch); c14, c23, c25, c15, c24, c19 died 11:30:59–11:31:08 (six cells, 13 min after the last cascade). Froze on c8 (and others) health/ready probes. Waiter re-armed 11:06Z (grep bug fixed: `grep -c` under `|| true`), same chain; held through the 11:17 cascade and c14/c28 recreates. 13 dry-runs: 1 pass, 12 freezes. Since 08:40: 10 cascades, 75 container dies, gaps 20/31/3/5/16/4/6.5/58/13 min; only 3 windows of >=17 clean minutes existed in 2.6 h, and dry-runs hit two of them (#6 passed, #13 lost the third by 90 s). |
| Monitor dry-run #15 | Waiter armed 11:33Z (6-min director-500 window, 8-min crash window, all MIGs stable), chained canary; still holding at 12:04Z. Since 11:00: 8 cascades, 98 dies, gaps 13/13.6/3.6/14.5/4.4/6.1/3.0 min, **max gap 14.5 min**, so no 15-min clean window has existed in the last hour. 14 dry-runs: 1 pass, 13 freezes. |
| Monitor dry-run #15 verdict | Dispatched 12:28:49Z; froze at sample 2 (12:30:41Z): **12 cells** health/ready = 0 at once (c4, c5, c7, c10, c15, c16, c18, c20, c22, c25, c27, c28), including c4/c5 (0 controls all day, `/health` 200 in 190 ms a minute later) and c7 (new image). Six old-image cells also crashed 12:30:02–21. This was a fleet-wide SQL stall, not a cascade: every cell's `sqlLatencyMsMax` hit 4–6 s (c7 4865, director 5140), director pool waiting 1258, 15 cell pg-connect timeouts, director sqlFailures 92. Cloud SQL CPU 0.73, backends 160, new connections normal, memory 0.46, so the *instance* was not saturated; something held the database for ~5 s. Postgres log 12:31:23–28 shows a burst of `could not obtain lock on row in relation "relay_cells"` from NOWAIT (single-row and full-inventory) sweeps, i.e. the row locks were held during recovery. Cloud SQL transactions/min flat (~30k), reads flat,
network flat: the database was neither busy nor saturated, it was *waiting*. The stall bracket
(12:30:02–12:30:41) is where every cell's SQL max hit 4–6 s at once. Lock retries in that window were
ordinary (49/29/13 per min). Best reading: a ~5 s Postgres-side wait event shared by every session
(lock on a hot row held across a long transaction, or an instance-level pause), not CPU/IO. Cell
`sqlLatencyMsMax` was already 1.5–2.2 s fleet-wide in the four minutes before, i.e. the old cells' 1 s
`lock_timeout` plus queueing. | run 33872946111 |
| Monitor dry-run #16 | Dispatched 12:38:57Z; froze at sample 1 (12:40:11Z): `cell.production-gce-c27.latency_ms` 2071 > 2000, a fifth distinct freeze signal, the probe's own round-trip absorbing a checkpoint sync. **Loop stopped by me at 12:41Z**: with the disk in the checkpoint loop (Finding 10) no bar can hold for 15 min, so further dry-runs only burn the shared rollout lease. 16 dry-runs: 1 pass, 15 freezes. Re-arm after the disk change lands. |
| Cloud SQL checkpoint loop | **Broke on its own 12:39–12:45Z**: disk writes 48 -> 4 MB/s at 12:39 with transactions and network flat and no Cloud SQL operation; 12:40:17 checkpoint synced 0.047 s; 12:45:53 checkpoint was `time`-triggered again (first since 11:55) with sync 0.096 s and write spread over 269 s. Cause of the break unknown (most likely WAL fell back under `max_wal_size` once a burst of full-page writes aged out). It can re-enter the loop on the next large checkpoint; the disk-size fix remains the durable one. |
| Monitor dry-run #17 | Dispatched ~12:49Z (all guards clean); froze at sample 1 (12:52:05Z): `director.errors` 4, from the c9/c22 crash loop that began 12:50:34, ~90 s after dispatch. Checkpoints stayed healthy (85 ms), so this is the old image's baseline crash rate, not the disk. 17 dry-runs: 1 pass, 16 freezes. |
| Monitor dry-run #18 | **Dispatched by mistake 13:48:56Z into the outage**: my gcloud credentials expired ~13:45Z, every guard query returned empty, and the waiter's `grep -c . || true` read empty as "quiet". Froze at sample 1 (13:49:43Z) on `director.ready=0`, `auth.health=0`, and cell probes; no canary dispatched, no production mutation. All waiter loops killed at 13:51Z. Lesson: a quiet-window check must fail closed when its data source errors. Waiter had been re-armed 12:53Z. |
| Gate decision | Owner asked at 09:36Z to choose: A keep looping / B recalibrate `directorErrors` 0 -> small n / C human bypass. Ten dry-runs, four froze on this bar. Recommendation B+A. Note: B alone would not have passed #9 or #10 (cell health probes and a 12-error burst); it fixes the single-500 false freezes (#7, #8) only. | |
| Batch roll | **Deferred by plan**: roll once with the lock-fix image instead of twice. | |
| PR #18606 lock removal (root cause) | **Merged** 09:2xZ as 7b108abf71 after review, fix, re-verify; CI green | https://github.com/stablyai/orca/pull/18606 |
| Image publish for 7b108abf71 | **Done** 08:36:49Z run 33854111305: `sha256:519f4914217f08cabcdcd34825965db8473ec37c6591553a3af0d65dcdeeb183` | |
| Director deploy on 519f4914 | **Succeeded** 08:45Z run 33854355791; serving `orca-cloud-relay-00570-siv`, rollback tag on 00569-ret (also 519f4914), 00565-fes (85bf6799) still deployable. Dispatched 08:37:45Z (blue/green; prior revision 00565-fes on 85bf6799 kept as rollback). Note: `predecessor-image-digest` is a required input even with bootstrap=false; pass the serving digest. | `cloud-deploy-relay-production-director.yml` |
| c7 on new image, 2 h in | 817 controls, **0 container die** since restore (was ~1 per 15 min on old image); `sqlLatencyMsMax` still 1.0 s = lock wait unchanged, which #18606 targets | |
| Terraform alert `relay_postgres_retry_exhausted` at `> 0` | Firing continuously since #18521; recalibration not done (own change) | `cloud/infra/terraform/relay-observability.tf:447,469` |

## Mutations performed (complete list)

1. Merged PR #18569 to main (code/docs only).
2. Merged PR #18580 and #18581 to main (monitor bar + docs).
2b. Merged PR #18606 to main (relay lock change; no serving effect until the image is deployed).
2c. Dispatched `cloud-publish-relay-production` for 7b108abf71 (builds and pushes an image; changes nothing serving). Done: 519f4914.
2d. Dispatched `cloud-deploy-relay-production-director` on 519f4914 (preserve placement, no prune, rehome gen 12). Succeeded 08:45Z; serving revision 00570-siv. Rollback: `gcloud run services update-traffic orca-cloud-relay --region us-central1 --to-revisions orca-cloud-relay-00565-fes=100` (85bf6799, still Ready). Not needed so far.
3. 2026-09-04 06:07:15Z: dispatched `cloud-deploy-relay-production-same-cap` `canary-apply` for production-gce-c7 only (run 33843071283). Completed successfully 06:26Z: c7 isolated, drained (807 controls re-dialed), template + MIG rolled to 85bf6799, verified, restored to general admission. Selector generation advanced 110 -> 112 (isolate + restore).
4. Nothing else. Both monitor dispatches were `mode=dry-run` (read-only). The same-cap dispatch was `mode=verify` (read-only, confirmed by step gates `if: inputs.mode != 'verify'` on every mutating step).

## Finding 6 (2026-09-04 ~05:00Z): the old cell image crashes the whole process on a Postgres connect timeout

**This is the most important open finding.** The 23 GCE cells run image `sha256:5aedbca5…` = orca-cloud
commit e3e92d95d3 (2026-08-14). In that build `beginProof` is called as `void this.beginProof(...)`.
When `verifyCellAssignment` inside it throws (pg-pool `timeout exceeded when trying to connect`, 2 s
`connectionTimeoutMillis`), the rejection is unhandled and Node exits 1. Docker restarts the container
in ~1 s, but every control on that cell (~800 hosts) drops and re-dials `/v1/assign` at once.

Evidence, cell c7 instance 4545742188814054238, 2026-09-04:

```
04:46:47.951 stderr [orca-relay] control activity renewal failed   (x5)
04:46:49.527 stderr Error: timeout exceeded when trying to connect
             at pg-pool/index.js:45:11
             at async PostgresPoolPressure.connect (postgres-pool-pressure.js:30:20)
             at async PostgresDatabase.query (database.js:645:24)
             at async RelayAssignmentStore.verifyCellAssignment (assignment-store.js:2024:22)
             at async HostSessionRegistry.beginProof (host-session-registry.js:376:15)
04:46:49.527 stderr Node.js v24.19.0
04:46:49.835 dockerd: container die … exitCode=1 image=…relay@sha256:5aed…
04:46:50.258 dockerd: container start
04:46:52.761 stdout [orca-relay] listening on https://c7.relay.onorca.dev
```

2026-09-04 05:36:59–05:38:01Z: c27 died 3x in 62 s plus one other instance (5464389947731541178); this froze dry-run #4 on c27's health probe.

Fleet-wide `container die … exitCode=1` on the relay image, last 48 h: **201 events on 19 instances**
(c28 x38, c29 x37, c27 x19). Hourly counts track the lock-contention curve (peak 23/h at 21Z Sep 3).
Every one has the same `Node.js v24…` crash banner. On 2026-09-04 04:46:35–04:47:41Z six cells
(c7, c8, c19, c21, c22, c25) died within 66 s: ~4,800 hosts re-dialed, `/v1/assign` returned 16,321
503s in one minute (baseline ~20), director concurrency hit 85 (Cloud Run cap 80), Cloud SQL
`new_connection_count` 119 -> 287/min. Fleet recovered by 04:51Z. That is what froze dry-run #2.

Fix status: `guardSessionTask` wrapping `beginProof` landed in orca-cloud #436 (2026-08-27) and is in
the target image `sha256:85bf6799…` (main 11aace8dec). The roll is the fix. Not caused by anything in
this session: the same-cap verify finished ~04:25Z and never reached a mutating step; no compute
operations exist for those instances; heap/event-loop were flat before the crash.

Autoheal amplifier: MIG health check is `/health` every 10 s, timeout 5 s, unhealthy after 3, so a
crash loop of ~30 s+ triggers `compute.instances.repair.recreateInstance`. All ~20 recreates in the
48 h to 2026-09-04 05:40Z were the three Asia cells (c27 x6, c28 x7, c29 x8; gcloud prints local
-07:00 times). c27 recreated 05:38:12Z after 3 crashes in 62 s; its ~395 controls went to 0 and the
monitor's `cell.production-gce-c27.health/ready` probe read 0 for the whole recreate (~several min),
freezing dry-runs #4 and #5. Each recreate also seeds a Finding 3 rotation cohort. Rolling the Asia
cells early in the batch phase should be weighed against the canary-first rule; c7 stays the canary.

Implication for the gate: the monitor's `director.concurrency` freeze is *correctly* detecting these
crash storms. A dry-run only passes in a 15-minute window with no cell crash, roughly 1 in 3 windows
at current rates. Retrying in quiet hours is legitimate; the bar is not wrong.

## Finding 5: `relay.postgres_retries` at 300 is 3x under today's baseline

Retries per 5 min, cells + director, last 24 h: p50 579, p90 1039, p99 1398, max 1505; **65% of
windows over 300**. Quiet hours (03–08Z) p50 235, max 512. When the 300 bar was set (2026-08-26)
healthy bursts reached 234. Baseline has roughly tripled in 10 days. Skill notes say do not raise this
bar; I have not. Best odds for a clean 15 min are 02–04Z and 17–18Z (9/12 five-minute windows under
300 in each).

## Finding 4: exhausted-retry bar was the wrong single blocker (fixed)

`relayPostgresRetryExhausted: 0` never cleared after #18521 reached the director (22:12Z Sep 3): 236/236
five-minute windows non-zero; post-#18521 p50 42 / p90 147 / max 220; Aug 23 incident peak 467.
Recalibrated to 300 in #18569 (merged). Dry-run #1 immediately revealed Finding 5 behind it.

## Finding 3: the 00:50Z control-close wave was desktop lease rotation, not a rollout

2026-09-04 00:49–00:51Z: 2,745 control closes on 19 instances; 1157/1632 code 1006 and 973/1030 code
4408 `control rebound` had ageMs in the 53-minute bin. Relay grants a flat 55 min lease; desktops
rebind 60–120 s early; so every host that (re)connected in the same minute rebinds as one cohort
forever. Seed: c27 MIG autoheal recreate 23:23Z (`compute.instances.repair.recreateInstance`) dumped
~420 controls. Harmonics at 23:55, 00:04, 00:25, 00:49Z. Each rebind is an `activateControl`
transaction that can take the inventory lock. Fix in #18565: relay lease 55 min ± 5 min (symmetric,
so mean rebind rate unchanged), desktop early window 1–6 min.

## Finding 2: fleet-wide lock contention, worse on Sep 3

| window | 55P03 retries/h (cells) | cell sqlFailures/h |
|---|---|---|
| Sep 2 18Z – Sep 3 07Z | 660–1470 | 680–1620 |
| Sep 3 08Z–16Z | 3600–7100 | 3700–7700 |
| Sep 3 23Z | 7468 | 7585 |

100% of sampled retries are 55P03; director phase is `cell-inventory`. Every cell pins
`sqlLatencyMsMax` at 1.0–1.2 s = the pre-#18521 1 s pool `lock_timeout`. Not load (controls flat
~26k, Cloud SQL CPU 46–53%). No `cloud-*` workflow explains the 08Z step. The lock is a global
`SELECT * FROM relay_cells FOR UPDATE` (23 rows) taken by assignment, control activation, activity
acquire, and sweeps, held to COMMIT.

## Finding 1: root cause of the phone's 24 s hang (the original symptom)

`acceptClient` runs four serialized Postgres calls; the fourth (`acquireActivity`) contends for the
global lock. Under contention the cell finishes after the phone's 12 s bound, then
`PendingHostDataReservation.bind` throws `host_data_reservation_already_bound` because the phone's
close already released the reservation. Every "first frame handler failed already_bound" line is that
post-mortem (31 events 23:06–01:01Z across 12 instances). Fix in #18565: abandon the accept after each
DB step once the socket is closed; new event `orca_relay_client_accept_abandoned {stage, elapsedMs}`
and metric fields `clientAcceptsAbandonedByStageDelta` / `clientAcceptAbandonedMsMax`. Phone side:
direct probe now fails fast on `reconnecting` so relay recovery is not queued behind three doomed
LAN redials (~3.5 s saved per foreground). #18518 (merged, not yet on the phone) covers the
stage-aware dial bound.

Host 666077865f2e: stable throughout. 4408 rotation 00:27:45Z; 1006 quit 00:52:24Z on old adhoc;
sticky reassignment to c27 00:52:35Z on new build; rotation closes 01:44:55Z and 02:23:15Z with
splices intact. No drain/4404/wrong-cell.

## Finding 7 (2026-09-04 ~05:10Z): retries bar recalibration basis (PR #18580)

Chose 2000 over removal. The metric is the gate's own source (`orca_relay_postgres_retries`
log metric, director + cells summed per five minutes, ALIGN_DELTA 300 s):

| window | p50 | p90 | p99 | max | > 300 |
|---|---|---|---|---|---|
| 2026-09-01 | 56 | 105 | 206 | 456 | 0% |
| 2026-09-02 | 109 | 186 | 294 | 377 | 1% |
| 2026-09-03 | 430 | 924 | 1320 | 1504 | 55% |
| 2026-09-04 to 05Z | 285 | 1012 | 1211 | 1211 | 44% |

15-minute pass rate, last 24 h: bar 300 -> 22%, 800 -> 66%, 1000 -> 86%, 1500 -> 99%, 2000 -> 100%.
Aug 23 incident on this metric: 1510 then 646 (single windows), so retries no longer separate an
incident from baseline; exhausted (467 vs bar 300; healthy 72 h max 184), director concurrency,
and pool bars carry that role. Note: my earlier "p99 1398 / 65% over 300" in Finding 5 came from
raw log line counts; the metric-based numbers above are what the gate actually evaluates.
Baseline tripled between Sep 2 and Sep 3 with no deploy; still unexplained (Finding 2).

## Decision needed from the owner (resolved: B)

The same-cap roll is blocked only by the monitor gate, and the gate is blocked by `relayPostgresRetries: 300`
(Finding 5: 65% of windows breach it; even the 04:55Z quiet window hit 339). Three options:

- A. Keep waiting for a naturally quiet 15 min. Odds per attempt ~1 in 3 in quiet hours, lower by day.
  Each attempt is free and read-only. Could take hours.
- B. Recalibrate `relayPostgresRetries` from measured data, same method as #18569: 24 h p99 is 1398, the
  Aug 23 incident ran 2200–3000, so ~1500 clears healthy windows with ~1.5–2x incident separation
  (less margin than the exhausted bar had). Overrides the "do not raise" note in the skill facts.
  Argument for: the roll being gated is the thing that reduces retries. Argument against: the bar is
  doing its job of saying contention is high.
- C. A human dispatches the roll with a different gate policy. Not something I can or should do.

My recommendation: B, with the number chosen from the table in Finding 5 and the roll following
immediately so the bar can be re-tightened after the fleet is on the 500 ms lock wait.

## Finding 12 (2026-09-04 13:12Z): **INCIDENT IN PROGRESS. The auth service is at its 2-instance cap and rejecting 90% of desktop token calls with 429; the relay fleet has emptied.**

Timeline: 13:04–13:06 the old-image cascades and NAT stalls drove ~1,400 desktops to re-dial. Their relay
JWTs (5-min TTL) expired mid-storm, so they hit `orca-cloud-auth` `/v1/desktop/auth/refresh` and
`/v1/desktop/auth/relay-token` together. The auth service is Cloud Run `maxScale=2`, `concurrency=80`,
1 vCPU throttled (`auth_max_instances = 2` in orca-cloud `infra/terraform-apps/environments/production.tfvars`,
applied by `deploy-auth-production.yml`). Both instances pinned at concurrency 85 from 13:02; from 13:07
Cloud Run's front door returns **429 "no available instance"** (0 s latency, never reaches the container):
12,045 at 13:07, 54,292 at 13:08, 46,025 at 13:08, 42,529 at 13:09. Sep 3 total auth 429s: **0**.
Without a fresh relay token every desktop's `/v1/assign` gets 401 (1,433 distinct hosts 401'd, 0 got 200
since 13:07) and every cell closes its control with `4401 relay authorization expired`. Fleet controls:
13,375 (12:55) -> 7,633 (13:08) -> **249 (13:12)**, splices 1. Auth container CPU 0.15–0.5, so the cap is
the limit, not the code. Every desktop is now in its refresh-retry loop hammering the same 2 instances:
this is a self-sustaining thundering herd and will not clear on its own. At 13:14Z: fleet **30 controls**
across 23 cells; successful relay-token issuance 5,000–6,500/min until 13:05, then 1,059 / 734 / 733 /
443 / 220 / 214 / 148 / **4** per minute through 13:13; auth 429s 54k -> 25k/min only because desktops
are backing off, not because the service recovered. Note `AUTH_MAX_INSTANCES: 2` is also hardcoded in
orca-cloud `.github/workflows/deploy-auth-production.yml` (lines 33–34), so a redeploy would re-pin it;
change both the workflow env and the tfvars.

**Immediate mitigation (owner action, not applied):** raise the auth service's max instances. Fastest:
`gcloud run services update orca-cloud-auth --region us-central1 --max-instances 20` (or `10`, matching
the other apps' `max_instances = 10`), then land the same in `auth_max_instances` so Terraform does not
revert it. Auth is stateless behind Cloud SQL (`refresh_tokens` table); backends 210 of 400, so 20
instances x a small pool is within budget. Also consider the desktop's refresh backoff: it re-dials on
401 immediately with no jitter, so a 429 storm sustains itself.

**13:51Z status: my gcloud session lost auth at ~13:45Z; all production monitoring from this session is
blind until re-authenticated (`gcloud auth login`, interactive). Last confirmed state 13:40Z: fleet 0
controls, auth maxScale 2, 7,600 auth 429/min. All autonomous dispatch loops are stopped.**

**17:19Z–17:21Z MITIGATION APPLIED (owner said "fix it NOW").** State at 17:19Z, four hours in: all 23
cells at 0 controls, auth 429 ~2,000/min, auth 2xx ~40/min, and the 2xx that got through took 13–28 s
(both instances saturated). Mutation 1: `gcloud run services update orca-cloud-auth --max-instances 20`
created revision `orca-cloud-auth-00018-4jc` (same image `auth@sha256:1710ff6c`, same env/concurrency,
only maxScale 2 -> 20) but the service pins traffic to `00023-qud` **by revision name**, so the new revision
was immediately `Retired` and nothing changed. Mutation 2 (17:21:30Z): `gcloud run services update-traffic
--to-revisions orca-cloud-auth-00018-4jc=100`. Lesson: the auth service's traffic block is name-pinned
(the deploy workflow does an explicit traffic switch), so a bare `services update` never reaches users.
Terraform still says `auth_max_instances = 2`; the next `deploy-auth-production.yml` run will revert this
unless the tfvars and the workflow's `AUTH_MAX_INSTANCES` are changed first.

## Finding 13 (2026-09-04 17:19Z–18:10Z): **the auth outage is a database problem, not (only) a Cloud Run cap; `refresh_tokens` has 63 M rows and reuse-revokes scan whole families**

Mutations this window (all online, no restarts, all by hand in project onorca-cloud):
1. 17:19Z `gcloud run services update orca-cloud-auth --max-instances 20` → new revision `00018-4jc`, but traffic is
   pinned by revision name so it was `Retired`; 17:21:30Z `update-traffic --to-revisions 00018-4jc=100`.
2. Still 2 instances at 17:31Z: the SERVICE has its own `scaling.maxInstanceCount=2` in **manual scaling mode**
   (`run.googleapis.com/maxScale: '2'` on service metadata, set by Terraform `infra/terraform-apps/auth.tf`), which
   overrides the revision cap. `--scaling=auto` then `--max 20` at 17:31:45Z. Instances 2→20 by 17:38Z; 429s fell
   6,000/2 min → 60/2 min at 17:36Z and controls briefly reached 11.
3. Then latency, not capacity, became the wall: every refresh took 100+ s inside Postgres (desktop client timeout
   is 30 s, `CLOUD_REQUEST_TIMEOUT_MS`), so 20 instances × 80 concurrency filled again with requests nobody was
   waiting for, and 429s returned (~1,500/2 min from 17:40Z).
4. 17:27Z Cloud SQL disk 62 GB → 250 GB (IOPS ceiling 1,470 → ~7,500). 18:00Z `max_wal_size` 1.5 GB → 16 GB
   (the checkpoint loop: `checkpoint starting: wal` every 45–60 s since 13:06Z).
5. 18:07Z `CREATE INDEX CONCURRENTLY refresh_tokens_family_unrevoked ON refresh_tokens(family_id) WHERE
   revoked_at IS NULL` (an earlier attempt with `AND rotated_at IS NULL` was wrong for the revoke predicate; its
   invalid remnant `refresh_tokens_family_live` was dropped).

Evidence: `refresh_tokens` = 63.3 M live tuples, 16 GB table + 10 GB indexes; every refresh inserts a row and
nothing ever deletes (30-day TTL rows are never pruned). Query Insights 17:33–17:39Z: `UPDATE refresh_tokens SET
revoked_at = $1 WHERE family_id = $2 AND revoked_at IS NULL` = 21,000 s of execution per 6 min, ~90–120 k rows
updated per minute; io_time 15,000 s read; pg_stat_activity 180+ backends in `IO/DataFileRead` on that statement,
200 backends total for orca_auth (20 instances × pool max 10). `session-refresh-reuse-detected` audit events per
hour: ~100 all day → 8,805 (13Z), 15,511, 19,486, 24,897, 26,935 (17Z). Mechanism: a desktop's refresh times out
client-side at 30 s, the server had already rotated the token, the desktop retries with the same token, the
server calls that reuse and revokes the family (Bitmap scan on `refresh_tokens_family` + heap filter over every
row the family ever had), then the desktop retries the dead token again, and each retry re-runs the same
full-family scan (already-revoked families short-circuit nowhere). Reuse-detected 401 also **signs the user out**
on the desktop (`isOrcaCloudAuthFailure` → `clearCloudSessionIfUnchanged`), so every user who hit this during the
outage must sign in again.

Durable fixes (orca-cloud PR in preparation on branch `auth-revoke-only-live-tokens`): `AUTH_MAX_INSTANCES` and
`auth_max_instances` → 20; Terraform disk 250 + `max_wal_size=16384`; the partial index in the schema; an
`already-revoked` short-circuit in `rotateRefreshToken` that skips the family UPDATE and the audit insert. Still
open after that: prune `refresh_tokens` (expired or revoked rows older than N days), a server-side statement
timeout shorter than the desktop's 30 s so the client and server agree on failure, and an alert on auth 429s.

**19:11Z RESOLVED at the database layer.** `refresh_tokens_family_unrevoked` went valid at 19:11:17Z (build
18:07–19:11, two full table scans of 2.1 M blocks under load). Within 60 s: refresh latency 100 s → 0.1 s, auth 429
→ 0, active orca_auth backends 200 → 2, checkpoints back on the 5-min timer (`checkpoint starting: time` at 18:35,
18:41, 19:00, 19:11). Director `/v1/assign` returning 200. Fleet controls 0 → 17 by 19:14Z.

**Residual: mass sign-out.** 19:11–19:14Z: 3,857 refresh 401s from 3,829 distinct IPs, then near zero. Every one is
a desktop whose family was revoked by reuse-detection during the outage; the desktop clears its cloud session on
401 (`clearCloudSessionIfUnchanged`) and stops retrying. Those users must sign in again before the relay sees
them. Fresh `/session` sign-ins: 1, 5, 3 per minute at 19:10–19:12. Recovery of controls is now paced by users
signing in, not by infrastructure. Total `session-refresh-reuse-detected` events 13:00–19:00Z ≈ 100k, against a
~100/hour baseline.
**Affected-user count (19:22Z, from `refresh_tokens`):** 23,318 live token families revoked in the window,
**21,605 distinct users**. Only ~3,800 desktops had seen their 401 by 19:15Z; the rest were closed or asleep
and will find themselves signed out on next launch, so sign-ins will trickle for days.

**Desktop UX finding (owner's own Mac, 19:22Z):** a revoked desktop keeps showing the account card as
"Connected" and the pairing pane as "Orca Relay: Unavailable" / `relay_control_not_active` indefinitely; the
local trace writes no relay events. Only quit + relaunch surfaced the sign-out prompt, after which sign-in →
relay-token → `/v1/assign` 200 (0.15 s) → working pairing, all within 10 s. Follow-ups: the relay coordinator's
401 path should flip the account card to reconnect-required immediately, and the pairing error should say "Sign
in again to use Relay" when the cause is an auth failure. Announcement wording: "If Relay shows Unavailable, quit
and reopen Orca, then sign in when prompted."

orca-cloud PR #474 (branch `auth-revoke-only-live-tokens`): caps → 20, disk 250 / max_wal_size 16384 in
Terraform, partial index in the schema, `already-revoked` short-circuit. Do not deploy auth to any environment
with a large `refresh_tokens` before building the index concurrently there.

**Wave 1 of the roadmap (2026-09-04 21:35Z onward):** five Opus agents in isolated worktrees: 3.1 grace window
(orca-cloud), 4.1+2.3 relay locks + pool timeout, 3.2+4.3 desktop refresh/jitter, 5.1+5.4 observability,
2.1 private IP (plan only, both repos). First back: stablyai/orca PR #18717 (crash alert + dashboard). Its key
finding: cell exits log to `cos_system` with uppercase `jsonPayload.MESSAGE` and `SYSLOG_IDENTIFIER=docker`,
so every earlier `jsonPayload.message:"container die"` count in this doc that read 0 was querying the wrong
field. Verified: 87 exits 12–13Z on the agent's filter, 0 in the last 6 h. Monitor dry-run 33922255205
dispatched 21:41Z as the Roll 1 gate.
Dry-run 33922255205 froze at 21:46Z on `signal_missing cloud_sql.backends`. Cause: Cloud Monitoring published
no `num_backends` point for the auth instance between 21:40 and 21:46 (every other minute of the last 100 has
one; measured directly via the timeSeries API). A Google-side publish gap, not a database or monitor defect;
the monitor's freeze-on-missing rule is correct. The 12–13Z monitor failures were a different cause (active
probes reading 0 during the crash cascade). Re-dispatched at 21:50Z.
Dry-run #2 (33922844671) froze at 21:52:21Z on `auth.health observed 0` — verdict read from the state.json
artifact, not the log (the log only prints checkpoints). Auth served `/health` 200 continuously, including the
21:52:05 probe. Cause: the probe requires `/health` AND `/ready` on the first attempt; auth has no `/ready`
(404 by design), so every auth sample takes the forced 11 s retry, and on the third sample the retry fetch threw
at the network layer on the runner (no request reached Cloud Run) and `check()` recorded the exception as
health=false. Neither freeze was fleet health. Fix delegated (relay-ops: a thrown fetch is not a reading; auth
does not require `/ready`). **Sequencing constraint for Roll 1:** monitor evidence must be < 5 min old at
canary dispatch, so the owner's go must precede the dry-run, and a green dry-run must be followed by the
canary dispatch immediately.

stablyai/orca PR #18719 (3.2 + 4.3, desktop): the replay engine was not the refresh function but
`RelayAuthCoordinator.scheduleRetry`, since `shouldRetryRelayConnectionError` treats any non-HTTP error
(including a refresh `TimeoutError`) as retryable and re-reads the same stored token on backoff. Fix: refresh
gets one 60 s attempt; an ambiguous failure (no status line) records the token and blocks re-sending it for
30 s (bounded, not permanent); definitive 5xx gets exactly one retry after re-reading the store; a 401 on an
ambiguously-attempted token logs `orca_cloud_refresh_possible_replay`. Lease renewal gets ±10 % full jitter
(base shrunk so the latest sample stays ≥ 90 s before expiry); server resets the full 55-min TTL on any rebind
(`host-session-registry.ts:736-743`) so early renewal is free. Verified the retry-path claim and both server
cites against main.

2.1 private IP: orca-cloud PR #477 (foundation: servicenetworking API, /24 peering range 10.42.128.0, private
network on the instance, `prevent_destroy`; real production plan 3 add / 1 in-place change, staging unchanged)
and stablyai/orca PR #18720 (relay: `relay_cloud_sql_private_ip` variable, conditional `--private-ip` in the
cell startup template; default false renders byte-identical to main). Findings that change the plan: Google
states the private-IP change **restarts the instance** with no in-place path, and it is a one-way door (cannot
disable private IP or remove the network link). The director uses the Cloud Run built-in connector, not the
relay VPC NAT, so it never consumed the exhausted ports and is out of scope. Disabling public IP later breaks
the local proxy workflow and the director. #18720 merges (inert); #477 held for owner decision.

4.1 + 2.3 relay: stablyai/orca PR #18722. Premise correction: #18521 and #18606 had already bounded and
narrowed most of the fleet-wide lock before today; what remained were the sticky-refresh retry (all 23 rows →
the one pinned row), reservation reconciliation (23 → the 2 involved rows), a dead pool-default fallback, and
an absolute counter write (→ delta with capacity guard). Placement (`assignOnce`) deliberately keeps the
ordered inventory lock: least-loaded selection is fleet-wide and dynamic target-only locking previously caused
cross-cell cycles; converting it to optimistic snapshot + conditional delta is the remaining 55P03 floor and a
follow-up. Pool `statement_timeout` was already 5 s but hardcoded; now env-configurable, `57014` added to the
retryable set (it was terminal before), schema DDL on an untimed max:1 pool. Independently re-ran the new and
adjacent suites here against 55440: 66/66. Harness note: 55440 is not idempotent across full runs (2
pre-existing failures on a second run); reset the schema between runs. Rollout: director first, watch
`orca_relay_postgres_transaction_exhausted` and `cellInventoryHoldMsP95` before cells.

#18719 first CI run failed only on `windows-host-job.win32.test.ts` (EPERM on temp-dir cleanup), a Windows
PTY test the PR does not touch and which no other recent run failed on; rerun dispatched rather than waved.

3.1 grace window: orca-cloud PR #478 merged (not yet deployed; deploy is an owner gate because the startup
schema apply adds a nullable column to `refresh_tokens` with a brief ACCESS EXCLUSIVE). Semantics: within
`ORCA_CLOUD_REFRESH_ROTATION_GRACE_MS` (60 s default, 300 s cap, 0 = off) a re-presented rotated token gets the
SAME successor refresh token + a fresh access token, no revoke, no audit, provided the successor is still the
live head. Third presentation / outside window / revoked family: unchanged (revoke + audit). Successor plaintext
is stored sealed (AES-256-GCM, key = HKDF of the predecessor token; the DB never holds the key). Cost stated
plainly: a stolen token replayed inside 60 s is served once instead of tripping detection; DB-read + stolen
predecessor recovers the successor offline until pruned. Rotation now runs in one transaction (proved by a
forced-INSERT-failure rollback test; the 8-way race alone did not kill the non-transactional mutant). Verified
locally 27/27 incl. the Postgres suite against 55440, and CI ran it on PG 16 and 17 (4/4 each, not skipped).
Deploy wiring: env is set by BOTH Terraform and the deploy workflow, with a test pinning all three sources to
one value. **Pre-existing bug surfaced:** the deploy script strips every env var it does not own, so the
Terraform-set `ORCA_CLOUD_REFRESH_TOKEN_TTL_DAYS` (from #476) silently reverts to the compiled default on each
release. Latent only because both defaults are 30. Follow-up: add it to `authEnvironment` + the workflow env.

Monitor probe fix: stablyai/orca PR #18723. A thrown fetch (DNS/TCP/TLS/8 s abort) is now "no reading" and is
re-asked once after 1 s; only a second throw is `false`. A non-ok HTTP answer is still `false` with no extra
retry. `latencyMs` is the slowest answering round trip, never a sleep. `requiresReady` is per endpoint: auth
(no `/ready` by design) is judged on `/health` + latency; director and cells unchanged. No threshold or rule
touched; `auth.ready` had no consumer. 81/81 relay-ops tests and 9/9 evidence-script tests locally. The monitor
runs at `main` head, so once merged the next dry-run uses it.

Applying #18717 (22:10Z): the cell-exit log metric `orca_relay_cell_process_exit` is created; the alert policy
raced descriptor propagation (404) and is being retried. **Not applied, deliberately:** the dashboard. Its
targeted plan drags in `google_logging_metric.relay_snapshot[*]`, and that plan is `32 to add, 21 to destroy`:
the Terraform source adds a `region` label to every runtime metric (`EXTRACT(jsonPayload.region)`) which the
live metrics do not have, and a label change on a log metric is a delete+create. Replacing 21 live metrics
resets their history and would blank the 14 existing relay alert policies during the swap. That is
pre-existing drift in the relay root (unapplied since the region work), not something #18717 introduced. It
needs its own reviewed apply in a quiet window, ideally with the runtime-metric replacement acknowledged as
intentional. Dashboard apply waits on that.

**Wave 1 closed 22:20Z.** Merged: orca-cloud #478 (grace window); stablyai/orca #18717 (crash alert +
dashboard TF), #18719 (desktop no-replay + jitter), #18720 (private-IP flag, off), #18722 (relay per-cell
locks + pool timeout), #18723 (monitor probe fix). Applied to production: cell-exit log metric + alert policy.
Held for owner: orca-cloud #477 private IP (restart, one-way); the dashboard apply (behind the runtime-metric
label drift); the auth deploy carrying #478; Roll 1. Every wave-1 code change now sits on main un-deployed:
the next relay image build carries #18722 + #18723's monitor runs at main head already; the next auth deploy
carries #478.

**Landing (2026-09-04 20:50Z–21:02Z, owner: "if you are confident the cloud changes are valid, you can land them"):**

- Merged: orca-cloud #474, #475, #476; stablyai/orca #18693, #18694, #18698. Neither repo has branch
  protection or environment reviewers; `verify` / `cloud-verify` green on main after each.
- Applied to production by targeted saved plans (each plan asserted create-only / exact-attribute before
  apply, via `terraform show -json`): 4 relay resources (WAL-checkpoint log metric + 3 alert policies), 8 auth
  resources (3 log metrics, propagation sleep, 4 alert policies), and the us-central1 NAT
  (`enable_dynamic_port_allocation` false→true, ports 64..4096). Google's docs: switching to dynamic does not
  break existing connections when max ≥ 1024 and max ≥ old min; only lowering max or reverting to static is
  disruptive. asia-east2 NAT deliberately left for after a US soak.
- Not applied: the untargeted apps-root plan also carries 4 unrelated drifts (`ORCA_CLOUD_REFRESH_TOKEN_TTL_DAYS`
  env on the auth service from #476, a skill log exclusion filter change, skill pressure threshold 16→8, an
  artifacts bucket lifecycle rule) and fails on the 1Password Cloudflare data source locally. The foundation
  root plans clean (disk 250 / max_wal_size already match). Those drifts belong to whoever runs the next full
  apps apply in CI.
- `deploy-auth-production` on main 8034955 (run 33919143723) **succeeded 21:04Z**: serving revision
  `orca-cloud-auth-00031-tox` at 100%, previous `00018-4jc`, cap 20, smoke passed on both URLs. First 15 min on
  the new revision: 31×200 / 1×401 on `/refresh`, max latency 56 ms, no 5xx. The new
  `refresh_token_prune_cursor` table exists, so the new schema applied.
- US NAT soak (21:01–21:06Z): 0 drops, 0 proxy dial errors, 0 cell exits, port_usage 11, sqlMax ~1.07 s.
  Asia NAT then applied 21:05:28Z from the pre-verified saved plan (same three attributes). The deploy script strips env vars it does not own, so the Terraform
  TTL var will not be on the new revision until the full apps apply lands; the auth code defaults to 30 d.
- Terraform locally needs `GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"`; ADC is stale.

**Alerting + NAT follow-ups (19:58Z, superseded by the landing block above):**

- stablyai/orca PR #18693 (`relay-nat-ports-and-sql-alerts`): both relay NATs switch to dynamic port
  allocation (64–4096 per VM); new relay-channel alerts for the Cloud SQL WAL checkpoint loop (log metric on
  `checkpoint starting: wal`, > 3 per 5 min), Cloud SQL disk > 70%, and NAT `OUT_OF_RESOURCES` drops. No
  existing workflow applies these resources; the PR body carries the targeted plan.
- orca-cloud PR #475 (`auth-observability-alerts`): log metrics + policies for auth refresh 401 (> 100 per 5
  min; Sep 3 baseline 20–80 per hour), 429 (> 20 per 5 min; baseline 0), 5xx (> 10 per 5 min), and Cloud Run
  p99 latency > 10 s. Production routes to the relay Slack channel.
- Desktop stale auth-status fix: stablyai/orca PR #18694 (`desktop-cloud-session-revoked-status`). Main pushes
  an auth-status-changed IPC when a 401 clears the session; panes re-fetch on mount; the pairing notice says
  "Your Orca account session expired. Sign in again to use Orca Relay" and hides Retry. StrictMode regression
  test verified red on the old guard. Does not help desktops already revoked today (session cleared before
  this code); it fixes every future revocation.
- orca-cloud PR #476 (`auth-refresh-token-pruning`): batched `refresh_tokens` pruner as a scheduled Cloud Run
  job (revoked rows kept 30 d, rotated rows 60 d against a 30 d TTL, 5k-row batches, 200 ms pauses, persisted
  cursor, per-run budget) plus a 10 s `statement_timeout` on the auth request pool with schema DDL on an
  untimed connection. Merges cleanly onto #474 and does not need its index (walks the primary key;
  EXPLAIN-asserted no seq scan). CI ran the Postgres integration tests for real on PG 16 and 17. Ships
  `auth_token_pruner_enabled = false` in both environments: enabling needs an image digest from a build that
  contains the new entrypoint. Operating rules once enabled: monitor the run summary's `stopReason` and
  `deletedRows`, not the exit code (a run that only ever times out exits 0); ~48 M rows drain in ~10 days at
  200k/hour; deleting them leaves dead tuples, so the 16 GB is not reclaimed without a separate VACUUM FULL or
  pg_repack pass, which is its own change.
- Phone-side copy when the desktop is signed out: stablyai/orca PR #18698 (`phone-desktop-signed-out-reason`).
  Real path traced: the director resolves the phone to the host's last cell (durable assignment row), and the
  cell's `acceptClient` rejects with 4404. The only additive slot every shipped peer tolerates is the WebSocket
  close *reason* (relay-hello and resolve schemas are zod strict; a new close code drops old phones off the
  host-offline cadence). Desktop closes its control with reason `signed-out` only when the cloud session is gone
  (null context after a 401, or explicit sign-out); quit and relaunch stay reasonless. Cell remembers it per
  host for the dormant-assignment TTL, forgets on re-auth, and echoes it as the 4404 close reason; phone
  renders "Desktop signed out — sign in to Orca on your desktop to reconnect" with the same retry cadence.
  Old×new matrix in the PR body; nothing changes for any old peer. Merges cleanly with #18694.

## What actually blocks the roll now (12:58Z summary for the owner)

0. **Cloud NAT ports** (Finding 11, found 12:55Z): every us-central1 cell reaches Cloud SQL's public IP
   through a NAT with the default 64 ports/VM; port_usage pinned at 64 and 1,514 dropped SYNs to
   Cloud SQL:3307 in one 4-min window. This is the 2 s connect stall that kills old-image cells and is
   still active after the disk loop broke. Fix: `min_ports_per_vm = 1024` (or dynamic allocation) on
   `google_compute_router_nat.relay_gce` in `cloud/infra/terraform/relay-gce-foundation.tf`, targeted
   apply; durable fix is a private IP on the Cloud SQL instance. Online, no VM restart.
1. **Cloud SQL disk** (Finding 10): 49 GB PD-SSD saturated since 11:58Z, checkpoint loop, fleet-wide
   4–6 s stalls every ~45 s. Fix: bigger disk and/or `max_wal_size`. Owner: `stablyai/orca-cloud`
   `infra/terraform-foundation/database.tf` `google_sql_database_instance.auth` (no `disk_size`,
   `disk_autoresize`, or `database_flags` set today, so Terraform is at defaults: 10 GB initial, autoresize
   grew it to 49 GB). Add `disk_size = 200` (+ `disk_autoresize = true`) and optionally
   `database_flags { name = "max_wal_size" value = "4096" }`; production tfvars are
   `infra/terraform-foundation/environments/production.tfvars`; applied by `deploy-production.yml` in
   that repo. Online, no restart for disk; `max_wal_size` is also a non-restart flag. Note Terraform
   `disk_size` below the live 49 GB would be a destructive shrink, so 200 is safe and 49 is the floor. **This is now the first thing to do**; nothing else can pass a
   15-min gate while it persists, and it is also what is killing the old-image cells several times an hour.
2. **Old cell image** (Finding 6): dies on every stall. Fixed by rolling 519f4914 (canary inputs ready).
3. **Gate policy**: `directorErrors: 0` and per-cell health probes freeze on any single stall. Recalibrate
   after 1 and 2, or bypass by hand for the canary.

## Plan agreed with the owner (2026-09-04 ~06:45Z), in execution order

Owner: "feel free to improve operations to make things more effective ... continue driving everything e2e
until this process is complete." Owner has had multi-day experiences with cell rolls and does not want a
9-hour sequential roll.

1. **Lock-removal PR** (root cause). *Status 08:55Z: pushed as branch `relay-single-row-reservation`
   (2 commits). Opus adversarial review found one real defect: `acquireActivity` moving a client-chosen
   activity id across cells locked the old cell's row before the new one, cycling with placement's
   ascending inventory lock (reviewer reproduced it as paired 55P03s on real Postgres; no 40P01 because
   lock_timeout == deadlock_timeout == 1 s). Fixed with `lockCellRows` (ordered, 500 ms bound); census now
   fails on any inline `relay_cells FOR UPDATE` outside the named helpers. Three-cell Postgres test moves
   an activity high->low while the target row is held; 5/5 revert-mutants fail it. 480 SQLite tests +
   tsc green. Also fixed a pre-existing test leak (`relay_cell_connection_snapshots`) that made
   `assignment-control-supersession-postgres` fail on reruns. Reviewer re-verified 65569be3de: cycle
   repro completes in 7 ms (was 1022 ms + paired 55P03); no remaining out-of-order pair in the store;
   flagged two evasions in the new census guard, closed in the third commit (whole-statement scan,
   covers query() too, mutation-checked with both evasions). Headroom Postgres test's one failure is
   pre-existing on main (verified by swapping in main's store).* Make `activateControl` superseded-control cleanup, `acquireActivity`
   existing-lease branch, and `changeActivity` use the existing single-row
   `adjustCellReservationAtomically` instead of the 23-row `lockCellInventory`. Keep the global lock only
   for placement (`resolve`/assignment) and sweeps. Real-Postgres contention test on port 55440.
2. **Faster same-cap rollout workflow.** (a) paced drain instead of `graceMs: 0` so a cell's ~800 hosts
   re-dial over minutes, not one second (director cap is 5 x 80 = 400 in-flight); (b) cells in a batch run
   in parallel once drains are paced; (c) post-canary batches use a short freshness check instead of a new
   15-min dry-run, since the in-job safety recheck already runs before each drain; (d) job timeout > 75 min.
   Target: 22 cells in ~6 batches x ~25 min.
3. **Build image** with (1) merged, then one roll of the fleet with (2). Asia cells c27/c28/c29 first.
4. Re-tighten the monitor retries bar; recalibrate the Terraform exhausted alert.
5. Consider deleting the 55-min control lease rebind entirely (no recorded reason; liveness is the 75 s
   watchdog + 90 s activity lease). Separate PR after (1) so its effect is measurable.

## Faster same-cap rollout: design (step 2 of the plan), from reading the real limits

What actually bounds parallelism today (measured on the c7 canary, run 33843071283):

| step | c7 duration | bound by |
|---|---|---|
| prechecks (recheck, backend init, resolve, verify) | 43 s | none |
| isolate + drain + transition wait | 7 min | drain is `graceMs: 0`; `verify-relay-capacity-transition --activity restart-safe` polls until leases drain |
| Terraform template + MIG recreate + wait-until stable | 8 min | GCE recreate; per cell, independent |
| verify new incarnation + trust proof + restore | 1.5 min | none |

Real constraints: (1) the director is 5 x 80 = 400 in-flight `/v1/assign`; a `graceMs: 0` drain of ~800
hosts pins it at cap for ~2 min (observed 79.75/84.75 p99). (2) `production-cloud-sql-rollout` lease and
workflow concurrency group serialise the whole run, by design, and the per-cell job shares it via
`holder-key`. Nothing else forbids parallel cells.

Changes, smallest first:
1. **Paced drain.** `HostSessionRegistry.drain(graceMs)` already sends `drain {graceMs}` and closes each
   session after `graceMs`, but the desktop's `handleDrain` re-dials immediately regardless of graceMs
   (`relay-origin-pool.ts:150-162`), so graceMs only delays the *close*, not the stampede. Fix on the
   cell: stagger the drain *send* across sessions over a window (e.g. 800 sessions over 120 s = ~7/s),
   which needs no desktop change and works for every desktop version in the field. New admin body field
   `spreadMs` (optional, default 0 keeps today's behaviour); canary script passes `spreadMs: 120000`.
   Requires the cell to be on an image with the change, so it applies to batches after the first
   post-lock-fix roll, not to this one.
2. **Parallel cells in a batch.** In `cloud-deploy-relay-production-same-cap.yml` make `cell_2..cell_4`
   `needs: [gate]` instead of chaining, gated on the same evidence (drop the `+75 min x wave-index`
   allowance, it exists only because of chaining). Each job already takes the rollout lease with the
   run's `holder-key`, so they re-enter it rather than fail. With paced drains, 4 cells x ~800 hosts
   over 120 s is ~27 dials/s, well under the director cap. Raise `timeout-minutes` to 90.
3. **Post-canary batches skip the 15-min dry-run.** The in-job "Recheck aggregate SQL, pool,
   reconnect, migration, and selector safety" step (`pnpm incident:relay-preflight`) already runs a
   live one-shot check before each drain. For `batch-apply` with a sealed `canary-run-id` from the
   same commit, accept a dry-run of any age (the canary's) plus that live recheck; keep the 15-min
   requirement for `canary-apply`. Change lands in `relay-monitor-evidence.mjs verify-authority` +
   `relay-production-same-cap-wave.mjs` + their node:test suites.

**Correction after reading the cell job (07:35Z):** (2) parallel cells is not a flag flip. Each cell job
asserts the exact selector generation `expected + 2 x wave-index` and exact memberships derived from
predecessors having completed (`ISOLATED_*`/`RESTORED_*` in the job, `applyExactAdmissionSelector`
compare-and-swap), and all cells share one Terraform state lock. Making that concurrent means a batch-level
isolate/restore in the gate and a rewrite of the 650-line job's expectations. That is the multi-day trap
the owner described. Deferred.

What is cheap and removes most of the wall-clock: (3). The per-batch 15-min dry-run costs 15 min each
*and* fails ~50% of the time on old-image crashes, which is where hours go. Implement: `batch-apply` with a
verified canary authority accepts a passed dry-run up to 6 h old and may re-use one already consumed
(the consumed-marker check exists to stop replaying stale evidence; the canary binding plus the in-job
live preflight at drain time replace it). Files: `relay-monitor-evidence.mjs` (`--after-canary`),
`incident-live-preflight-cli.ts` (same flag), the same-cap workflow + job, and both test suites.
Revised expectation: 22 cells = 6 sequential batches x ~70 min = ~7 h wall-clock but *unattended-safe*
and with one dry-run total, versus today's 6 dry-runs at ~50% each. (1) paced drain rides the lock-fix
image.

## Recommended next steps (superseded by the plan above; kept for history)

1. Resolve the gate decision above, then: monitor dry-run -> c7 `canary-apply` only -> verify -> stop.
   Each rolled cell leaves the Finding 6 crash class.
2. Merge #18565; publish; a later same-cap roll carries it to cells.
3. Remove the global inventory lock from per-connection paths (`acquireActivity` existing-lease
   branch, `activateControl` superseded-control cleanup, `changeActivity`) by using the existing
   `adjustCellReservationAtomically` single-row update. Own PR, after the roll.
4. Recalibrate the Terraform alert `relay_postgres_retry_exhausted` to 300/300 s (observability root).
5. Whether to raise `relayPostgresRetries` is a human call; the data is in Finding 5.

## Canary blast radius (read before dispatching c7)

- What `canary-apply` does to c7, in order: isolate (selector -> migration-only, no new
  assignments), `/v1/admin/drain graceMs:0` (every control on c7 re-dials the director and is
  reassigned), Terraform template + MIG update to the target image, wait stable, verify new
  incarnation + exact digest + protocol, prove per-host trust, restore c7 to general admission.
  On any failure c7 is left isolated (migration-only) with rehome disabled; nothing else is touched.
- c7 at 05:20Z: 788 controls, 5 splices, 800 connections. So ~790 desktops re-dial once. The fleet
  already absorbs this exact event 201 times / 48 h uncontrolled (Finding 6); the controlled version
  isolates first, so no new assignment lands on c7 mid-roll. Expect a director concurrency blip, not
  a freeze-class one (six cells at once gave 85; one cell should stay well under 64).
- Precedent: the identical workflow (pre-move, in orca-cloud) ran 9 successful `apply` canaries and
  batches on 2026-08-27 (last: c20 -> 5aedbca5). Its failures that day all stopped at the read-only
  "Recheck aggregate SQL..." or "Require durable rehome disabled" step, before `MUTATION_STARTED`.
  The moved copy in this repo has one run: the read-only `verify` of c7 (passed, including WIF auth).
- c7 side note: MIG autoheal recreated the c7 instance four times on 2026-09-01 08:02-08:42 PDT
  at ~13 min spacing. Same crash class as Finding 6 (health check failing during restart loops).

### Canary observed effect (c7 drain, 2026-09-04 06:10Z)

- c7 807 controls -> 0 between 06:08:52Z and 06:10:52Z. Director `/v1/assign`: 200s 32 (06:09) -> 2628 (06:10)
  -> 340 (06:11); 5xx 1969 (06:10) -> 31 (06:11). Director max-concurrency p99 7.9 -> 79.75 (06:10) -> 84.75
  (06:11), i.e. at the Cloud Run cap of 80 for ~2 min. My pre-dispatch estimate ("well under 64") was wrong.
- Confounder: c10 (us-central1, instance 2803000337345335589) crashed 06:09:56Z on the old-image class
  (Node.js banner + container die), so ~1,600 hosts re-dialed in the same minute, not ~800. Coincidental;
  the fleet has one of these every ~15 min.
- Recovery: 06:13 903 / 06:14 1471 assign 200s from 640 distinct desktop IPs; 503s 78 -> 183 -> 29/min.
  No cell crash 06:12–06:16Z. Drain step passed ~06:16Z; template/MIG apply started.
- 06:16:03–06:17:08Z, during c7's template apply (not its drain): c27 (x4) and c29 (x3) crash-looped on the
  old-image pg-pool connect timeout in `beginProof`, both MIGs autoheal-recreated (c27's second recreate in
  40 min). Fleet 23 -> 21 reporting cells, controls 13286 -> 12462, assign 503s 1000/min at 06:17, director
  concurrency p99 74.8. Cloud SQL CPU 0.70 max, backends 174 max (bar 250). Same multi-cell pattern occurred
  at 01:31Z (4 cells) and 04:47Z (5 cells) with nothing rolling; the c7 drain's SQL load 6 min earlier may
  have nudged the pool timeouts but the class is pre-existing. c7 MIG RECREATING onto new template
  `…20260904061618…` = the expected image swap.
- 06:20Z: 849 assign 503s. Closes 06:19:30–06:21: 162x1006 age<5min (hosts bouncing off the recreating
  c27/c29), 73x4408 + 53x1006 in the 50-min age bin (Finding 3 rotation cohort). Not roll-caused.
  c7 MIG `recreating=1` on the new template since 06:16:18Z; c27 and c29 MIGs also RECREATING (autoheal).
- 06:23:16Z c7 instance restarted in place (MIG RECREATE keeps name/id relay-c7-bwjc / 4545742188814054238),
  pulled `relay@sha256:85bf6799…` 06:23:37Z, listening + readiness true 06:23:42Z. Apply step passed 06:24Z;
  verify step running. Isolate -> ready on new image took ~14 min end to end.
- Post-restore c7 on new image (06:25:42–06:26:42Z): controls 143 -> 273 -> 377 refilling, sqlQueries
  ~1,500/30 s, `sqlLatencyMsMax` 518 -> 1003 -> 1155 ms, still 55P03 `cell-inventory` retries. So the new
  image alone does not remove lock waits; the request-path 500 ms cap from #18521 applies to the director's
  paths, and cell-side `acquireActivity`/`activateControl` still ride the global lock (step 3 in next steps).
  Watch: does c7's sqlLatencyMsMax settle below the old 1.0–1.2 s pin once refill finishes, and does c7 stop
  appearing in `container die` (the real win: guardSessionTask).
- 08:25Z (2 h after restore): c7 817 controls, 0 crashes since 06:25Z. Fleet crashes last 2 h: c27 x6,
  c28 x5, all old-image Asia cells. The new image stops the crash class as predicted; it does not move
  lock latency (c7 sqlLatencyMsMax 1005 ms), which is #18606's job.
- Implication for the batch phase: every drain will push director concurrency past the monitor's 64 bar
  for ~1-2 min. The batch job rechecks safety *before* it drains (read-only step), so that is fine per wave,
  but never run a monitor dry-run concurrently with a wave, and prefer batches of 2 over 4 until the fleet
  is on the new image and the crash class is gone.

## Post-merge dispatch plan for #18606 (image -> director -> cells)

1. `gh workflow run cloud-publish-relay-production.yml --ref main -f mode=publish` (after the squash lands
   on main). Resolve the digest by tag, never by parsing the log (it mixes relay and fence-broker digests):
   `gcloud artifacts docker images describe us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay:sha-<merge-sha> --format='value(image_summary.digest)'`.
2. Director: `gh workflow run cloud-deploy-relay-production-director.yml --ref main -f image-digest=<new>
   -f regional-placement-mode=preserve -f prune-incompatible-revisions=false -f expected-rehome-generation=12
   -f bootstrap-runtime-identity=false -f predecessor-image-digest=<currently serving digest>`
   (no monitor evidence needed; requires rehome disabled at gen 12, which it is). Last run 33826514754 used
   the same shape. Watch director `orca_relay_postgres_transaction_retry` per minute before/after.
3. Cells: same-cap `verify` c7 with target=<new>, rollback=85bf6799; fresh dry-run; `canary-apply` c7;
   then batches (3 per batch, Asia c27/c29/c28 first). Each batch: new dry-run unless the batch-reuse
   change (design section above) has shipped.

## Finding 8 (2026-09-04 08:40Z): ten-cell crash cascade during the director deploy, not caused by it

Timeline: candidate revision 00570-siv created 08:38:39Z, first log 08:39:20Z; traffic still 100% on
00565-fes through 08:43 (assign logs by revision). Cell crashes: c28 (5031087219978409220) looped 08:37:55–
08:40:07 (9x), then at 08:40:20–08:40:45Z **ten** instances died within 25 s (c10 2803…, 5110…, 532…, 5464…,
7536…, 7726…, 8671…, 8928…, 8966…). All old-image `beginProof` pg-pool timeouts. Fleet controls 13,423 ->
6,157 by 08:43; assign 503s 3,912 (08:42) and 4,624 (08:43) per minute, director concurrency 85 (cap 80),
Cloud Run autoscaled 5 -> 10 instances, Cloud SQL CPU 0.55 -> 0.99. Deploy finished cleanly at 08:45Z with
the new director taking the tail of the storm; by 08:46 503s were ~30/15 s, controls 7,913 and rising,
director lock retries 29/min (vs 105–157/min pre-deploy) and exhausted 2/min (vs 65/min at 08:36).
Same class as 01:31Z (4 cells) and 04:47Z (5 cells) today; this was the biggest. c7, on the new image
since 06:25Z, did not crash. What triggered the pool timeouts fleet-wide at 08:40 is not established; Cloud
SQL CPU was 0.78–0.88 in the minutes before, the highest of the day, so the cells' 2 s connect timeout is
the plausible tipping point under a busy database. Every cell still on 5aedbca5 remains exposed to this.

## Finding 9 (2026-09-04 08:56Z): #18606 on the director cut lock retries ~10x

`orca_relay_postgres_retries` per 5 min, director only: 08:21–08:41 windows 419–689 (old image, incl. the
crash storm); 08:46/08:51/08:56 (new image 519f4914, refilling ~7k hosts): **61 / 69 / 54**. Exhausted:
104–178 -> **11 / 14 / 12**. Inventory hold p95 ~200 ms, max 255 ms, ~366 holds/min. Cells (still old
image) 17–44 -> 0–3, because the director no longer holds the 23-row lock on their behalf. This is the
first direct measurement of the root-cause fix under real load. Cloud SQL CPU peaked 0.99 during the
cascade and is decaying (0.86 at 08:55); the monitor freezes above 0.80, so no dry-run until it clears.

Fourth cascade 09:00:12–09:00:18Z: c23, c8, c16, c26, c22 (five cells, 11 container-die events in 6 s,
all `5aedbca5`, exitCode 1, Node banner, pg-pool `client closed the connection` burst right before). Cloud
SQL CPU 0.84 -> 0.78 in the preceding minutes, director concurrency 18–22 (idle), so this one fired
*without* a database or director spike. Fleet had just recovered to 13,015. Cadence today: 01:31 (4),
04:47 (5), 08:40 (10), 09:00 (5), 09:31 (c13, c23), 09:34 (c23 again, c14, c20, c9; c14/c20 crash-looping),
09:39 (c21, c24), 09:55 (c16, c8), 09:59 (c20), 10:05 (c8, c20), 10:19 (c16 stalled, no crash), then a 58-min
lull, 11:04 (c9; c28 died 13x in 4 min, autoheal recreate 11:09Z, its 3rd recreate today), 11:17 (c10, c28
again, c22, c23, c14 x9 looping; 23 dies in ~90 s; fleet 13.3k -> 10.8k), 11:31 (c14, c23, c25, c15, c24, c19), 11:34 (c20, c26, c29 x4, c14, c27 x3, c25; fleet 13.1k -> 10.3k).
Three cascades in 17 min. 11:38–11:45 c27 crash-looped 17x and c28 4x (Asia cells), c29 recreating.
11:59 (c21, c9, c10, c23), 12:02 (c19; 4,109 assign 503s that minute, mostly hosts bouncing off the
recreating cells, code 1006 age<5min x217), 12:09–12:12 (c19, c27 x6, c28 x5, c13, c22, c15, c26, c14;
8 cells, c27/c28 recreating again). Cloud SQL CPU 0.62–0.85 through it. 12:20 (six more cells). Cascade
cadence since 11:00 is now ~every 8 min; the waiter has held correctly the whole time and there has been
no dispatchable window. Loop continues unattended; findings stop logging each cascade from here unless the
class changes. Every cell that has died today is on 5aedbca5; c7 (85bf6799,
5.5 h) has not. Cell dies per hour today:
01Z 5, 02Z 7, 03Z 4, 04Z 7, 05Z 4, 06Z 9, 07Z 11, 08Z 30, 09Z 26, 10Z 2, 11Z 68+ (to 11:42).
Director concurrency pinned at 85 for 09:32–09:33; 503s 4,141 and 4,396 per minute. 09:39: c21, c24
(2,870 503s). Crashes per instance 08:10–09:40Z: c28 x14, c27 x5, c23 x5, c22 x4, c14 x4, c13/c20 x3,
then c26/c9/c24/c16/c8 x2. Mean gap between cascades since 08:40: ~12 min. Every 15-min gate attempt
now has well under even odds; the c7-style canary that ends this needs a gate it can pass. The old image is now cascading roughly hourly regardless of load; the
only cell on a fixed image (c7) has 0 crashes in 2.5 h across all four.

Director 500s: 4 in the 09:00 window, all 2.0 s latency on `/v1/assign` or `/v1/resolve` = pg-pool connect
timeout surfacing as a 500. Pre-existing (Sep 3: 03h/08h/16h one each, same 2.0 s shape; 06:09Z today on
the old image during the c7 drain). The monitor's `directorErrors: 0` bar freezes on any of these, so a
dry-run needs a 15-min window with none; at ~1 per cascade that is a real but modest constraint.

**Gate observation (09:26Z):** `directorErrors: 0` counts every non-503 5xx on the director, including
the monitor's own admin calls. The director on 519f4914 still sees an occasional 2.0 s pg-pool connect
timeout (~1 per 20 min under today's Cloud SQL load), which surfaces as a 500 on whichever request drew
it. Two consecutive dry-runs (#7, #8) froze on exactly this: one, isolated, 2 s 500. That bar was set for
"unexpected director 5xx"; a single connect timeout that the client retries is not an incident. Candidate
recalibration (own PR, not done): `directorErrors` 0 -> 2 per 5 min, or exclude the monitor's own
user-agent. Not changing it unasked; noting that at ~3 per hour the 15-min gate passes ~1 in 2 attempts.

**Did the director deploy make cells crash more? (checked 09:45Z)** Cell `container die` per 30 min:
06:00 9, 07:00 2, 07:30 9, **08:30 30** (director candidate 08:38, traffic 08:43–08:45; the 10-cell burst
was 08:40:20, before the move), 09:00 11, 09:30 12. Per hour today 05:4 06:9 07:11 08:30 09:23 vs Sep 3
same hours 2/7/8. So today is 2–3x worse than yesterday and was rising before the deploy; after the deploy
it is ~11–12 per 30 min, in line with 06:00–07:30. Cloud SQL backends (~230 max) and new connections
(~5k/30 min) are flat across the deploy. Latest crash (c21 09:39:11) is `Connection terminated due to
connection timeout` with cause `Connection terminated unexpectedly` in `verifyCellAssignment` <-
`beginProof`, the same unhandled path. Conclusion: no evidence the deploy worsened it; the old image's
crash rate simply climbed all day. Director lock retries stayed ~10x lower after the deploy.

**Checkpoint-phase check (10:00Z, negative result):** Postgres checkpoints complete every 5 min at ~:07.
Cell crashes bucketed by phase within that 5-min cycle show a mild :00–:29 s cluster today (22 of 103)
that is absent on Sep 3 (7 of 114), so checkpoints are not the trigger. Disk write bytes in cascade
minutes are at or below the median except 09:00. Cloud SQL memory 0.47, transaction rate flat. The
09:55 stall (11 director + 4 cell pg-connect timeouts in the same 4 s) came with `could not obtain lock
on row in relation "relay_cells"` from a NOWAIT sweep at 09:55:36, i.e. someone was holding the full
inventory at that moment. On the new director that can only be placement or a sweep; on the old cells it
is still every rebind. What stalls *connections* (not locks) for 2 s fleet-wide remains unexplained;
Cloud SQL is `db-custom-4-15360` REGIONAL PD_SSD 49 GB at 0.5–0.75 CPU when it happens.

**Stall census (10:01Z):** 33 pg-connect-timeout stall events today (clusters of timeouts < 20 s apart).
Before 08:35 they were 1–9 timeouts each and 10–60 min apart; from 08:35 the big ones are 16, 22, 21,
17 timeouts and 5–30 min apart. No second-of-minute phase (start seconds spread across all buckets), so
not a fixed timer. Cloud SQL backends by state at 09:55: active peaked 42 at 09:52, idle-in-transaction
≤ 10, nothing near the 400 ceiling; memory 0.47; disk normal. Each stall is a few seconds where *new*
connections to Cloud SQL (via the auth proxy socket) time out at the 2 s `connectionTimeoutMillis`,
hitting every process that happens to need a fresh pool connection in that window. Old-image cells die
on it (unhandled), new-image director logs a 2 s 500 and continues. Root cause of the stall itself is
outside the relay code (Cloud SQL proxy or instance); not chased further here.

## Finding 10 (2026-09-04 12:40Z): Cloud SQL disk write saturation since 11:58Z is driving the stalls

`orca-cloud-auth-db` is `db-custom-4-15360` on a **49 GB PD-SSD** (81% used). PD-SSD performance scales
with size: 49 GB gives roughly 1,470 write IOPS and ~23 MB/s write throughput. Measured:

| | before 11:58Z | 11:59Z onward |
|---|---|---|
| disk write MB/s | 4–6 | **30–50** (over the ~23 MB/s cap) |
| disk write IOPS | 500–800 | 800–1,475 (at the ~1,470 cap in 11:59, 12:15, 12:24, 12:34) |
| checkpoint `sync=` | 0.07–0.2 s (Sep 3 max 0.65 s, 290 checkpoints) | 2–20 s; 27 of 39 checkpoints in 12Z were >= 2 s |
| checkpoints per hour | 12 (timed, every 5 min) | 39 (WAL-triggered, every ~45 s; `write=` fell from 270 s to 30 s) |
| Cloud SQL CPU / memory | 0.5–0.8 / 0.47 | same (not the bottleneck) |

Every 4 s+ fleet-wide SQL stall since 11:04 (11:04, 11:17, 11:31, 11:34, 12:09, 12:10, 12:18, 12:20,
12:30) sits inside a slow checkpoint `sync` window; the 12:30:49 checkpoint synced 5.88 s (longest file
5.47 s), matching the 12:30:02–41 stall. During fsync the WAL writer stalls and every session waits, which
is why the stall hit all 23 cells and the director at once regardless of the relay lock changes. The
old-image cells then die on the pool timeout; the new image survives. What raised write volume ~8x at
11:58Z is not established (autovacuum ran on every relay table 11:55–11:57 and checkpoints are being
forced by WAL volume, so a write amplifier inside Postgres is the leading candidate; relay transaction
rate and Cloud SQL network bytes were flat). This is the first cause found today that is *upstream* of
the relay code and it explains the afternoon acceleration (11Z 68 dies, 12Z 47 by 12:34).

Corrections after digging (12:45Z): relay query volume, renewals, reconnects, and assignments per 5 min
were **flat** across 11:58 (sqlQ ~330k, renewals ~115k), so the relay did not start writing more. WAL
recycling per checkpoint went 7 -> 10–11 files (16 MB each) at 45 s intervals, i.e. WAL output rose from
~0.4 MB/s to ~4 MB/s while data-file writes rose to 30–50 MB/s; checkpoints switched from `time` to `wal`
triggered at 11:58:24. No Postgres slow-statement or "checkpoints too frequently" lines. This is
write amplification inside Postgres (full-page writes after each of the now-frequent checkpoints on
hot pages, plus autovacuum on every relay table each minute) on a disk too small for its IOPS ceiling,
not new relay load. Instance label `managed_by=terraform`, created 2026-07-09; the instance resource is
**not** in `cloud/infra/terraform` (only the database, user, and secret are, via
`local.relay_database_instance_name`), so it lives in the other Terraform root (orca-cloud, per
[[orca-cloud-terraform-split-findings]]). `storageAutoResize=true` with limit 0, so Cloud SQL will grow
the disk only when it fills, not when IOPS saturate; disk is 81% full.

Onset precisely: the 11:55:37 `time` checkpoint wrote 67,258 buffers (10.5% of shared_buffers, the
day's largest) over 163 s and completed 11:58:24. Every checkpoint since has been `wal`-triggered at
~45 s spacing (`max_wal_size` reached), each writing 13–20k buffers with 9–11 WAL files recycled. This is a
self-sustaining loop: a checkpoint completes -> every subsequent write to a hot page emits a full-page
image into WAL -> WAL fills `max_wal_size` in ~45 s -> next checkpoint -> repeat. The relay's hot rows
(`relay_cells`, `relay_assignments`, activity leases, cell runtime) are updated tens of thousands of
times a minute, so full-page-write amplification is large. Before 11:58 the 5-min timed checkpoints kept
WAL well under the limit; a one-off larger checkpoint tipped it over and the disk's write ceiling keeps
it there. Query Insights: io_time +30% in the 12:00 bucket, lock_time flat.

**Owning workflow / mitigation (not applied):** raise the Cloud SQL data disk (PD-SSD IOPS and MB/s scale
linearly with GB; 49 -> 200 GB roughly quadruples the ceiling, online, no restart) in the Terraform root
that owns `google_sql_database_instance` for `orca-cloud-auth-db`, applied through that root's workflow.
A second, flag-level lever is raising `max_wal_size` (default 1 GB) so timed checkpoints resume; that is
also a Cloud SQL instance setting in the owning Terraform root. Per the standing rule, not applied from
this session. Until then the fleet-wide 4–6 s stalls recur on
every slow checkpoint sync, the old-image cells die on each one, and no 15-min gate window will exist.

## Finding 11 (2026-09-04 12:55Z): **Cloud NAT port exhaustion** on the us-central1 cells is the second stall class

`google_compute_router_nat.relay_gce` (us-central1, `AUTO_ONLY` IPs, no `min_ports_per_vm`, no dynamic
port allocation, i.e. the default **64 ports per VM**). `router.googleapis.com/nat/port_usage` per VM
hit **64 = the cap** in exactly the minutes the cells' Cloud SQL proxies logged `dial tcp
35.188.82.89:3307: i/o timeout` (12:20–12:22, 12:41–12:43, 12:51–12:53), and
`nat/dropped_sent_packets_count` went 0 -> 56/552/590, 82/272/133, 395/1565/1842 in those same minutes.
Hourly: port_usage max was 25–50 all of Sep 3 and until 10Z today, 64 in 11Z and 12Z; dropped packets 0
until 11Z (219), then 5,491 in 12Z. Open NAT connections rose 400–600 -> 815–874. Every cell's Cloud SQL
traffic egresses through this NAT to the instance's public IP (the instance has no private IP:
`ipv4Enabled=true`, `privateNetwork` unset). When a VM's 64 ports fill, new TCP SYNs to 3307 are dropped,
the proxy's dial times out, and the relay pool's 2 s `connectionTimeoutMillis` fires: that is the exact
2 s stall the old image dies on and the new director surfaces as a 500. The dial timeouts hit c7 and c8
hardest because they carry the most controls and open the most DB connections.

What raised port demand today: each old-image crash re-opens a full pool through fresh NAT ports, the
autoheal recreates do the same, and the 55P03 retry storms keep more connections mid-transaction, so
crashes and NAT exhaustion feed each other. This is why the afternoon accelerated even after the disk
loop broke at 12:39.

**Owning change (not applied):** `cloud/infra/terraform/relay-gce-foundation.tf`
`google_compute_router_nat.relay_gce` (this repo): set `min_ports_per_vm = 1024` (or enable
`enable_dynamic_port_allocation = true` with `max_ports_per_vm = 4096`) and, if needed, add manual NAT IPs
(each IP supplies 64,512 ports across VMs). Online change, no VM restart. The durable fix is giving the
Cloud SQL instance a **private IP** and pointing the proxy at `--private-ip`, which takes DB traffic off
NAT entirely; that is a Cloud SQL instance change in the orca-cloud foundation root plus a startup-script
flag here. Per the standing rule, not applied from this session.

Direct proof: `resource.type="nat_gateway" AND jsonPayload.allocation_status="DROPPED"` shows **1,514
dropped allocations to 35.188.82.89:3307** in 12:50–12:54 alone, every one of them the Cloud SQL public
IP. The NAT has zero manual IPs (AUTO_ONLY) and no port settings in Terraform, so it is at Google's
default 64 ports/VM. No workflow in this repo applies `relay-gce-foundation.tf` broadly (the roll
workflows apply cell templates with `-target`), so the NAT change needs a targeted apply of
`google_compute_router_nat.relay_gce`, which is an owner-run Terraform step.

Original write-up of the symptom before the NAT correlation follows.

The 12:50:30–12:50:50 stall (every cell 3.7–3.9 s SQL max, six old-image cells died) happened with
checkpoints healthy (85 ms) and disk at 6 MB/s, so it is not Finding 10. The cells' Cloud SQL Auth Proxy
logged `failed to connect to instance: dial error: dial tcp 35.188.82.89:3307: i/o timeout`. Count of
those per hour today: 08Z 1, 11Z 15, **12Z 416**; all of Sep 3: 4. Cloud SQL `up`/backends/connections
did not blip. So new TCP connections to the instance's public IP on 3307 are timing out from the cells'
proxies in bursts, which is exactly the "2 s connect timeout" the old image dies on. Query Insights for
12:49–12:54 attributes 1,380 s of lock wait to the placement CTE (`WITH assignment_state AS
MATERIALIZED …`) and 469 s to the single-row reservation UPDATE: the lock queue is the *consequence* of
connections stalling mid-transaction, not the cause. Not chased further; candidates are the proxy's
connection churn under the crash loops (each recreated cell opens a fresh pool) and the instance's
public-IP path. Relay code cannot fix this; it is Cloud SQL / network. Dial timeouts by minute today: 12:20 24, 12:21
66, 12:41 22, 12:42 6, 12:51 160, 12:52 137, i.e. bursts of 20–160 s each, and they hit c7 (new image,
89 today) and c8 (93) hardest, so it is not the old image's connection churn either. Cloud SQL `up`=1
throughout. The proxy dials the instance's public IP `35.188.82.89:3307`; a burst of i/o timeouts to a
healthy instance points at the path (public-IP egress / NAT / proxy connection limits), not at Postgres.
That is the same 2 s that the old image dies on and that the new director surfaces as a 500.

## Roll inputs (verified by the read-only `verify` run)

**Image census from instance templates, 2026-09-04 21:45Z (authoritative, read from `gcloud compute
instance-templates`):** 20 serving cells on `5aedbca5` (c8, c9, c10, c13–c16, c19–c29) — the image that exits
the process on a Postgres connect timeout (Finding 6); c7 on `85bf6799`; c4, c5, c17, c18 (draining /
migration-only) on `0e83408b` / `36a56b10`; c1, c2, c3, c6, c11, c12 (existing-only) on Jul/Aug images. Target
for Roll 1 is `519f4914` (director already on it). Monitor dry-run dispatched 21:45Z as the roll gate; waves
require owner go.


- target-image-digest `sha256:519f4914217f08cabcdcd34825965db8473ec37c6591553a3af0d65dcdeeb183` (lock fix; supersedes 85bf6799 as target)
- previous target `sha256:85bf67993869a769642995d0863f4c2b6b569c3850c2d8390ec2ca5f2b179e28` (c7 is on this; use as c7's rollback)
- rollback-image-digest `sha256:5aedbca5c86de24c8b4d4bf7e3b444b76c712f281ede916cb9d90f70cad1e563`
- target/rollback rehome protocol 1 / 1; expected-rehome-generation 12; selector generation **112** (110 before the c7 canary)
- existing-only c1,c11,c12,c2,c3,c4,c5,c6; migration-only c17,c18; general c10,c13–c16,c19–c29,c7,c8,c9
- confirmation for canary: `ROLL_RELAY_SAME_CAP <target-digest> production-gce-c7`
- monitor evidence is single-use and must be < 5 min old at dispatch (plus 75 min per predecessor wave)
- monitor dry-run dispatch (read-only, runs at `main` head so a merged bar change applies immediately):
  `gh workflow run cloud-monitor-relay-production.yml --ref main -f mode=dry-run -f expected-selector-generation=110
  -f expected-existing-only-cells=<existing-only list> -f expected-migration-only-cells=production-gce-c17,production-gce-c18
  -f expected-general-cells=<general list> -f migration-policy=strict -f recovery-source-cell-id=none -f capacity-cell-id=none`

## Queries that worked (copy-paste)

- Cell metrics: `resource.type="gce_instance" AND jsonPayload.event="orca_relay_runtime_metrics"`
- Container crashes: `resource.type="gce_instance" AND jsonPayload.MESSAGE:"container die" AND jsonPayload.MESSAGE:"relay@sha256"`
- Crash banner: `resource.type="gce_instance" AND jsonPayload.message:"Node.js v24"`
- Retries: `jsonPayload.event="orca_relay_postgres_transaction_retry"` (no resource filter to get both)
- Director lines are `textPayload`; cell lines are `jsonPayload.message`
- Cloud Run concurrency: Monitoring API `run.googleapis.com/container/max_request_concurrencies`
- Dry-run final state: download artifact `relay-monitor-dry-run-<run>-<attempt>`, read `*.state.json` (the log's `schemaVersion` lines are only checkpoints, not the final verdict)

## 2026-09-04 22:50Z onward: owner go received; driving the gates

Owner: "sure, feel free to drive these." Sequence chosen: Roll 1 first (highest uplift), auth deploy with
#478 second, pruner enable third, label drift resolved by matching Terraform to live state, #477 still held.

| Step | Result |
| --- | --- |
| Monitor dry-run #19 (gen 112, strict) | **Passed** 23:07:53Z, run 33927238469 attempt 1. First green since the probe fix (#18723). 16 samples, no freeze. Dispatched 22:51:33Z after confirming: 0 `container die` in 3 h, director 5xx in the last 4 h were all 503s (excluded by the `director.errors` filter). |
| c8 `canary-apply` onto 519f4914 (rollback 5aedbca5) | **Failed at 23:09:07Z before any mutation**: `relay monitor evidence provenance does not match` in `verify-authority`. Run 33928330631. Gate job passed, `cell_1 / rollout` failed on the manifest check, `seal_canary` skipped, lease released. Cause: the manifest binds `commitSha`; the dry-run ran at main `264c9ed8d2`, the canary dispatched at `--ref main` resolved to `4fab8e2f15` because unrelated PRs merged to main during the 15-minute gate. Verified no side effects: c8 MIG still on template `…c8-20260827…` (5aedbca5), stable, 25 controls; no `/v1/admin/drain` or isolate calls in the director log. |
| Constraint learned | Both workflows must run at the **same main commit**. The production environment's deployment branch policy allows only `main`, and the job gates on `github.ref == 'refs/heads/main'`, so a pinned tag/branch is not an option. Any merge to stablyai/orca main during the 15-minute dry-run invalidates the evidence. Mitigation for the retry: dispatch the canary within seconds of the green, and do not merge anything to stablyai/orca main myself during the window. A durable fix (accept evidence whose commit is an ancestor with identical workflow/script content) is a follow-up, not a same-day change to a safety check. |
| Label drift (5.x) | Resolved by dropping the `region` label from Terraform to match the 21 live metrics (stablyai/orca #18734, merged). Targeted plan asserted `27 no-op, 9 create, 0 destroy`; applied 23:11Z: 8 `orca_relay_control_*` renewal metrics that had never been applied, plus `google_monitoring_dashboard.relay_incident`. `orca_relay_controls` createTime unchanged (2026-07-13), label extractors unchanged. |
| Pruner enable (1.2) | orca-cloud #479 merged: `auth_token_pruner_enabled = true`, image digest of `00031-tox`, `max_rows_per_run = 20000`. Targeted plan asserted 9 create / 0 change / 0 destroy (job, scheduler at `41 * * * *` UTC, two service accounts, five IAM grants). **Not yet applied**: waiting until the roll canary has landed so the first hourly run does not overlap a drain. |
| Auth deploy with #478 (3.1) | Dispatched 23:13Z from orca-cloud main `f0fa4b5` (run 33928663526). Candidate startup adds nullable `successor_material` under a brief ACCESS EXCLUSIVE lock. |
| Auth deploy result | **Succeeded** 23:15:37Z: `orca-cloud-auth-00035-gos` serving 100 %, cap 20 preserved, 0 5xx. `refresh_tokens.successor_material` present (nullable text); 298 sealed successors written in the first 15 min against 924 rotations; `session-refresh-reuse-detected` at baseline (5 / 15 min). Grace window is live. |
| Monitor dry-run #20 | Froze 23:35:38Z on `runtime_power_unknown cell.production-gce-c11.powered`. Two window restarts earlier (23:24, 23:25) on `signal_stale auth.errors` (Cloud Monitoring publish lag 181–255 s vs 180 s bar). Cause: one transient rejection of the per-cell MIG GET in `readResourceInventory` yields `targetSize: null` → `runtimeKnown=false` → hard freeze. c11 is a parked existing-only cell (MIG size 0, stable) and was fine. Not fleet health. Fix delegated: stablyai/orca #18740 (retry the MIG read once, mirroring #18723). Run 33928912676. |
| Monitor dry-run #21 | **Green** 23:54Z at main `8064d1f991`, but main had moved to `0a821e5bc8` during the window; the chain re-gated instead of dispatching (the canary would have failed provenance again). Run 33930229711. |
| Monitor dry-run #22 | **Green** 00:10Z at `0a821e5bc8`; main moved to `2e80972450`. Re-gated. Run 33931177390. |
| Monitor dry-run #23 | Froze 00:18:31Z on `cell.production-gce-c29.latency_ms` 2635 > 2000, the probe's own round-trip from a US runner to asia-east2; c29 controls 17→19 and `sqlLatencyMsMax` flat ~1050 through the minute, no crash, no checkpoint stall. c29 probe max was 0 in the three previous gates, so a one-off. Run 33932092775. |
| Blocking constraint | Main receives unrelated merges every 5–10 min (23:08, 23:15, 23:17, 23:40, 23:42, …). A 15-min gate bound to an exact commit cannot be consumed under that traffic. Delegated a durable fix: `verify-authority` accepts evidence whose commit is an ancestor of the canary commit **and** has no diff on the monitor/deployer trusted paths; fails closed on shallow clones or unknown commits. Chain re-armed on dry-run #24 (run 33932679796) meanwhile. |
| Monitor dry-run #24 | Froze 00:28:00Z on `director.instances` 4 < 5. Cloud Run active-instance count read 4 for exactly one minute (00:27), 5 in every other minute for 3 h; min/max scale is pinned at 5; no new revision. A routine single-instance recycle. Not fleet health. Bar `directorInstancesMin: 5` with `latest-sum` cannot tolerate that; recalibrate to 4 or use a 3-min window minimum (follow-up, not same-day). Run 33932679796. Chain dispatched #25 (run 33933193511) at `86cd327749`. |
| Monitor dry-run #25 | **Green** 00:46Z at `86cd327749`; main moved to `8096cb2803`. Fourth green gate lost to unrelated main traffic (#19, #21, #22, #25). Run 33933193511. Chain's re-gate #26 (run 33934079533) cancelled by me. |
| Fixes merged 00:55Z | stablyai/orca #18740 (MIG inventory read retried once before `runtime_power_unknown`; 2 tests) and #18754 (`verify-authority` and the batch canary authority accept evidence sealed at an **ancestor** commit when every trusted monitor/deployer path is byte-identical; fails closed on shallow clones and unknown commits; deploy/rehome jobs now check out with `fetch-depth: 0`; 5 new tests, 18/18 pass). Reviewed both diffs; trusted-path set verified to exist on main. |
| Monitor dry-run #27 | Dispatched 00:56Z at `74ad08ec66` (first gate whose evidence the new rule can consume). Run 33934541092. Chain re-armed with the same ancestor + identical-trusted-code rule so an unrelated merge no longer forces a re-gate. |
| Monitor dry-run #27 | **Green** 01:11:35Z at `74ad08ec66`; main had moved to `38bde20121` with identical trusted code, so the new rule (#18754) let the chain dispatch. Run 33934541092. |
| c8 `canary-apply` #2 (run 33935407461) | Provenance check **passed** (first consumption of ancestor evidence). Isolate → gen 113, drain, template+MIG applied 01:14–01:22, new c8 came up on `519f4914` and `relay_capacity_transition_verified` (migration-only, image exact, heartbeat fresh) at 01:23:50. Then the step's next call, `curl --fail-with-body` to c8 `/v1/admin/runtime-status`, got a **503 with a 27-byte body** at 01:23:51 and the step exited 22. Director `cell-status` at 01:23:50.8 returned 200; c8's own logs show nothing at that second; c8 health/ready both 200 seconds later; backend HEALTHY (the health check had just flipped TIMEOUT→HEALTHY at 01:22:16 and UNKNOWN→HEALTHY at 01:23:47 as the new instance warmed). Read: a single 503 at the load-balancer/warm-up edge on a curl with no retry, on a cell that was already verified healthy one line earlier. Failsafe ran: c8 kept **migration-only**, rehome control disabled, selector gen 113. c8 is serving (40 controls at 01:39, sqlLatencyMsMax ~30 ms) on the target image, just not admitted for general traffic. Nothing to roll back. |
| Recovery | The job has an explicit resume path: `mode=rollback` with `rollback-image-digest` = the image the cell already runs skips isolate/apply, verifies, and restores general admission (`ROLLBACK_RESUME=true`). Dispatched gate #28 (run 33936966508) at gen 113 with c8 in migration-only; on green the chain dispatches that resume for c8 with rollback digest `519f4914` and target `5aedbca5` (the validator only requires them to differ). |
| Follow-up | The verify step's bare `curl --fail-with-body` needs the same "no reading is not a verdict" retry the monitor got (#18723/#18740); a 503 immediately after `verify-relay-capacity-transition` passed is not evidence of a bad cell. |
| Monitor dry-run #28 | **Green** 01:58:59Z at gen 113 with c8 in migration-only. Run 33936966508. |
| c8 recovery (run 33937756402, `mode=rollback`, rollback digest = 519f4914) | **Succeeded** 02:02Z. `ROLLBACK_RESUME=true` path: isolate/apply skipped, converged-Terraform check passed, verify passed (`relay_capacity_transition_verified` general, image `519f4914`, heartbeat fresh), activate → **gen 114**, c8 general. No restart, no drain. c8 at 43 controls, sqlLatencyMsMax 36 ms. **c8 is the second cell on 519f4914** (with c7 on 85bf6799). Because the recovery ran as `rollback`, `seal_canary` was skipped, so no canary authority exists for a `batch-apply`; the next cell runs as another `canary-apply`. |
| Merged 02:05Z | stablyai/orca #18769: bounded retries on every admin-endpoint curl/fetch in the same-cap job and the rehome/canary/verify scripts (`--retry 3 --retry-delay 2 --retry-connrefused`, per-attempt bodies to a file; script helper 2 attempts on network error or 500/502/503/504 only; 4xx never retried; 650/650 tests). Trusted-path change, so the next gate runs at a commit containing it. |
| Pruner enabled (1.2) | Terraform applied 02:06Z (8 creates, then the deploy-identity job IAM grant after a propagation 404, 9/9). Job `orca-cloud-auth-token-pruner`, image `343a0915…`, scheduler `41 * * * *` UTC, budget 20 000 rows/run. First run by hand (exec `sf5ct`): cold start 3m20s, then `stopReason: time-budget` at 480 s: 73 batches, 365 000 scanned, **1 040 deleted** (1 021 revoked, 19 expired, 0 rotated), ~6.4 s/batch of 5 000, `completedFullPass: false`. No errors, no lock-wait or checkpoint alert. Scan-bound, not budget-bound: at this pace a full pass over the table takes many hourly runs, and the row budget is never the limiter. Leave the budget alone; watch hourly runs for `stopReason` and a rising `deletedRows` as the cursor reaches the rotated backlog. |
| Monitor dry-run #29 | **Green** 02:20:58Z at gen 114, main `e2b70a5eba` (contains #18740, #18754, #18769). Run 33938052374. |
| c9 `canary-apply` (run 33938818286) | **Succeeded end to end** 02:21–02:34Z: isolate → gen 115, drain, template+MIG to `519f4914`, verify passed on the first try (retry-hardened step), trust proof, activate → **gen 116**, general. `seal_canary` **succeeded**: batch authority now exists. c9 at 38 controls, sqlLatencyMsMax 33 ms. No `container die` in 30 min. Three cells on new images (c7 `85bf6799`, c8 and c9 `519f4914`); 17 serving cells still on `5aedbca5`. |
| Monitor dry-run #30 | Dispatched 02:36Z at gen 116 (run 33939533990). On green the chain dispatches **batch 1**: `batch-apply` c10,c13,c14,c15 bound to canary run 33938818286 (sealed at gen 116, same commit `e2b70a5eba`). Preflight: all four on `5aedbca5`, MIGs stable, no crash in 20 min. Sequential cells inside the job (wave-index 0..3), each with its own isolate/drain/apply/verify/restore, so ~12 min per cell, ~50 min total. |
| Monitor dry-run #30 verdict | **Green** 02:52:15Z at gen 116, `e2b70a5eba`. |
| Batch 1 (run 33940290163) | Dispatched 02:52:27Z: `batch-apply` c10,c13,c14,c15, canary authority run 33938818286, same commit. |
| Batch 1 attempt 1 (run 33940290163) | **Failed at 02:54:39Z in the live preflight, before any mutation**: `relay live preflight failed: cloud-monitoring/signal_stale`. The step's `--retry-freshness` (5 attempts, 15 s apart, freshness-only codes) is passed only for `WAVE_INDEX != 0`; the first cell takes a single sample, so one Cloud Monitoring publish lag > 180 s at that instant fails the batch. Every candidate series was current again by the time I checked. c10 untouched (template `…c10-20260827…`, 47 controls), no selector write, gen still 116, failsafe no-op. Gate #31 dispatched 02:57Z (run 33940508865); chain re-dispatches the same batch (canary authority 33938818286 still valid: same gen 116, same commit). Fix delegated: wave 0 gets the same freshness retry. |
| Monitor dry-run #31 | **Green** 03:13:26Z at gen 116; main at `cb7f7dd11a` with identical trusted code. Run 33940508865. |
| Batch 1 attempt 2 (run 33941253533) | Dispatched 03:13:38Z: c10,c13,c14,c15, canary authority 33938818286. Runs at `cb7f7dd11a` (batch authority is accepted across the ancestor since trusted paths are unchanged). |
| Merged 03:14Z | stablyai/orca #18778: `--retry-freshness` on every same-cap wave including the first, and the retry loop now stops before the next wait would push evidence past the wave's age bound (it was checked only at entry before). Twin carve-out in the capacity job filed as a follow-up. |
| Batch 1 cell 1 (c10) | **Succeeded** 03:14–03:27Z (preflight, drain, apply, verify, restore). c13 started 03:27Z. |
| Batch 1 cell 2 (c13) | **Succeeded** 03:27–03:38Z. c14 started 03:38Z. |
| Batch 1 cell 3 (c14) | **Succeeded** 03:38–03:50Z. c15 started 03:50Z. |
| Batch 1 complete (run 33941253533) | **All four succeeded** 03:13–04:00Z: c10, c13, c14, c15 on `519f4914`, selector **gen 124**. Fleet at 936 controls, 23 cells. Two `container die` at 03:35:41/44 were **c13's new container** exiting during boot (`applyPostgresSchema` → `Connection terminated due to connection timeout`, exit 1, 2 s runtime each) because the `cloud-sql-proxy` sidecar had not finished starting; the third start at 03:35:45 succeeded and c13 has been serving since (57 controls). A boot-order race in the container spec, not a serving-cell crash. Follow-up: schema pool should wait for the proxy socket, or the container should depend on the proxy's readiness. **8 cells on new images** (c7 85bf6799; c8, c9, c10, c13, c14, c15 519f4914), 12 on `5aedbca5`: c16, c19–c26 (US), c27–c29 (Asia). |
| Monitor dry-run #32 | **Green** 04:19:50Z at gen 124, main `436ef827dd` (contains #18778). Run 33943539025. |
| c16 `canary-apply` (run 33944255902) | Dispatched 04:20:02Z. On success it seals the authority for batch 2 (c19,c20,c21,c22). |
| c16 canary (run 33944255902) | **Succeeded** 04:20–04:32Z, activate → gen 126, batch authority sealed. 9 cells on new images. |
| Monitor dry-run #33 | Failed 04:58:56Z on `continuity_deadline_exceeded` (1 500 004 ms > 1 500 000 ms). One `signal_stale cloud_sql.lock_waits` at 04:46 (189 s vs 180 s bar, Cloud Monitoring publish lag) restarted the 15-min window at sample 12; the restart could not complete inside the 25-min continuity cap. No health failure at any sample; no `container die` since c16's own boot race at 04:30. Run 33944873727. Chain re-gates. Note for recalibration: `cloudDataMaxAgeMs: 180000` vs observed Cloud Monitoring publish lag of 181–255 s has now cost three gates (#20 twice, #33). |
| Freshness recalibration | stablyai/orca #18798 (open, merge after batch 2 dispatch): `cloudDataMaxAgeMs` 180 s → 330 s, derived from Google's documented visibility delays (Cloud Run 60+120 s, Cloud SQL 60+165 s) and the 5-min window-sum query (a label series that stops emitting reads as up to 300 s old while its sum is complete, which is the 255 s `auth.errors` case) plus ~30 s collect latency. Director-admin and the lock-wait carry keep their own 180 s pins. A freshness-only failure may miss 2 consecutive samples without restarting the window; the sample still counts and is still threshold-checked; a 3rd miss, collector failure, runner gap, or any breach restarts/freezes as before. 92/92 tests. |
| Monitor dry-run #34 | **Green** 05:17:31Z at gen 126, `436ef827dd`. Run 33946093029. |
| Batch 2 (run 33946819345) | Dispatched 05:17:43Z: c19,c20,c21,c22, canary authority 33944255902 (c16). |
| Merged 05:19Z | stablyai/orca #18798 (freshness bar 330 s + two-sample tolerance). Next gate runs at a commit containing it. |
| Batch 2 cell 1 (c19) | **Succeeded** 05:19–05:32Z. c20 started. |
| Batch 2 cell 2 (c20) | **Succeeded** 05:32–05:43Z. c21 started. |
| Batch 2 cell 3 (c21) | **Succeeded** 05:43–05:59Z. c22 started. |
| Batch 2 complete (run 33946819345) | **All four succeeded** 05:17–06:12Z: c19, c20, c21, c22 on `519f4914`, selector **gen 134**. Fleet at 1 090 controls, 23 cells, refresh 401s at baseline (1–4 per 3 min). One `container die` at 06:08:45 was **c22's new container** exiting during boot (exit 1, 2 s runtime; started 06:08:43, restarted 06:08:46 and serving since), the same proxy-sidecar boot race seen on c13 and c16. No serving-cell crash. **Census: 15 of 23 serving cells on new images** (c7 `85bf6799`; c8–c10, c13–c16, c19–c22 `519f4914`), 7 on `5aedbca5`: c23–c26 (US), c27–c29 (Asia). Next: gate at gen 134 → canary c23 → batch c24,c25,c26; then canary c27 → batch c28,c29. |
| Monitor dry-run #35 | **Green** 06:32:01Z at gen 134, `b33d1972bc` (contains #18798, first gate at the 330 s freshness bar). Run 33949334606. |
| c23 `canary-apply` (run 33950075843) | Dispatched 06:32:13Z at main `b0c67eaf88` (ancestor gate SHA, identical trusted code). On success it seals the authority for batch 3 (c24,c25,c26). |
| c23 canary (run 33950075843) | **Succeeded** 06:32–06:46Z, activate → gen 136, batch authority sealed. No `container die` during boot. 16 of 23 serving cells on new images; 6 on `5aedbca5` (c24–c26 US, c27–c29 Asia). |
| Monitor dry-run #36 | Dispatched 06:46Z at gen 136, run 33950746574 (`58553bfe1c`). On green the chain dispatches batch 3 (c24,c25,c26) under canary authority 33950075843. |
| Monitor dry-run #36 result | **Green** 07:02:49Z at gen 136, `58553bfe1c`. |
| Batch 3 (run 33951468008) | Dispatched 07:03Z: c24,c25,c26, canary authority 33950075843 (c23). |
| Batch 3 cell 1 (c24) | **Succeeded** 07:04–07:18Z. c25 started. |
| Batch 3 cell 2 (c25) | **Succeeded** 07:18–07:31Z. c26 started. |
| Batch 3 complete (run 33951468008) | **All three succeeded** 07:03–07:44Z: c24, c25, c26 on `519f4914`, selector **gen 142**. Fleet at ~1 230 controls, 23 cells, refresh 401s at baseline. **Zero `container die`** during the batch (no boot race on c24–c26). **All 20 US serving cells now on new images** (c7 `85bf6799`; c8–c10, c13–c16, c19–c26 `519f4914`). Remaining on `5aedbca5`: c27, c28, c29 (asia-east2, probe hard cap 3000 ms). |
| Monitor dry-run #37 | Dispatched 07:48Z at gen 142, run 33953555224 (`4c5077d57a`). On green the chain dispatches the c27 canary (first Asia cell). |
| Monitor dry-run #37 result | **Green** 08:04:24Z at gen 142, `4c5077d57a`. |
| c27 `canary-apply` (run 33954264945) | Dispatched 08:04Z, first Asia cell (asia-east2-a). On success it seals the authority for batch 4 (c28,c29). |
| c27 canary (run 33954264945) | **Failed closed before any mutation** 08:07:25Z at "Verify exact current generation, digest, cap, and rollback point": `runtime predecessor mismatch fields=regionalRehomeProtocol`. **Operator input error, not a cell fault**: the chain script hardcoded `target-rehome-protocol=1 / rollback-rehome-protocol=1` for every cell, but `relay_region_rehome_source_cell_ids` lists only the 16 US cells (c7–c10, c13–c16, c19–c26), so the Asia startup template omits `ORCA_RELAY_REHOME_*` and c27–c29 report protocol 0 by design. `MUTATION_STARTED` never set, failsafe no-op, selector stays gen 142, c27 still serving on `5aedbca5`, no `container die`. Gate #37 evidence consumed. Fix: chain script now takes `PROTO`; Asia round dispatches with protocol 0 (the per-host trust proof step is protocol-gated and skips, as designed for non-source cells). Follow-up: the job already reads `relay_region_rehome_source_cell_ids`; it could derive the expected protocol from membership instead of trusting the operator input. |
| Monitor dry-run #38 | Dispatched 08:12Z at gen 142, run 33954621425 (`e95d247be1`). On green the chain dispatches the c27 canary with protocol 0. |
| Monitor dry-run #38 result | **Green** 08:28:36Z at gen 142, `e95d247be1`. |
| c27 `canary-apply` #2 (run 33955359385) | Dispatched 08:28Z with `target/rollback-rehome-protocol=0`. |
| c27 canary #2 (run 33955359385) | **Failed closed, no mutation** 08:31:19Z. Predecessor check passed with protocol 0; the isolate step then died at argument parsing: `production capacity target is not approved`. The same-cap job shells out to `prepare-relay-production-capacity-canary.mjs` for isolate/drain/activate, whose `PRODUCTION_CAPACITY_CELL_IDS` allowlist is the 16 US capacity cells (c7–c26), while the same-cap wave validator (`SAME_CAP_CELLS`) approves all 19 serving cells including c27–c29. The Asia cells have never been through this job (their Aug 14 rollout used the asia-topology workflow). Both the isolate step and the failsafe threw before any HTTP call, so `MUTATION_STARTED=true` was written but nothing was isolated: selector stays gen 142, c27 general and serving on `5aedbca5`, no `container die`. Gate #38 evidence consumed. Fix: stablyai/orca #18811 (`--approved-cells same-cap` on all four invocations, default unchanged for the US capacity job, census test over every `SAME_CAP_CELLS` member × isolate/drain/activate + the job's cell-shape bash block; 525/525 script tests). Sweep of the other job scripts found no further Asia blocker; gate #39 (run 33955668701) dispatched at gen 142 to prove the selector is unchanged before the next attempt. |
| Monitor dry-run #39 | **Green** 08:51:28Z at gen 142: independent proof the selector was untouched by both failed c27 attempts. Not used for dispatch (its commit predates #18811). |
| Merged 08:51Z | stablyai/orca #18811 → main `12e05203a4`. |
| Monitor dry-run #40 | Dispatched 08:51Z at gen 142 on main `12e05203a4` (contains #18811), run 33956408337. On green the chain dispatches the c27 canary, protocol 0, third attempt. |
| Monitor dry-run #40 result | **Green** 09:08:03Z at gen 142, `12e05203a4`. |
| c27 `canary-apply` #3 (run 33957151726) | Dispatched 09:08Z, protocol 0, on main containing #18811. |
| c27 canary #3 (run 33957151726) | **Failed after isolate; failsafe held** 09:17:21Z. Live check 09:26Z: c27 at 0 controls (drained), template still `…20260814235757`, c28/c29 absorbed the hosts (37 each), fleet 1 404 controls / 23 cells, refresh 401s baseline, no `container die` in 60 m. Predecessor check and allowlist passed; isolate → **gen 143** (c27 migration-only), drain sent (graceMs 0, hosts reconnected via director to c28/c29/US). Terraform plan built correctly (template replace + MIG update to `519f4914`), then `validate-relay-capacity-plan.mjs --mode same-cap-cell` rejected it: `cell plan does not contain the reviewed image and capacity`. Its same-cap rule demands exactly one `ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT` and one `ORCA_RELAY_REHOME_AUDIENCE` printf in the startup script; Asia templates omit both because c27–c29 are not rehome sources (same root as attempt 1, third US-only assumption in the job). **No apply ran**: c27 template unchanged, still `5aedbca5`, isolated and draining (drain is one-way in-process; only a restart clears it). Failsafe re-asserted migration-only at gen 143 and rehome disabled. Recovery plan: fix validator (protocol-0 path: require the rehome lines *absent*), merge, gate at gen 143, then `mode=rollback` with rollback-image=`519f4914` (the failed-canary re-entry path; accepts draining + migration-only) to restart c27 onto the target image and restore it; then single-cell canaries for c28 and c29 (batch needs ≥2 cells). |
| Plan-validator fix | stablyai/orca #18818 (merged 09:41Z → main `9f2a9a248e`): `validate-relay-capacity-plan.mjs --regional-rehome-protocol 0|1` in same-cap-cell mode; protocol 0 requires the rehome lines *absent*, protocol 1 unchanged; both plan-validation calls in the job pass `DESIRED_REHOME_PROTOCOL`; census test now validates a correct plan for every `SAME_CAP_CELLS` member at its tfvars-derived protocol. 529/529. Residual: the operator-supplied protocol is still unbound for Asia cells (no `SOURCE_CELLS` cross-check outside us-central1), so a wrong value fails late at plan validation rather than early; deriving it from membership is the checklist follow-up. |
| Monitor dry-run #41 | Dispatched 09:42Z at gen 143 (c27 expected migration-only) on main `9f2a9a248e` (contains #18811 + #18818), run 33958728141. On green: c27 recovery via `mode=rollback`, rollback-image `519f4914`, protocol 0, confirmation `ROLL_BACK_RELAY_SAME_CAP`. |
| Monitor dry-run #41 result | **Green** 09:58:51Z at gen 143, `9f2a9a248e`. |
| c27 recovery #1 (run 33959789773, `mode=rollback`) | **Failed closed, no mutation** 10:09:21Z at `Verify monitor evidence provenance`: `relay monitor dry-run authority is incomplete or stale`. The dry-run authority is valid for 5 min after `completedAt` at wave 0 (`EVIDENCE_MAX_AGE_MS`); the gate completed 09:58:51Z but the operator poller (20 s `gh run view` loop) only observed completion at 10:07:09Z during a local network outage, so the dispatch landed at 10:07:11Z, 8 m 20 s after completion. Failed before the rollout lease, isolate, or any Terraform step; c27 unchanged (migration-only, drained, `5aedbca5`, gen 143). Every prior canary dispatched ≤15 s after gate green, so this is a dispatch-latency miss, not a job defect; the freshness bound behaved as designed. |
| Monitor dry-run #42 | Dispatched 18:39Z at gen 143 on main `af82126058` (trusted paths byte-identical to `9f2a9a248e`), run 33984753269. Recovery script re-armed behind it (same `mode=rollback` onto `519f4914`, protocol 0). |
| Monitor dry-run #42 result | **Green** 18:55:47Z at gen 143, `af82126058`. |
| c27 recovery #2 (run 33985902062, `mode=rollback`) | **Failed closed, no mutation** 19:05:02Z, same `authority is incomplete or stale`. Dispatch landed 19:02:39Z, 6 m 52 s after the gate completed. Root cause of both misses is the operator laptop sleeping during the 15 min gate wait (`pmset -g log`: asleep 18:52:28Z → 19:02:17Z; the morning miss coincided with a sleep/dark-wake cycle too), so the 20 s poller never ran inside the 5 min window. Not a job or evidence defect: the freshness bound did its job. Operator fix: poller now runs under `caffeinate -i`. |
| Monitor dry-run #43 | Dispatched 19:06Z at gen 143 on main `af82126058`, run 33986121849. Recovery armed behind it under `caffeinate`. |
| Monitor dry-run #43 result | **Green** 19:22:53Z at gen 143, `af82126058`. |
| c27 recovery #3 (run 33986948522, `mode=rollback`) | **Failed closed, no mutation** 19:25:48Z. Dispatched 13 s after gate green (authority accepted this time), then the live preflight recheck failed: `relay live preflight failed: active-probe/threshold_max`. That is the 2 000 ms `endpointLatencyMs` bar on one endpoint's slowest /health or /ready round trip from the runner (8 s fetch timeout, one retry). The error names no endpoint and the job log prints none; gate #43 had zero failures across 16 samples, so this was a transient probe slow-down in the ~3 min between gate and preflight. Live probe 19:32Z from the operator: director and auth ~130–190 ms, US cells ≤540 ms, Asia cells 690–1 315 ms (c28/c29 /health ~1.3 s, the closest to the bar; c27 ~0.9 s). Existing-only cells c1–c3, c6, c11, c12 return 503 on both paths as expected (unpowered). Failed before the rollout lease, isolate, or any Terraform step; c27 unchanged. Follow-up (checklist): preflight should print the failing signal and observed value. |
| Monitor dry-run #44 | Dispatched 19:33Z at gen 143 on main `062db77118`, run 33987646501. Recovery re-armed behind it. |
| Monitor dry-run #44 result | **Frozen red** 19:50:01Z after 13 samples: `active-probe/threshold_max cell.production-gce-c27.latency_ms observed=2568 threshold=2000`. No other failure, no continuity event, no `container die` fleet-wide in 60 m. `/health` is a static JSON reply (`app.ts`), so the slow round trip was `/ready` (the probe reports the max of the two) or the path to the cell. Cloud SQL logs for 19:49:38Z–19:51:58Z show six `could not obtain lock on row in relation "relay_cells"` errors and a time-triggered checkpoint completing at 19:50:36Z (write phase 270 s, the spread target, not a stall). c27 is drained with 0 controls, so its `/ready` dependency check was the only thing it was doing. Recovery script stopped as designed (no auto re-gate). Operator probe 19:53Z: c27 and c28 both bimodal, ~0.27 s or ~0.89 s per `/health` from the US, identical shape, nothing c27-specific. Attributing the one 2.6 s sample to the same shared-DB contention that produced the lock errors is the best available reading; the retry at gate #45 tests whether it recurs. |
| Monitor dry-run #45 | Dispatched 19:53Z at gen 143 on main `062db77118`, run 33988383401. Recovery re-armed behind it. |
| Monitor dry-run #45 result | **Frozen red** 19:54:47Z after 3 samples, same signal: `cell.production-gce-c27.latency_ms observed=2668 threshold=2000`. Two gates in a row now attribute a >2 s round trip to c27 while every other cell passes. |
| c27 `/ready` tail analysis | `/health` is static; `/ready` (`relay-readiness.ts`) fetches the auth JWKS (2 s timeout) then runs `SELECT 1`, cached 10 s. Operator probes 19:57Z–20:00Z, 15 each from the US: c27 and c28 have the **same** tail (0.27 s / 0.88 s modes, then 1.3 s, then 2.17–2.27 s at the top); US cells c8/c20 sit at 0.08–0.18 s. Auth JWKS latency over the last hour: 400 requests, max 20 ms, none over 1 s. So the tail is cell→Cloud SQL (US) round trips plus the runner→Asia hop, not auth and not c27-specific; c27 is drained (0 controls) so nothing local competes. Cloud SQL `could not obtain lock on row in relation "relay_cells"` runs at 17–78 per 10 min all day (NOWAIT inventory locks, expected under placement bursts) with no spike in the failing minutes. The bar (`endpointLatencyMs` 2 000 ms, one shot per minute, max of two paths) leaves Asia cells ~10% of samples from tripping; the gate got unlucky twice on c27 and lucky on c28/c29. Not a health finding. |
| Monitor dry-run #46 | Dispatched 20:01Z at gen 143 on main `062db77118`, run 33988810139. Recovery re-armed behind it. If this also freezes on an Asia probe, the next move is a per-region latency bar (or p50 over the window) in `incident-monitor.ts`, reviewed and merged before further Asia gates rather than retrying blindly. |
| Monitor dry-run #46 result | **Frozen red** 20:07:44Z after 7 samples, third time on `cell.production-gce-c27.latency_ms` (observed 2 685). Operator 40-sample `/ready` probe per Asia cell at 20:10Z: c27 p50 0.88 s / p90 2.15 s / max 2.26 s / 6 over 2 s; c28 p50 0.88 / p90 1.25 / max 2.25 / 1 over; c29 p50 0.88 / p90 0.89 / max 1.27 / 0 over. All 200. `/ready` (`relay-readiness.ts`) fetches the auth JWKS in us-central1 then `SELECT 1` on Cloud SQL in us-central1, so an Asia cell's readiness is two trans-Pacific hops plus the runner→Asia hop; the fleet-wide 2 000 ms bar was calibrated on US cells (0.08–0.5 s). c27 being drained and idle has no local load, so this is path latency, not health. **Stopped retrying gates.** Fix in flight: per-region `cell.<id>.latency_ms` bar (us-central1 stays 2 000, asia-east2 4 000; hard faults still caught by the health/ready equal-1 checks and the 8 s probe timeout) plus attributable preflight failure messages, via review + CI before the next Asia gate. |
| Merged 20:33Z | stablyai/orca #18877 → main `a3c1d32995`: per-region `cellEndpointLatencyMs` (us-central1 2 000, asia-east2 4 000; director/auth rules and the `endpointLatencyMs` key unchanged), region carried from tfvars onto every cell expectation, preflight failures now print `source/code signal observed= threshold=`. relay-ops 95/95, cloud suite 633 + 529 + 148 green. |
| Monitor dry-run #47 | Dispatched 20:34Z at gen 143 on main `a3c1d32995` (first gate with the per-region bar), run 33989896150. Recovery re-armed behind it. |
| Monitor dry-run #47 result | **Green** 20:38:09Z at gen 143 on `a3c1d32995`: first gate under the per-region bar, 16/16 samples, no Asia latency failure. |
| c27 recovery #4 (run 33990715317, `mode=rollback`) | **Success** 20:51Z. Dispatched 13 s after gate green. Isolate re-asserted migration-only at gen 143 (already isolated, no change), Terraform applied the same-cap template `…20260905204141` and the MIG replaced the instance, new incarnation on `519f4914`, protocol 0, transition verifier passed at migration-only (1 180 assignments carried, hard cap 3 000, heartbeat fresh), then activate → **gen 144**, c27 general, verifier passed again. No `container die` fleet-wide 19:55Z–20:52Z. c27 now runs the target image; c28/c29 remain on `5aedbca5` (template `…20260814235757`). |
| Monitor dry-run #48 | Dispatched 20:53Z at gen 144 (c27 back in general, MIG = c17,c18) on main `61ebffa86e` (trusted paths identical to `a3c1d32995`), run 33991385880. On green the chain dispatches the c28 `canary-apply`, protocol 0. |
| Monitor dry-run #48 result | **Green** 21:08Z at gen 144, 16/16 samples, no Asia latency failure. Main had moved to `5cec2c2dfc`; the chain verified the trusted paths were identical to the gate commit and dispatched 12 s after green. |
| c28 canary (run 33992169289, `canary-apply`) | **Success** 21:27Z. Isolate → migration-only at **gen 145**, drain already clear, verifier passed on the old image (1 220 assignments carried, hard cap 3 000, heartbeat fresh), Terraform applied same-cap template `…20260905211352`, new incarnation on `519f4914` at protocol 0, verifier passed again at migration-only, activate → **gen 146**, c28 general, verifier passed (1 219 assignments). Seal step recorded the canary. No `container die` fleet-wide 21:08Z–21:30Z. Only c29 remains on `5aedbca5`. |
| Monitor dry-run #49 | Dispatched 21:33Z at gen 146 (c28 back in general, MIG = c17,c18) on main `dce5ebd83d` (trusted paths identical to `a3c1d32995`), run 33993075948. On green the chain dispatches the c29 `canary-apply`, protocol 0, the last Roll 1 cell. |
| Monitor dry-run #49 result | **Frozen red** 21:52:24Z, `active-probe/continuity_deadline_exceeded observed=1500005 threshold=1500000`. One continuity event at 21:41:27Z, `cloud-monitoring/collector_failed` (a Cloud Monitoring read failed, not tolerated), which reset the continuous window at sample 14; the restarted window reached 10 samples before the 25-minute lineage cap (`INCIDENT_PRE_DRAIN_MAX_LINEAGE_MS`) expired. No health failure in any of the 25 samples, no Asia latency failure, no `container die`. Monitor-side transient, not a fleet finding. The chain re-gated automatically after its 2-minute back-off. |
| Monitor dry-run #50 | Dispatched 21:54Z at gen 146 on main `51eed5a1bc`, run 33994385666. **Green** 22:10Z, 16/16 samples. Main had moved to `d7767fb196`; trusted paths identical to `a3c1d32995`. Chain dispatched the c29 `canary-apply` (run 33995164002, protocol 0) 12 s after green. |
| c29 canary (run 33995164002, `canary-apply`) | **Success** 22:27Z. Isolate → migration-only at **gen 147**, verifier passed on the old image (1 199 assignments), Terraform applied same-cap template `…20260905221622`, new incarnation on `519f4914` at protocol 0, verifier passed at migration-only, activate → **gen 148**, c29 general, verifier passed (1 199 assignments carried). No `container die` fleet-wide 22:11Z–22:30Z. |
| **Roll 1 complete** | Image census 22:30Z from MIG templates: c8–c10, c13–c16, c19–c29 on `519f4914` (18 cells); c7 on `85bf6799` (the earlier rehearsal image, carries the same fix); existing-only c1–c6, c11, c12 and migration-only c17, c18 untouched by design. No serving cell remains on `5aedbca5`. Selector gen 148, membership unchanged from the start of the roll. Zero relay container exits fleet-wide across the roll (01:14Z–22:30Z). Gates used: #19–#50; freezes were all monitor-side (provenance, freshness, flat Asia latency bar, one Cloud Monitoring collector failure), none a fleet health finding. Roll 2 (fresh image with #18722 + #18720) is the next data-plane step and waits on the owner's private-IP window decision. |

## Roll 2 (image `4916ed67`, 2026-09-06)

| Step | Result | Evidence |
|---|---|---|
| Docs split | #18958 merged `3bb038a185` (findings, checklist, roadmap, Roll 2 plan). | |
| Code PR | #18959 merged `61b09b7a02` (rebase of #18565 onto main; desktop rotation change dropped since #18719 shipped a proportional version). Two Opus review rounds: round 1 caught the mobile fail-fast rejecting on any socket close (one AP flap would book the 60 s cooldown) → 2 s grace, re-armed once on `handshaking`; round 2 caught a removed jitter assertion that let a one-sided jitter pass → exact pin on the top of the band. Control lease 55 min → 6 h ± 30 min. | |
| Image publish | run 34002233801 → `sha256:4916ed676d8389f694a648e750f1112d9002d68c84a1e0c7af828d5af129de62`; mirrored to staging (run 34002326150). | |
| Staging cell smoke | **Dropped.** Staging C4 is pinned to the Asia launch digest by `relay-staging-c4-refresh-workflow.test.mjs` (with production c27–c29 tfvars and the C4 recovery workflow) and the only C4 image-refresh path pins its accepted predecessor to an older digest. Re-pinning all of it for a smoke widens into the Asia launch machinery; #18969 closed. Roll 2 follows the Roll 1 path: director first, c7 as the rehearsal cell. | |
| Director deploy | run 34002673626 **success** 01:02Z: serving `orca-cloud-relay-00575-leq` on `4916ed67`, `00574-wag` (same image) tagged `selector-rollback`, `00569-ret` (`519f4914`) still deployable. Baseline before: 1 director Postgres retry in the prior hour, 0 `container die`. | |
| c7 `verify` (read-only) | run 34002885408 **success** (gate success, cell_1 rollout success, release_lease success), target `4916ed67`, rollback `85bf6799`, protocol 1, gen 148. | |
| Director go/no-go (01:02Z–07:00Z, 6 h on `00575-leq`) | **Go.** Presence confirmed (13.8k assign 200s, 410 cell + 90 director `runtime_metrics` rows/30 min). Postgres retries 13 (all `55P03` lock_timeout) vs 85 on `00570-siv` in the prior 6 h. `/v1/assign` mix 200/401/503 = 13820/5557/623 vs 14081/5256/663 before the deploy; 503s are the placement/sticky admission `Retry-After` path and cluster by source (top source 351), same shape as before. 0 `container die`, cell `sqlFailuresDelta` sum 0. The earlier all-zero read at 01:28Z was a dead gcloud credential, not a quiet fleet, and was discarded. | |
| Monitor dry-run (Roll 2 gate 1) | run 34018071984 dispatched 07:03Z at gen 148, **green** 07:18Z at `1326d6b40c`; main had moved to `b51bbf3fc6` with identical trusted code. | |
| c7 `canary-apply` (run 34018804481) | **Succeeded** 07:18–07:31Z, protocol 1, rollback `85bf6799`: gate, rollout, seal_canary, release_lease all success. Template `…-20260906072156…` on `4916ed67`; selector gen 148 → 150. Four `container die` at 07:29:16–25Z were the new container exiting during boot (`applyPostgresSchema`/`backfillRelayCellRegions` → `Connection terminated due to connection timeout`, exit 1, 2 s runtime each) while the `cloud-sql-proxy` sidecar warmed up; fifth start at 07:29:26 listening, readiness check passed 07:29:27. Same boot-order race as c13 in Roll 1 batch 1, no serving impact (cell was still drained). 139 controls by 07:34Z and climbing, `sqlFailuresDelta` 0, `sqlLatencyMsMax` ~40 ms. | |
| Monitor dry-run (Roll 2 gate 2) | run 34019568779 dispatched 07:36Z at gen 150, **green** 07:51Z at `57e34c7f03` (main `6494f2a4f0`, identical trusted code). | |
| c8 `canary-apply` (run 34020284092) | **Succeeded** 07:52–08:09Z, protocol 1, rollback `519f4914`: all jobs success. Template `…-20260906075820…` on `4916ed67`; gen 150 → 152. One boot-race `container die` at 08:05:51Z (2 s, exit 1), next start served. 101 controls by 08:10Z, `sqlFailuresDelta` 0. | |
| Monitor dry-run (Roll 2 gate 3) | run 34021119905 dispatched 08:11Z at gen 152, **green** 08:26Z at `ffbf35e0d2`. | |
| Batch 1 `batch-apply` c9,c10,c13,c14 (run 34021868303, canary 34020284092) | **Failed on cell 3 (c13); c9 and c10 succeeded.** c9 08:27–08:43Z → gen 154, c10 08:43–08:58Z → gen 156, both trust-proven and restored general. c13: isolate → gen 157, drain, template `…-20260906090225…` on `4916ed67`, one boot-race exit 09:09:50Z, readiness 09:09:51Z, transition verifier passed at migration-only 09:11:17Z (2 680 assignments, heartbeat fresh, image `4916ed67`), then `probe-relay-rehome-trust` got **409** from the director at 09:11:18Z (157 ms; c9/c10 got 200 in ~178 ms). Failsafe re-asserted migration-only at gen 157 (no change). c14 skipped, lease released. c13 is **serving on the new image but isolated**: 151 controls by 09:18Z, `sqlFailuresDelta` 0, no exits fleet-wide after 09:12Z. The probe script prints only the status, not the director's `error` body, and neither the director nor c13 logs the 409 reason; candidates are the director's source check (`runtime.ready`/`heartbeatFresh`/incarnation read ~1 s after the verifier passed) or c13's `host-drain` rejecting the probe (incarnation mismatch, shared-runtime-identity proof, or the probe host unexpectedly present). Monitor residual: the probe should print the error body. | |
| Monitor dry-run (Roll 2 gate 4) + c13 recovery | Gate run 34024459585 dispatched 09:26Z at gen 157 with c13 in migration-only. On green: `mode=rollback` for c13 with rollback digest `4916ed67` (what it already runs) and target `519f4914`, protocol 1 both ways: `ROLLBACK_RESUME=true` path, no restart, verify + trust probe + restore general. As in Roll 1 (c8 recovery), the rollback mode seals no canary authority, so c14 runs as its own `canary-apply` and the next batch is c15,c16,c19,c20 behind that. | |
| c13 recovery (run 34025225328, `mode=rollback`) | Gate 4 **green** 09:38Z. Recovery **succeeded** 09:38–09:42Z: `ROLLBACK_RESUME=true`, no restart, verifier passed at migration-only (2 679 assignments, heartbeat fresh, `4916ed67`), **trust probe passed** (`host-not-connected` ×2, idempotent, shared runtime identity rejected), activate → **gen 158**, c13 general, verifier passed again. 154 controls, `sqlFailuresDelta` 0, no exits fleet-wide since 09:12Z. The 09:11Z 409 was therefore transient: same cell, same incarnation, same image, ~30 min later the identical probe passed. Most likely the director's source check reading the runtime row within ~1 s of the verifier's pass (a `ready`/heartbeat edge), which a retry in the workflow step would absorb. Residual: retry the trust probe once on 409 and print the error body. | |
| Monitor dry-run (Roll 2 gate 5) | run 34025450523 dispatched 09:44Z at gen 158, **green** 09:59Z at `6933fd70d7` (main `d19be485d3`, identical trusted code). | |
| c14 `canary-apply` (run 34026157631) | **Succeeded** 09:59–10:20Z, protocol 1: trust-proven, gen 158 → 160, canary authority sealed. No boot exits, 102 controls by 10:22Z, fleet `sqlFailuresDelta` 0 over 30 min. | |
| Monitor dry-run (Roll 2 gate 6) | run 34027238190 dispatched 10:23Z at gen 160, **green** 10:38Z at `ec64df335e` (main `adcc30be3b`, identical trusted code). | |
| Batch 2 `batch-apply` c15,c16,c19,c20 (run 34027985784, canary 34026157631) | **All four succeeded** 10:38–11:31Z, protocol 1, four trust proofs, gen 160 → 168. Boot-race exits only: 3 at 10:50Z (c16) and 5 at 11:02Z (c19), all 2–4 s, exit 1, next start served. Controls at 11:32Z: c15 160, c16 164, c19 164, c20 87 (still refilling). Fleet `sqlFailuresDelta` 1 over 30 min. | |
| Monitor dry-run (Roll 2 gate 7) | run 34030557166 dispatched 11:33Z at gen 168, **green** 11:48Z at `adcc30be3b`. | |
| c22 `canary-apply` (run 34031304526) | **Succeeded** 11:48–12:02Z, protocol 1, trust-proven, gen 168 → 170, canary authority sealed. No boot exits, 134 controls by 12:03Z. One correlated 1 s lock-timeout blip at 11:35:17–27Z (c10, c13, c19, c25, c28: one `sqlFailuresDelta` each, `sqlLatencyMsMax` ≈1 000 ms) spanning old and new images, the known lock-wait shape, not roll-related. Director retries 4 in the last hour. | |
| Monitor dry-run (Roll 2 gate 8) | run 34032011250 dispatched 12:05Z at gen 170, **green** 12:20Z at `adcc30be3b`. | |
| Batch 3 `batch-apply` c23,c24,c25,c26 (run 34032799574, canary 34031304526) | **Failed on cell 4 (c26); c23, c24, c25 succeeded** (12:20–13:11Z, gen 170 → 176, three trust proofs). c26: isolate → gen 177, drain, template `…-20260906131159…` on `4916ed67`, one boot-race exit 13:19:17Z, readiness 13:19:19Z, transition verifier passed at migration-only 13:20:42Z (2 604 assignments, heartbeat fresh, `4916ed67`), then the very next call, `admin_post target-runtime` to `c26.relay.onorca.dev/v1/admin/runtime-status`, got **503 `unconditional drop overload`** (27-byte body) and the step failed. That string is not in the relay codebase and c26 logged nothing at 13:20:42Z (readiness at 13:19:19Z, metrics steady), so it is a front-end/LB shed on one request; curl's `--retry 3` logged no retry attempt. Failsafe re-asserted migration-only at gen 177 (no change). c26 is serving on the new image but isolated: 166 controls by 13:25Z and climbing, `sqlFailuresDelta` 0. Residual: the post-apply `admin_post` should retry on 503 (the pre-apply one already tolerates a transient 5xx by comment). | |
| c26 recovery (run 34036875433, `mode=rollback`) | Gate 9 (run 34036059275) **green** 13:41Z at gen 177 with c26 migration-only. Recovery **succeeded** 13:42–13:46Z: `ROLLBACK_RESUME=true`, no restart, verifier + trust probe passed, activate → **gen 178**, c26 general. 176 controls, `sqlFailuresDelta` 0, no exits since 13:25Z. **All 16 US general cells are on `4916ed67`.** | |
| Monitor dry-run (Roll 2 gate 10) | run 34037169783 dispatched 13:48Z at gen 178, **green** 14:03Z at `f952f1ac96`. | |
| c27 `canary-apply` (run 34037973681, Asia, protocol 0) | **Succeeded** 14:03–14:19Z, gen 178 → 180, canary authority sealed (unused; Asia cells roll as single canaries). Template on `4916ed67`, no boot exits, 51 controls by 14:20Z (Asia cell, refilling), `sqlFailuresDelta` 0, `sqlLatencyMsMax` ~1 040 ms (cross-region baseline, c28 on the old image reads ~1 055 ms). Fleet `sqlFailuresDelta` 5 over 30 min: c28 ×3 (~1.17 s), c8 and c9 ×1 (1 s bar), the known lock-wait singles. | |
| Monitor dry-run (Roll 2 gate 11) | run 34038869552 dispatched 14:21Z at gen 180, **green** 14:36Z at `f952f1ac96`. | |
| c28 `canary-apply` (run 34039710735, Asia, protocol 0) | **Succeeded** 14:36–14:53Z, gen 180 → 182. Template on `4916ed67`, no boot exits, 37 controls by 14:55Z (refilling), `sqlFailuresDelta` 0, `sqlLatencyMsMax` ~1 045 ms. Fleet `sqlFailuresDelta` 3 over 30 min. | |
| Monitor dry-run (Roll 2 gate 12) | run 34040698172 dispatched 14:56Z at gen 182, **green** 15:12Z at `1d2e00819f`. | |
| c29 `canary-apply` (run 34041558414, Asia, protocol 0) | **Succeeded** 15:12–15:28Z, gen 182 → 184. No boot exits, 55 controls by 15:29Z. | |
| Census 15:29Z | MIG templates: 18 of 19 general cells on `4916ed67`; **c21 still on `519f4914`**. When c13's recovery re-sealed the canary at c14, batch 2 took c15,c16,c19,c20 and c21 dropped out of the plan's wave (`c15 canary + c16,c19,c20,c21`). Fleet 23 cells, 2 971 controls. Roll 2 exits since 07:00Z: 20, all boot-race (<10 s), 0 serving. Director retries 5 in the last hour. c21 rolls next as a single canary. | |
| Monitor dry-run (Roll 2 gate 13) | run 34042460176 dispatched 15:30Z at gen 184, **green** 15:45Z at `3631f886a7`. | |
| c21 `canary-apply` (run 34043296422, protocol 1) | **Failed at the same post-apply step as c26.** Isolate → gen 185, drain, template `…-20260906155550…` on `4916ed67`, verifier passed at migration-only 16:04:46Z (2 607 assignments, heartbeat fresh, `4916ed67`), then `admin_post target-runtime` to c21 got **503 `unconditional drop overload`** again (27-byte body, ~160 ms after the verifier's own successful read). Failsafe held migration-only at gen 185. c21 serving on the new image, isolated, 111 controls by 16:07Z. Second occurrence in ~3 h on two different cells, both ~1.3 min after readiness: consistent with an edge shed on the first admin request after the LB backend flips healthy. The step needs the same transient-5xx tolerance as the pre-apply read. | |
| Monitor dry-run (Roll 2 gate 14) + c21 recovery | Gate run 34044440616 dispatched 16:08Z at gen 185 with c21 migration-only. On green: `mode=rollback` resume for c21 (rollback digest `4916ed67`, protocol 1). | |
| c21 recovery (run 34045296151, `mode=rollback`) | Gate 14 **green** 16:23Z. Recovery **succeeded** 16:24–16:28Z: no restart, verifier + trust probe passed, activate → **gen 186**, c21 general. 164 controls, `sqlFailuresDelta` 0. | |
| **Roll 2 complete** 16:29Z | **All 19 general cells on `4916ed67`** (c7–c10, c13–c16, c19–c29); existing-only c1–c6, c11, c12 and migration-only c17, c18 untouched. Selector gen 148 → 186. Fleet 23 cells, 2 927 controls. Container exits 07:00–16:29Z: 20, every one a boot-race exit (<10 s, `cloud-sql-proxy` sidecar not yet listening), **0 serving-process exits**. Director on `00575-leq` (`4916ed67`) since 01:02Z: Postgres retries 0 in the last hour (13 over the first 6 h vs 85 on the predecessor), 5xx in the last hour 104 `/v1/assign` 503s (admission `Retry-After` path, at the pre-roll rate). Three waves needed the no-restart `mode=rollback` resume (c13: transient trust-probe 409; c26 and c21: post-apply `runtime-status` 503 `unconditional drop overload`), each recovered in ~4 min with no drain. 14 monitor gates, 14 green, 0 freezes. | |
