# TASK-AG-STORAGE-003: Clarify who emits `dev_servers.bootstrap_status` — deploy script vs. agent process

**Task ID:** TASK-AG-STORAGE-003
**Priority:** 🟡 MEDIUM (blocks CR-STORAGE-006's `bootstrap.ts` hydrate path from being reliable)
**Solution Ref:** [SOL-AG-STORAGE-002](../solutions/SOL-AG-STORAGE-002-fleet-health-and-hydration-reporting.md) §3
**Estimated effort:** Small–Medium (investigation, possibly a small implementation if agent-side reporting is missing)
**Dependencies:** None
**Status:** ✅ Done (2026-09-07)

---

## Context

CR-STORAGE-006 (frontend `bootstrap.ts` slice) wants to hydrate from
`infra-fleet-service`'s `dev_servers.bootstrap_status` column so a
mid-bootstrap page refresh shows the correct step instead of restarting
from scratch. `SOL-AG-STORAGE-002` §3 flagged that it's **unclear** who
actually emits `bootstrap_status` updates:

- `BootstrapFleetTarget` (infra-fleet-service, streaming RPC) deploys the
  relay/agent binary over SFTP+SSH exec and negotiates the version
  handshake — this happens **before the agent process exists to report
  anything about itself**.
- It is not yet confirmed whether `bootstrap_status` transitions are
  written entirely by that deploy-side code (infra-fleet-service driving
  its own SSH exec steps), or whether the agent process, once started,
  also reports further status (e.g. "first successful handshake",
  "capabilities discovered") that feeds back into the same column.

## What to do

1. Read `infra-fleet-service`'s `BootstrapFleetTarget` implementation (or
   its design in `specs/backend-go/tdd/services/infra-fleet-service.md`
   §3, plus real Go source if implemented) to see every place
   `bootstrap_status` is written and what triggers each transition.
2. Check whether any `agent/src/relay/` code sends an RPC/notification
   that infra-fleet-service could plausibly use to advance
   `bootstrap_status` past initial deploy (e.g. the first successful
   `agent.handshake` itself, which is agent-initiated).
3. Conclude one of:
   - **(a) Deploy-only**: `bootstrap_status` is fully owned by the deploy
     flow; the agent process has no role and needs no change. Once the
     agent's first handshake succeeds, infra-fleet-service should already
     be able to infer "bootstrap complete" from `connections.status`
     transitioning to `established` (no new bootstrap-specific signal
     needed from the agent).
   - **(b) Agent contributes signal**: some bootstrap sub-step is only
     observable from inside the agent process (e.g. first successful
     capability probe) and a small addition is needed — in that case,
     scope the smallest change (likely: `agent.handshake`'s params or a
     one-shot notification right after handshake, since the payload
     already includes `capabilities`/`tools`, per
     `SOL-AG-STORAGE-002` §1).
4. Record the conclusion explicitly in `SOL-AG-STORAGE-002` §3 (replacing
   the "cần xác nhận riêng" row) — including which option was found true
   and why.
5. Only if (b): implement the minimal addition and its test. If (a): no
   `agent/src/` change — close this task as investigation-only.

## Acceptance Criteria

- [x] `BootstrapFleetTarget`'s write sites for `bootstrap_status` are
      enumerated with file:line (Go source or, if not yet implemented,
      the TDD section citing why).
- [x] Explicit conclusion recorded: deploy-only vs. agent-contributes,
      with reasoning — not left open.
- [x] If agent-side code was added: it's the smallest change that closes
      the gap (reuse `agent.handshake`'s existing payload where possible,
      don't invent a new RPC method unless proven necessary), with a test.
- [x] `SOL-AG-STORAGE-002` updated with the answer.

## Not in scope

- Any change to `infra-fleet-service`'s Go implementation of
  `BootstrapFleetTarget` itself — that's `backend-go`'s track
  (`BE-SOL-STORAGE-002`); this task only determines whether agent needs to
  emit something new for it to consume.


---

## ✅ Completion Notes (2026-09-07)

Confirmed by grepping the entire `backend-go/services/infra-fleet-service/`
tree for "bootstrap": `BootstrapFleetTarget`/`bootstrap_status` as
described in the TDD **do not exist as real implemented code**. The one hit
for `BootstrapFleetTarget` in all of backend-go
(`channels_repo_ssh_status_workspace.go:704`) is a comment citing it only
as a *precedent for choosing a timeout value* on an unrelated RPC — not an
actual implementation. `internal/domain/dev_server.go:96-98`'s own doc
comment states the real `DevServer` struct is a "proto-sized subset" of
the design doc's fuller entity and explicitly says bootstrap status/agent
version "are not modeled here."

However, migration `0007_dev_server_health_status.up.sql` confirms a real,
different column set was added directly to the shared database:
`infra.dev_servers.status` ("health/bootstrap status:
pending|healthy|degraded|unhealthy") plus `platform`/`arch`/
`node_version`/`agent_version`/`last_provisioned_at`/`tags`. These map
1:1 onto fields the agent's real `agent.handshake` already sends
(`agentVersion`, `platform`, `arch`, `nodeVersion` — confirmed in
`SOL-AG-STORAGE-002` §1).

**Conclusion: option (a) confirmed — deploy/handshake-only, no agent change
needed.** The agent already sends everything required; backend-go's own
handshake handler (`internal/adapter/agentwsserver/`) just needs to persist
those fields onto the real `status`/`agent_version`/etc. columns — a
backend-go-only task, not an agent one. **No code changed in `agent/src/`.**
Findings recorded in `SOL-AG-STORAGE-002` §3, with an explicit note that
CR-STORAGE-006/BE-SOL-STORAGE-002 should be corrected to reference the real
column name (`status`), not the fictional `bootstrap_status`.
