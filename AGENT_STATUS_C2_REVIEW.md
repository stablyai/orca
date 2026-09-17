# Agent status C2 review

Date: 2026-09-15  
Reviewed implementation HEAD: `34599257b4`
Base: `origin/main` at `9ab0a18e82`

## Outcome

The provider evidence and reducer conformance work is functionally sound at its host-adapter boundary, but this batch is not end-to-end certifiable. The independent review found that the new lifecycle seam still has no production owner-registration/attachment caller, no provider inventory or terminal-record producer, no bounded recovery scheduler, and no production consumer of committed lifecycle outcomes; these are bounded dependency gaps rather than reasons to add a second lease, reducer, or reader-side precedence rule.

## Changes and findings fixed

- Preserved the current origin/main legacy-ingress admission gate while rebasing the C2 commits.
- Carried complete provider inventory fields through relay envelopes, SSH forwarding, and remote-main validation; malformed, incomplete, duplicate, or non-canonical inventory rows are rejected.
- Kept inventory evidence identity content-sensitive and deterministically ordered so successive, empty, and reordered snapshots are not incorrectly deduplicated.
- Kept provider evidence host-local and out of the persisted legacy status row; structured journals remain the durable source where applicable.
- Made recovery custody admission atomic: a turn-capacity failure now rolls back the custody entry instead of leaking bounded slots.
- Reconciled a late joined-child fact after root completion to `unresolved` rather than leaving a previously committed dispatch permanently `completed`; resident background work remains non-gating.
- Reordered local, daemon, and direct-SSH PTY exit funnels so the runtime observes certified exit before pane state is cleared; transport loss remains unverifiable.
- Rejected anonymous child evidence instead of rebinding delayed facts to whichever root turn is currently active; exact owner replacement now requires the previous binding.
- Classified all provider interrupt marker variants as attributable acknowledgements, and observed certified exits even when the legacy status row was already cleared.
- Routed synthetic stop/kill teardown through a shared reconcile-before-cleanup helper on certified paths, preserving the one lifecycle reducer and avoiding status erasure before exit evidence.

## Production entrypoint map

- Provider adapter and conformance contract: `src/shared/agent-hook-listener/provider-turn-evidence.ts`, `provider-turn-inventory.ts`, and `provider-turn-terminal-record.ts`.
- C1 reducer consumption seam: `src/main/agent-hooks/server/server-turn-lifecycle.ts`, invoked from `server-status-update.ts` before presentation guards.
- Local hook ingress: `src/main/agent-hooks/server/server-lifecycle.ts` → normalized event → status application.
- Relay/SSH ingress: `src/relay/agent-hook-envelope-build.ts` → `src/relay/agent-hook-server.ts` → `src/main/ssh/ssh-relay-session.ts` → `server-ingest-remote.ts`.
- Certified PTY exit reconciliation: `src/main/runtime/orca-runtime-on-pty-exit.ts` with local and daemon ordering in `src/main/ipc/pty/provider/local-configure.ts` and `bind-listeners.ts`, and direct SSH ordering in `src/main/ssh/ssh-relay-session.ts`.
- Existing user-visible status projection: `server-status-update.ts` writes through the one legacy admission point; no lifecycle committed-outcome subscriber is wired yet.

## Acceptance cases

Passed at the adapter/reducer boundary:

- Provider turn start, terminal completion/failure, explicit terminal markers, child outcomes, resident background work, provider interrupt acknowledgement, and matching attributable terminal-record recovery.
- Complete current-turn inventory, empty inventory, deterministic replay identity, malformed/incomplete inventory rejection, duplicate work-id rejection, and preservation of uncertainty for omitted work.
- SSH/fire-and-forget interrupt input remains delivery evidence only; it does not settle a turn without provider acknowledgement or bounded recovery.
- Provider `turn/interrupted`, `interrupt_acknowledged`, `interrupted`, and `cancelled` markers settle only the attributable turn as `interrupted`.
- Certified `exited` marks active/recovering work unresolved and blocks late evidence; contact loss does not become process death.
- Anonymous child delivery is ignored rather than assigned to a later root turn; certified exit is reduced even after legacy row dismissal.
- Recovery expiry, explicit abandon, capacity rollback, owner replacement tests, and late joined-child dispatch re-opening.

