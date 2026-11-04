# Relay edge: Cloudflare de-risk runbook

The spike runs on workers.dev only, as `orca-relay-edge-spike`: no routes, no custom domains, test keys only.
Run from `cloud/apps/relay-edge`. Answers tracker risks R1, R2, R3, R4, R9 and R12.

**Cost ceiling: about $15** ($5 Workers Paid base, if not already on it, plus under $10 of usage).
- 1k hosts for 24 h is about 2M alarms plus 0.1M billed pongs.
- 50 phones at 2 fps is about 0.9M billed messages per day.
- Canaries are about 0.4M alarms per week.
- Heartbeat metrics are sampled at 10%.

## 0. Setup (once)
1. `npx wrangler login`, choosing the account the owner picked. Then `npx wrangler whoami`.
2. `npx tsx spike/keys.ts jwks | npx wrangler secret put RELAY_JWKS --env spike`
3. `npx tsx spike/keys.ts resume-hashes | npx wrangler secret put SPIKE_RESUME_TOKEN_HASHES --env spike`
4. `npx wrangler deploy --env spike` (v1). Note the workers.dev URL as `$URL`.
5. `curl $URL/__spike/info`: expect a colo and `version: v1`.

## 1. R9 latency (10 min)
- From a US VM and an HK VM (e.g. a GCE e2-small in asia-east2): `npx tsx spike/rtt-probe.ts --url $URL`.
- Compare with today's cell RTT from the same VM.
- Pass: HK p50 at most today + 30 ms.

## 2. R3 canary (start early; runs 7 days)
- On each VM:
  `nohup npx tsx spike/canary.ts --url $URL --hosts 100 --phones 50 --run-tag canary-<us|hk> --out canary-<us|hk>.jsonl &`
- Each `canary_report` line gives `dropsPerHostDay`. Exclude drops within ±max_delay of our own deploys (step 3 logs them).
- Pass: at most 1 drop per host per day.

## 3. R2 deploy under load (1 h)
- Run:
  `npx tsx spike/deploy-under-load.ts --url $URL --hosts 1000 --phones 50 --warmup 300 --observe 900 --new-version v2 --out deploy.jsonl --deploy-cmd "npx wrangler deploy --env spike --var EDGE_VERSION:v2 --durable-objects-code-update-mode 'deferred 120s'"`
- Read `deploy_report`.
  - **Pass:** `idleHostDrops` is 0; idle sampled hosts adopt v2 after their next alarm; spliced drops happen only after about 120 s.
- Repeat with `'immediate'` to see the worst case.

## 4. R1 / R12 cost and R4 limits (24 h soak)
- Run `npx tsx spike/load-hosts.ts --url $URL --hosts 1000 --phones 50 --fps 2 --duration 86400 --out soak.jsonl`.
- After 24 h:
  - read Durable Objects requests, duration and storage from the account's Workers and Durable Objects analytics;
  - extrapolate ×42 for hosts;
  - for traffic, scale by `splice_bytes` to 11 TB/mo.
- Pass: projected total under $1.5k/mo.
- Analytics Engine SQL API, dataset `orca_relay_edge_spike`:
  - `SELECT blob1, count() FROM orca_relay_edge_spike GROUP BY blob1`;
  - `quantileWeighted(0.95)(double1, _sample_interval)` for `pong_rtt_ms` and `alarm_lag_ms`.
- R4: run a flood with `--phones 5 --fps 50 --mix 1048576:1` and one paused phone (as in `spike/run-all.ts`). Record:
  - what an object over its 128 MB limit does (close codes, other phones unaffected);
  - whether `send()` ever errors.

## 5. Teardown
- Stop all tools with Ctrl-C (each prints a final report).
- `npx wrangler delete --env spike` removes the Worker and its Durable Objects.
- Delete the canary VMs.
- `spike/.keys.json` stays local (gitignored).

## Notes
- `/__spike/*` debug endpoints are on only because `SPIKE_DEBUG=1` in the spike env. Never set it in production.
- Polling `/__spike/host/<id>` wakes that object. deploy-under-load polls only `--sample` hosts every 10 s.
- Local dry run: `npx tsx spike/keys.ts dev-vars && npx wrangler dev --env spike --var PING_INTERVAL_MS:3000`, then point the tools at `http://127.0.0.1:8787`.
