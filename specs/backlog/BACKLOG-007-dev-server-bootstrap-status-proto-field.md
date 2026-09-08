# BACKLOG-007: `DevServer` proto has no `bootstrap_status` field to hydrate `bootstrap.ts` from

**Origin:** `specs/frontend/crs/v3/storage/tasks/FE-TASK-STORAGE-013-hydrate-bootstrap-ssh-provisioning.md` (bootstrap.ts half); root cause investigated in `specs/backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-002-dev-server-agent-hydration-and-health.md`
**Priority:** Low-Medium — one frontend slice's mid-bootstrap-refresh UX, not a correctness bug
**Blocked on:** A schema/product decision (add the field to `infra.dev_servers` + the proto, or decide the frontend shouldn't try to hydrate this after all) — not on more engineering time to wire an existing field

---

## What this is

CR-STORAGE-006 wants the frontend's `bootstrap.ts` slice to hydrate "which
step is this dev server's first-time bootstrap currently on" from
backend-go, so a page refresh mid-bootstrap shows the right step instead of
restarting the sequence display from scratch.

## Why it's blocked (confirmed by reading the real proto/domain, not guessed)

Already investigated once, in this same effort's agent-side track
(`specs/agent/crs/v3/storage/tasks/TASK-AG-STORAGE-003-clarify-bootstrap-status-ownership.md`):
`bootstrap_status`/`BootstrapFleetTarget`, as described in
`specs/backend-go/tdd/services/infra-fleet-service.md`'s design sketch, **do
not exist as real backend-go code**. `internal/domain/dev_server.go`'s own
doc comment says the real `DevServer` struct is a "proto-sized subset" of
the design doc's fuller entity and explicitly lists bootstrap status/agent
version as "not modeled here."

What *does* exist (migration `0007_dev_server_health_status.up.sql`):
`infra.dev_servers.status` (`pending|healthy|degraded|unhealthy`) plus
`platform`/`arch`/`node_version`/`agent_version` — a coarse
connectivity/health status, not a bootstrap-step tracker. The agent's real
`agent.handshake` already sends exactly the fields needed to populate that
row (`agentVersion`, `platform`, `arch`, `nodeVersion`) — confirmed by
reading `agent/src/relay/agent-session.ts` directly.

`FE-TASK-STORAGE-013` hydrated the other two thirds of its scope
(`ssh.ts`/`provisioning.ts`/`runtime-environment-ssh.ts`, via
`ListSshTargets`/`GetSshState`, which are real) without issue — only the
`bootstrap.ts` third is blocked, specifically because there is no
`bootstrap_status`-shaped field anywhere to read.

## The decision needed

1. **Add a real bootstrap-progress field** to `infra.dev_servers` (e.g. a
   `bootstrap_step` enum or similar) and have whatever drives fleet
   bootstrap (today: the legacy TS `fleet-bootstrap-service.ts`, not yet
   ported to backend-go per that same investigation) write to it — real
   engineering work once someone decides the field shape.
2. **Decide the coarse `infra.dev_servers.status` is good enough** for
   `bootstrap.ts` to key off of (e.g. `pending` = "still bootstrapping",
   `healthy` = "done") and skip a dedicated bootstrap-step field entirely —
   smaller scope, but loses the "which specific step" UX CR-STORAGE-006
   originally asked for.
3. **Descope `bootstrap.ts` hydration** from CR-STORAGE-006 entirely — a
   mid-bootstrap refresh keeps restarting the displayed sequence (today's
   behavior), accepted as a known, low-severity UX gap.

## Once decided

`FE-TASK-STORAGE-013`'s `bootstrap.ts` hydrate branch can be finished —
its `resumeBootstrapProgressIfAny()` sketch (in
`FE-SOL-STORAGE-006-dev-server-agent-state-hydration.md` §3) already shows
the shape of the read; it just needs a real field to read from once one of
the options above is chosen.
