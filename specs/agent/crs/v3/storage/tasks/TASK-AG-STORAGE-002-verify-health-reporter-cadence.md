# TASK-AG-STORAGE-002: Verify Health Reporter emit cadence against real source; reconcile with `infra-fleet-service`'s 30s expectation

**Task ID:** TASK-AG-STORAGE-002
**Priority:** 🟡 MEDIUM
**Solution Ref:** [SOL-AG-STORAGE-002](../solutions/SOL-AG-STORAGE-002-fleet-health-and-hydration-reporting.md) §3
**Estimated effort:** Small
**Dependencies:** None
**Status:** ✅ Done (2026-09-07)

---

## Context

`specs/agent/tdd/v5/00-index.md` §A.1/A.2 states the agent's Health
Reporter emits CPU/RAM/disk/latency **every 60s**. Separately,
`specs/backend-go/tdd/services/infra-fleet-service.md` §8 states fleet
health polling cadence is **30s per dev server, matching TS's
FleetHealthMonitor**. `SOL-AG-STORAGE-002` flagged this discrepancy as
**not verified against real source** in that pass (unlike the 5s
keepalive constant, which was confirmed directly in
`agent/src/shared/agent-wire-protocol.ts`).

This task closes that verification gap.

## What to do

1. Find the actual Health Reporter implementation in `agent/src/relay/`
   (search for the CPU/RAM/disk/latency emission — likely near
   `agent-session.ts` or a dedicated file; do not assume a filename,
   confirm it by reading).
2. Read the real interval constant/timer setup used for this emission.
3. Compare against `infra-fleet-service.md` §8's 30s expectation:
   - If the real cadence is 60s (matching the TDD, not the backend-go
     doc): this is a real mismatch. Decide whether to (a) tighten the
     agent's cadence to 30s to match backend-go's documented expectation,
     or (b) leave it and correct `infra-fleet-service.md` §8 to say 60s
     instead — **do not silently pick one without stating the tradeoff**:
     a faster cadence means more RPC/CPU on both sides; a slower cadence
     means backend-go's `connections`/`fleet_health_samples` staleness
     window is larger than that TDD implies.
   - If the real cadence is already 30s (i.e. the `00-index.md` "every
     60s" line is itself stale, like the reconnect description covered in
     TASK-AG-STORAGE-004): no code change needed — just correct the
     stale doc.
4. If a code change is warranted (option a above), make the smallest
   change to the interval constant, and update its call sites' tests if
   any assert on the literal value.
5. Update whichever doc(s) turn out to be wrong (`00-index.md` §A.1/A.2
   and/or note it in `SOL-AG-STORAGE-002` §3) so this doesn't need
   re-discovering later.

## Acceptance Criteria

- [x] Real Health Reporter cadence constant located and cited by
      `file:line`.
- [x] Explicit decision recorded (keep as-is + fix docs, OR change cadence
      + rationale) — not left ambiguous.
- [x] If code changed: existing tests updated/added to assert the new
      interval; `tsc --noEmit` and the relevant vitest suite pass.
- [x] `SOL-AG-STORAGE-002` §3's "chưa xác nhận" row updated to reflect the
      confirmed answer.

## Verification

```bash
cd agent
npx tsc --noEmit -p config/tsconfig.node.json 2>&1 | grep -i health
npx vitest run --grep -i "health"
```


---

## ✅ Completion Notes (2026-09-07)

Ran two independent `codegraph_explore` searches over all of `agent/src/`
("health reporter CPU RAM disk emit interval" and "cpu usage os.loadavg
os.freemem diskusage health snapshot") — neither found any module that
periodically collects/emits CPU/RAM/disk/latency. Cross-checked backend-go:
`backend-go/services/infra-fleet-service/internal/usecase/get_fleet_health.go`
(`GetFleetHealth`, `NewPollFleetHealth`) is real, confirming fleet health
is **backend-go-polled** (pull model, likely SSH exec), not agent-pushed.

**Conclusion**: there is no cadence to reconcile — `specs/agent/tdd/v5/00-index.md`
§A.1/A.2's "Health Reporter emits every 60s" describes a push-based
mechanism that does not exist in `agent/src/relay/` today. This is not the
60s-vs-30s mismatch originally suspected; it's a doc describing an
unimplemented (or superseded-by-backend-go-polling) design.

**No code changed** — nothing to reconcile in `agent/src/`. Findings
recorded in `SOL-AG-STORAGE-002` §3. Handed off to TASK-AG-STORAGE-004 to
correct `00-index.md` (in addition to 03/04, which that task already
covers) so this doesn't get re-discovered as a "missing feature" later.