Missing for end-to-end acceptance:

- C5/C10 committed/adopted owner lifecycle must call `registerAgentTurnOwner` with exact run, attachment, host scope, workspace scope, and provider identity. No production launch path currently does so, so delayed evidence can still be attributed only by pane/source in this branch.
- C4 must supply the actual provider inventory and terminal-record producers for every supported provider and execution host. The adapter APIs alone cannot recover a lost completion.
- C6 must publish authoritative `live` / `unverifiable` / `exited` observations and run the bounded recovery scheduler; no production scheduler or query caller exists here.
- C7 must consume committed outcomes into the one execution-host status store and replicate them to desktop, headless, direct SSH, CLI, and mobile with mixed-version negotiation.
- C5 must carry exact execution-host/connection binding into the lifecycle bridge; provider-only matching is insufficient to reject stale remote evidence for a local attachment.
- Restart/replay durability needs a durable journal or complete host resnapshot with cursor continuity; the in-memory lifecycle map cannot re-derive a lost turn after restart from a single cached status row.
- Full two-direction wire-compatibility validation for the new semantic publication is pending the producer/consumer integrations.
- C4/C6 must populate resident-background identities and provider cursors; those adapter fields remain unused by production producers in this stack.

## Validation

- `pnpm test src/shared/agent-hook-listener/provider-turn-evidence.test.ts src/shared/agent-turn-lifecycle-reducer.test.ts src/main/agent-hooks/server-turn-lifecycle.test.ts src/main/ssh/ssh-relay-session-agent-hooks.integration.test.ts` — 4 files, 45 tests passed before the final focused additions.
- `./node_modules/.bin/vitest run src/shared/agent-hook-listener/provider-turn-evidence.test.ts src/shared/agent-hook-listener/provider-turn-lifecycle.test.ts src/main/agent-hooks/server-turn-lifecycle.test.ts src/main/agent-hooks/ended-process-reconciliation.test.ts` — 4 files, 40 tests passed after the final fixes.
- `./node_modules/.bin/tsc --noEmit -p config/tsconfig.node.json` — passed.
- `pnpm run check:code-quality:changed` — 0 new findings across 74 changed files.
- `git diff --check` — passed.
- Commit hooks for the scoped fixes ran oxlint, React doctor lint, and formatter successfully.
- No full suite, Electron UI run, or host stress benchmark was run in this review; manual Electron QA is intentionally delegated to the separate QA worker.

## Performance evidence

No benchmark was required for the adapter-only changes. Inventory rows remain bounded by the existing 128-item per-work-kind cap, lifecycle maps and replay identities remain bounded by existing reducer caps, and no polling or unbounded retry loop was added.

## Next QA scenarios

1. Launch each supported provider through native, daemon/headless, WSL, direct SSH, and paired runtime paths; verify C5 owner binding is registered before the first hook.
2. Drop a terminal completion, then query a complete provider inventory and terminal record; verify exactly one committed outcome reaches the host store and all readers converge.
3. Interrupt over SSH with ambiguous input acknowledgement; verify the row remains active or explicitly uncertain until provider acknowledgement, expiry, or abandon.
4. Exit a PTY while the final hook is in flight; verify runtime exit is reconciled before pane cleanup and late evidence is rejected for the exited attachment.
5. Restart main/relay between start and completion; verify journal/resnapshot cursor continuity re-derives the turn without treating contact loss as exit.

## Dependencies and intended order

1. Current base and legacy admission: `9ab0a18e82`.
2. C1 reducer contract in this stack: `1fab94e307`.
3. C5 exact owner lifecycle in this stack: `ca060f44e0`; C10 launch-membership integration must wire its committed/adopted owner before evidence delivery.
4. C4 provider producers, then C6 authoritative execution observations and recovery scheduler.
5. C7 host-store projection/replication and negotiated reader cutover after both transport directions consume the same contract.

The copied brief, triage HTML, and private reference notes are intentionally untracked and are not part of this report's commit.
