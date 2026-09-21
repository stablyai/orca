# Relay improvement roadmap (written 2026-09-04, after the auth/relay outage)

Owner-facing list of what is left to make the relay more robust, in priority order. Evidence and history
for every item is in [`relay-reconnect-2026-09-findings.md`](./relay-reconnect-2026-09-findings.md)
(Findings 1–13). Everything already landed on 2026-09-04 is listed at the end so this file is complete on
its own.

## 1. Finish what 2026-09-04 started (this week)

| # | Item | Why | How | Size |
|---|---|---|---|---|
| 1.1 | **Roll all 23 cells onto the current relay image** | Every cell still runs the image that exits the whole process on a Postgres connect timeout (Finding 6). The fixed image runs only on the director and c7. Any future DB stall repeats the 200-crashes-in-48h pattern. | `cloud-deploy-relay-production-same-cap` waves, gated by the 15-min monitor. Roll inputs and canary results are in the findings doc ("Roll inputs", "Canary blast radius"). | one afternoon |
| 1.2 | **Enable the refresh_tokens pruning job** (orca-cloud #476, merged, off) | `refresh_tokens` is 63 M rows / 26 GB and grows forever; its size is what turned a slow disk into a sign-out storm (Finding 13). | Build an auth image from main (the 21:04Z deploy already contains the entrypoint: `orca-cloud-auth-00031-tox`, digest `343a0915…`), set `auth_token_pruner_enabled = true` and the image digest in `infra/terraform-apps/environments/production.tfvars`, apply targeted. First run with a small `auth_token_pruner_max_deleted_rows`. Watch the run summary's `stopReason`, not the exit code. ~48 M rows drain in ~10 days at 200k/hour. | 1 hour + 10 days of watching |
| 1.3 | **Reclaim the disk after pruning** | Deletes leave dead tuples; the 16 GB table does not shrink on its own. | `pg_repack` (or `VACUUM FULL` in a maintenance window; it takes an exclusive lock) on `refresh_tokens` off-peak, after 1.2 finishes. | 1 evening |
| 1.4 | **Full Terraform apply of the orca-cloud apps root** | The production plan carries four drifts from other merged work: `ORCA_CLOUD_REFRESH_TOKEN_TTL_DAYS` env on the auth service (#476), a skill-share log exclusion filter change, skill pressure threshold 16→8, an artifacts bucket lifecycle rule. Locally it also fails on the 1Password Cloudflare data source. | Run from CI or a machine with the 1Password account; review the four drifts as ordinary changes. | 30 min |
| 1.5 | **Alert on the pruning job** | A run that only ever times out exits 0 and reads as green. | Log metric on the job's summary event where `stopReason != "complete"`, policy on the relay channel. | 1 hour |

## 2. Remove the shared fate between auth and relay (2.1 and 2.3 this quarter; 2.2 deferred)

| # | Item | Why | How | Size |
|---|---|---|---|---|
| 2.1 | **Private IP for Cloud SQL, `--private-ip` on the cell proxies** (do this on the existing shared instance; do not wait for 2.2) | Cells reach the database's public IP through Cloud NAT. Dynamic port allocation (landed) raised the ceiling from 64 to 4096 ports per VM, but the NAT is still in the path and its logs are still the only place port exhaustion shows up (Finding 11). | Add a private IP to `orca-cloud-auth-db` (foundation root, orca-cloud), peer the relay VPC, switch the proxy flag in the cell template, roll. | 1–2 days |
| 2.2 | **Split the relay database from the auth database** — *DEFERRED 2026-09-04 (owner decision): revisit ~2026-11-01 once pruning is done and there is a month of alert history* | One Cloud SQL instance serves `orca_auth`, `orca_relay`, `orca_push`, `orca_skills`. The auth table's growth stalled the relay for a day (Findings 10, 13). Deferral rationale: the concrete cause is fixed (disk 250 GB, WAL 16 GB, index, pruning), 2.3 + 1.1 turn a future stall into retries, and the checkpoint/disk/headroom alerts now page. Re-open if the checkpoint-loop or connection-headroom alert fires, or a large new auth-side table is planned. | New instance for `orca_relay`; migrate with a short relay drain. Relay state is small so the cutover is minutes. | 1–2 weeks incl. rehearsal on staging |
| 2.3 | **Statement timeouts on the relay pool** (the auth pool got one in #476) | A relay query stuck behind a checkpoint fsync should fail fast and let the bounded retry take over rather than hold a pool slot for seconds. | `statement_timeout` on the relay `pg.Pool` in `cloud/apps/relay`, tuned under the lease renewal deadline. | half a day |

## 3. Make the desktop refresh path forgiving (next 2 weeks)

| # | Item | Why | How | Size |
|---|---|---|---|---|
| 3.1 | **Refresh-token rotation grace window** | The server revokes the whole family the first time a just-rotated token is presented again. On 2026-09-04 that turned a 30 s server slowdown into 21,605 sign-outs. A short window (e.g. 60 s) where the immediately-previous token is still accepted, returning the same new token, is standard practice. | In `apps/auth/src/tokens/refresh-tokens.ts`: accept `rotated_at` within the window, return the successor instead of revoking. Keep true reuse (outside the window, or a third presentation) as revocation. | 1 day incl. tests |
| 3.2 | **Do not retry `/refresh` with the same token on timeout** | Desktop's 30 s `CLOUD_REQUEST_TIMEOUT_MS` expiring is treated like a network error and retried with a token the server may already have rotated. | In `src/main/orca-profiles/profile-cloud-session-refresh.ts`: on timeout, re-read the stored session first, and prefer a longer single attempt for the refresh call specifically. | half a day |
| 3.3 | **Un-revoke is impossible; make sign-out recovery obvious instead** | Server-side un-revoke does not help because the desktop deletes its local token on the 401. Landed: desktop notices immediately (#18694) and the phone says "desktop signed out" (#18698). | Nothing more unless we want a re-auth deep link from the phone to the desktop. | — |

## 4. Chronic relay issues already characterised

| # | Item | Why | How | Size |
|---|---|---|---|---|
| 4.1 | **Cell-inventory lock contention** (partial: PR #18722 narrowed the remaining non-placement sites; `assignOnce` placement lock is the follow-up) | `postgres_retries` is a global `FOR UPDATE` over the 23-row `relay_cells` table with a 1 s `lock_timeout`; it is the floor under every 503 and every slow phone accept (Findings 2, 5; memory `relay-cell-inventory-lock-contention`). | Per-cell row locks or an advisory lock keyed by cell; move capacity counters to delta writes. Verify against real Postgres on 55440. | 1 week |
| 4.2 | **Region preference is mostly inert** | Phones request an Asia cell on ~19 % of attempts and get one ~6 % of the time; the sticky lane wins silently, so Asia users ride the US path more than intended (memory `relay-region-preference-mostly-inert`). | Let a region preference override stickiness when the preferred region has headroom; measure with `orca_relay_runtime_metrics` region counters. | 2–3 days |
| 4.3 | **Desktop lease-rotation waves** | A cell recreate seeds a fleet-wide 1006/4408 reconnect burst ~54 min later, every ~54 min (Finding 3). | Jitter the desktop control lease renewal by ±10 % so the cohort spreads out. | half a day, desktop + wire-compatible |
| 4.4 | **Raise `postgres_retries` gate calibration** | The 300 bar was recalibrated (PR #18580) but should track the post-lock-fix baseline once 4.1 lands. | Re-derive from a week of `orca_relay_postgres_transaction_retry` counts. | 1 hour |

## 5. Observability still missing

| # | Item | Why | How |
|---|---|---|---|
| 5.1 | **Cell crash-rate alert** | 201 process exits in 48 h with no page (Finding 6). | Log metric on `container die` for `resource.type="gce_instance"` relay cells, > 3 per 15 min per cell. In `cloud/infra/terraform/relay-observability.tf`. |
| 5.2 | **Page a person for auth alerts** | Today's four auth policies (orca-cloud #475) route to the relay Slack channel only. A repeat of 2026-09-04 deserves a page. | Add a PagerDuty/phone notification channel to `auth_alert_notification_channels` for refresh rejections and latency. |
| 5.3 | **Pruning job alert** | See 1.5. | |
| 5.4 | **Dashboard that puts the four signals side by side** | Diagnosis took hours because checkpoint state, NAT drops, auth 401 rate, and fleet controls live in four consoles. | One Cloud Monitoring dashboard: `orca_relay_cloud_sql_wal_checkpoint`, NAT `dropped_sent_packets_count`, `orca_auth_refresh_401`, summed `controls`. |

## Landed on 2026-09-04 (for completeness)

- Auth service cap 2 → 20 (service-level manual scaling removed); Cloud SQL disk 49 → 250 GB PD-SSD;
  `max_wal_size` 16384; partial index `refresh_tokens_family_unrevoked` built concurrently by hand.
- orca-cloud #474: the above in Terraform + deploy workflow; replayed dead token answers 401 without
  re-revoking or re-auditing. Deployed as `orca-cloud-auth-00031-tox` 21:04Z.
- orca-cloud #475: auth alerts (refresh 401 > 100/5 min, 429 > 20/5 min, 5xx > 10/5 min, p99 > 10 s). Applied.
- orca-cloud #476: batched `refresh_tokens` pruner (disabled), auth pool `statement_timeout` 10 s, schema
  DDL on an untimed connection.
- stablyai/orca #18693: both relay NATs on dynamic port allocation 64..4096 (applied US 21:01Z, Asia 21:05Z);
  alerts for Cloud SQL WAL-checkpoint loop, disk > 70 %, NAT `OUT_OF_RESOURCES` drops. Applied.
- stablyai/orca #18694: desktop learns of a revoked session immediately, panes re-fetch on mount, pairing
  notice says "Sign in again to use Orca Relay".
- stablyai/orca #18698: phone shows "Desktop signed out — sign in to Orca on your desktop to reconnect" via
  the WebSocket close reason (only additive slot old phones tolerate).
- Director on image 519f4914; c7 on 85bf6799; other 22 cells still on the old image (see 1.1).
