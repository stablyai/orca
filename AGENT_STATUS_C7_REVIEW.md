# Agent status C7 review

## Reviewed revision and scope

- Reviewed commit: `033416546c5f116e540e410a89922a33cfdca2c2` (`feat(agent-status): compose host replicas across SSH`).
- Baseline: `origin/main` at `9ab0a18e821880d1c6f26573264c2026f6c6b641`.
- The unrelated pre-existing `pnpm-lock.yaml` edit and the copied brief/triage HTML/private baseline remain uncommitted.

C7 owns host composition, replication, transport and consumer cutover. C1 reducer semantics, C5 identity/attachment binding, C6 execution verdicts and C10 membership semantics were treated as external contracts; no parallel implementation of those domains was added.

## Failure mechanism before the fix

Direct SSH status delivery stopped at the relay's renderer-facing hook envelope. Desktop, headless/CLI, mobile/session-tabs, reconnect and contact-loss paths therefore had different writers and could not establish host-scoped membership or cursor continuity. The proposed endpoint alone would have been unused unless every reader received the composed host projection.

## Findings and fixes

1. **No execution-host replica domain (P1).** Added `AgentStatusHostReplicaStore` (`src/main/runtime/agent-status-host-replica-store.ts:65-244`). It validates host scope through `AgentStatusStoreReplica`, retains rows across incomplete census/gap/contact loss, emits explicit row/contact mutations, stamps a replica-local evidence receipt, and drops rows only on explicit host abandonment.
2. **Relay had no ordered host publication (P1).** `RelayAgentStatusStoreSource` (`src/relay/agent-hook-status-store-source.ts:11-99`) adapts the existing relay hook cache as the semantic source. `RelayAgentHookRuntime` creates one `AgentStatusStorePublisher` per relay (`src/relay/relay-agent-hook-runtime.ts:165-213`), with per-client cleanup on detach/dispose. The publisher retains overflowed subscribers and emits a bounded resnapshot marker instead of silently losing the stream (`src/shared/agent-status-store-publisher.ts`).
3. **SSH capable/legacy cutover was absent (P1).** `SshRelaySession.wireUpAgentStatusStore` (`src/main/ssh/ssh-relay-session.ts:1240-1348`) probes snapshot and subscription with the capability token, buffers frames until subscription, checks the expected `ssh:<target>` scope, coalesces one in-flight resnapshot request, and only installs legacy hook ingestion when negotiation fails. Legacy fallback abandons stale replica membership; the first capable cutover clears legacy rows with a receipt floor.
4. **Contact loss could be mistaken for process death (P1).** SSH teardown marks replicas `unverifiable` while retaining rows (`src/main/ssh/ssh-relay-session.ts:1830-1840`); only a complete host publication or explicit abandonment removes membership. No process-presence or timeout heuristic was introduced.
5. **Readers could let a newer client row override host evidence (P1).** `buildWebSessionTabsFinalPatch` gates arbitration on the negotiated host capability (`src/renderer/src/runtime/web-session-tabs-sync/apply-final-patch.ts:57-70`); capable hosts replace client rows and host omissions retract them, while legacy hosts preserve prior behavior. Desktop IPC and dashboard receive replica mutations (`src/main/startup/main-window-agent-status.ts:147-178`), and desktop/headless runtime snapshots compose local hook rows with replica rows (`src/main/startup/main-process-runtime-service.ts:71-119`, `src/main/orcad/orcad-entry.ts:188-247`).
6. **Hydration and resume rows were at risk of being dropped.** Runtime provider-session accessors now use the composed snapshot, preserving `providerSessionOnly` rows for native-chat resume while filtered status readers still exclude those rows (`src/main/runtime/orca-runtime-state-fields.ts:44-53`, startup wiring above).
7. **Evidence clocks were not replica-local.** Replica rows carry `replicaEvidenceReceivedAt` and renderer freshness maps it to `mirroredEvidenceReceivedAt` (`src/shared/agent-status-ipc-payload.ts:53-60`, `src/renderer/src/hooks/ipc-events/agent-status-event-applicator.ts:231-237`). Duplicate evidence does not advance the receipt clock; owner epoch, observation revision and new evidence do.
8. **Streaming RPC lifecycle was under-specified.** `agentStatus.subscribeStore` now requires a lifecycle signal, returns immediately for an already-aborted request, and unsubscribes exactly once on abort (`src/main/runtime/rpc/methods/agent-status-store.ts:18-56`). Snapshot/subscription methods are capability-gated and included in generated RPC/mobile catalogs.

## Production entrypoint map

| Surface | Composition/delivery path |
| --- | --- |
| Desktop main | `initializeMainProcessRuntime` creates the local hook publisher and one host replica store; `registerAgentHookHandlers` and the replica mutation listener feed IPC/dashboard. |
| Headless `orcad` | `startOrcadRuntime` creates the same local publisher + replica store and serves the same runtime snapshot/RPC contracts. |
| Direct SSH | `ssh-relay-deploy` passes a deterministic execution-host id to the relay; `SshRelaySession` negotiates snapshot/subscription and routes deltas into the runtime replica. |
| Relay host | `RelayAgentHookServer` remains the semantic hook cache; `RelayAgentStatusStoreSource` and `AgentStatusStorePublisher` add only delivery order/cursor semantics. |
| Session tabs/mobile | Runtime `session.tabs` snapshots and status IPC consume the composed snapshot; capable hosts use host-owned arbitration, legacy hosts retain legacy arbitration. |
| Worktree/CLI/dashboard | Existing runtime getters read the composed provider-session/status snapshot; no reader-side precedence store was added. |

## Acceptance cases

| Case | Result | Evidence |
| --- | --- | --- |
| Complete host-scoped snapshot replaces only that host | Passed | `agent-status-host-replica-store.test.ts` complete-membership case. |
| Incomplete census retains omitted rows and marks membership unconfirmed | Passed | Same test file incomplete-census case. |
| Cursor gap/owner restart retains rows and requires resnapshot | Passed | Same test file gap/owner-restart case; SSH path coalesces refresh. |
| Wrong execution-host frame rejected | Passed | Same test file wrong-host case. |
| Contact loss is `unverifiable`; waiting row is retained | Passed | Same test file contact-loss case; SSH integration capable-relay case. |
| Capable relay bypasses legacy `ingestRemote` | Passed | `ssh-relay-session-agent-hooks.integration.test.ts` capable-relay case. |
| Legacy relay fallback abandons stale replica membership | Passed | Same integration file legacy-fallback case. |
| Snapshot/delta notification ordering and overflow continuity | Passed | `agent-status-store-replication.test.ts`; relay publisher tests. |
| Same-state relay updates preserve `stateStartedAt`; transitions reset it | Passed | `agent-hook-server.test.ts`. |
| Session-tabs capable-host replacement and omission reconciliation | Passed | `web-session-tabs-sync-agent-status.test.ts`. |
| RPC capability, lifecycle signal, already-aborted and exact unsubscribe behavior | Passed | `src/main/runtime/rpc/methods/agent-status-store.test.ts`. |
| Old relay / new client and new relay / legacy client | Passed by negotiated fallback/probe tests; no new opcode is required. | SSH capable and legacy integration cases; old method absence falls back. |
| Electron renderer visual QA | Pending | A separate supervised Electron QA worker is required; no desktop-control automation was used here. |
| Real remote macOS/Linux/Windows/WSL SSH matrix | Pending | Fake transport covers mux/provider wiring; manual/CI matrix remains next QA. |

## Validation commands and results

All commands were run with `ORCA_BACKGROUND_LAUNCH=1` where they launch tests/apps.

```text
git fetch origin main
ORCA_BACKGROUND_LAUNCH=1 pnpm tc                                      PASS
ORCA_BACKGROUND_LAUNCH=1 pnpm run check:code-quality:changed          PASS (0 new findings)
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config config/vitest.config.ts \
  src/main/runtime/agent-status-host-replica-store.test.ts \
  src/main/runtime/rpc/methods/agent-status-store.test.ts \
  src/shared/agent-status-store-replication.test.ts \
  src/relay/agent-hook-server.test.ts \
  src/main/ssh/ssh-relay-session-agent-hooks.integration.test.ts \
  src/renderer/src/runtime/web-session-tabs-sync-agent-status.test.ts    PASS (60 tests)
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config config/vitest.config.ts \
  src/relay/agent-hook-server.test.ts \
  src/main/ssh/ssh-relay-session-agent-hooks.integration.test.ts \
  src/main/runtime/agent-status-host-replica-store.test.ts \
  src/shared/agent-status-store-replication.test.ts                    PASS (48 tests)
```

Additional focused runtime/session-tabs suites passed (37 and 44 tests). Generated RPC catalog parity passed via `ORCA_BACKGROUND_LAUNCH=1 pnpm run generate:rpc-params-catalog` before the final commit.

## Reliability invariants, oracle and gate

- **Invariant:** only a frame with the expected execution-host id can mutate a host replica; complete snapshots establish membership, deltas require owner-epoch/cursor continuity, contact loss never implies exit, and row receipt clocks are local to the receiving runtime.
- **Failure source:** relay/client disconnect, old method absence, cursor gap, overflow, owner restart, wrong host scope, and aborted stream lifecycle.
- **Oracle:** `AgentStatusStoreReplica` result (`applied`, `ignored-stale`, `resnapshot-required`), host snapshot membership/contact, row mutation stream and renderer session-tabs arbitration.
- **Gate:** no reader consumes a capable host's legacy hook writer; negotiation failure explicitly abandons stale replica state before legacy fallback; no timeout or process-presence heuristic changes status.

## Performance and resource evidence

- Publisher subscribers are a `Set`; each SSH/client subscription has one unsubscribe handle and is removed on detach/dispose.
- Publisher census buffers at most `AGENT_STATUS_STORE_REPLICA_BUFFER_MAX` (256) deltas per subscriber; overflow emits one resnapshot marker and keeps the subscriber for later deltas.
- Each SSH session maintains at most one in-flight resnapshot request (`agentStatusReplicaRefresh`); repeated gaps/overflow do not create request storms.
- Replica row receipts are deleted on row drop/host abandonment; host membership and routing maps are bounded by connected hosts.
- No host contention/stress benchmark was run. The evidence above is deterministic bounded-state reasoning plus focused tests, not a throughput claim.

## Architecture and precedent judgments

- **Functional correctness:** C7 scoped behavior is implemented and focused acceptance cases pass. No proven P0/P1/P2 remains in the reviewed paths.
- **Architectural fit:** follows the requested host-owned composition: relay hook cache is semantic authority, publisher is delivery-only, runtime owns replicas, and readers keep presentation policy. Structured journal/identity/reducer/execution ownership was not duplicated.
- **Concrete precedent/deviations:** ownership and lifecycle match the repository's existing host-store/publisher contract. Direct SSH uses method probing because relay binaries predate the capability; this is a transport-specific negotiation difference, not an optional-field or reader-precedence workaround. Private reference attribution is intentionally omitted from this public report.
- **Validation gaps:** no Electron visual QA, no real multi-platform SSH run, and no mobile device run. The direct `agentStatus.subscribeStore` runtime RPC has no renderer callsite; production paired clients consume the composed `session.tabs`/snapshot path, while direct SSH consumes the relay stream. This endpoint should not be advertised as a separate client reader until a client adopts it.

## Dependencies and next QA

No dependency commit was required; the implementation is based on `origin/main` above and the single scoped commit listed at the top. Peer C1/C2/C5/C6/C10 work remains outside this lane; their completion/evidence gates must be checked before the batch is certified.

Next QA scenarios: capable and legacy relay against real Linux/macOS/Windows/WSL hosts; SSH reconnect while a waiting prompt is visible; host restart with owner-epoch change; delta gap and overflow followed by resnapshot; simultaneous local and remote pane keys; mobile/session-tabs omission after host row drop; and hidden-renderer Electron IPC/dashboard verification.
