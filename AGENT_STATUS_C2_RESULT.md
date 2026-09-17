# Agent status C2 result

Date: 2026-09-14  
Branch: `brennanb2025/agent-status-c2-turn-recovery`  
Implementation commit: `e0db1ef0361a0dc7b0ada6f4be4420fae9aa51cb`

## Architecture fit

- Provider adapters now normalize turn identity, terminal markers, child/background work, complete current-turn inventories, interrupt acknowledgements, and attributable terminal records into provider evidence.
- The host bridge consumes C1's `reduceAgentTurnLifecycle` and requires the exact C5-bound `AgentTurnOwner` (run, attachment, host scope, workspace, and provider). It does not add a turn lease, a parallel reducer, or a reader-side status precedence rule.
- Input-written, interrupt-requested, and provider-acknowledged are separate facts. Fire-and-forget SSH input records delivery evidence only; it cannot settle a turn.
- Certified `exited` evidence leaves active/recovering turns unresolved and prevents late provider delivery from fabricating success. Recovery custody has bounded expiry and explicit abandonment.
- Provider evidence is recomputed at trust boundaries and excluded from the persisted legacy status projection. Structured session journals remain durable truth.

## Functional correctness

Conformance coverage is implemented for the C2 cases:

- `STA-4756`: remote provider evidence can be reconciled through the host lifecycle bridge; contact loss/host replication still requires the C6/C7 production observers.
- `STA-2413`: SSH/fire-and-forget interrupt input is recorded without requiring `sendInputAccepted`; the turn remains active until provider acknowledgement or bounded recovery.
- `STA-6495`, `STA-6368`, and `STA-4909`: OMP milestone `agent_end` is non-terminal without an explicit terminal marker; a terminal marker or matching terminal record can settle the attributable turn.
- `STA-4659`: complete inventory evidence represents the foreground turn only while it exists, allowing scheduled idle gaps to remain without an open turn.
- `STA-6149`: joined children and resident background work are distinct lifecycle records.
- `STA-3867` and `STA-2241`: an exact host `exited` verdict ends residency without declaring successful completion, including a CLI that returns to a surviving shell.
- Autonomous next-turn starts supersede the current-turn pointer while preserving the earlier turn as unresolved when no outcome was observed.

Tests cover final completion without a later prompt, duplicate and stale evidence, child `Stop`, missed starts recovered only from matching run/attachment terminal records, interrupt acknowledgement, complete inventories, recovery expiry/abandonment, certified exit, and owner replacement. These are implementation/conformance cases, not claims that every ticket is closed end to end.

## Private-precedent limitations and material deviations

The prepared private reference implementations were inspected for ownership, delivery, and recovery mechanisms. This implementation follows the relevant mechanism of host-attributed lifecycle reduction and bounded recovery custody. It does not claim a complete precedent match because:

- Provider-specific production terminal-record and complete-inventory query sources are not present in this batch; the adapters and host APIs are ready for C4/C6 integration.
- The lifecycle projection is host-memory state in this batch. Durable structured journals remain authoritative; C7 still owns publication/replication and negotiated reader cutover.
- Owner registration is an explicit integration seam. No launch path in this commit mints a second owner or silently infers one from a title, cwd, PID, or process presence.

## Validation

- Focused C2 suites: 5 files, 59 tests passed.
- Re-run focused provider/server/IPC suites: 4 files, 45 tests passed.
- Re-run PTY interrupt inference suite: 1 file, 14 tests passed.
- `pnpm tc:node` passed.
- Prior full validation on this commit: full agent-hook regression (107 files, 1,154 passed, 9 skipped), `pnpm tc:web`, `pnpm tc:cli`, changed-file quality checks, max-lines ratchet, targeted `oxlint`, and `git diff --check` all passed.
- Commit hooks ran `oxlint`, React doctor lint, and `oxfmt --write` successfully.

## Remaining gaps

- C5/C10 must call `registerAgentTurnOwner` from committed/adopted launch and attachment lifecycle paths; this batch intentionally does not create a competing reservation or infer ownership.
- C4 must connect actual provider hook/session adapters and supported terminal-record/inventory sources for each provider. The current APIs reject anonymous, malformed, incomplete, or mismatched evidence safely.
- C6 must supply exact-attachment `live`/`unverifiable`/`exited` observations and the bounded host scheduler; the bridge only consumes an authoritative verdict.
- C7 must publish and replicate this host projection across desktop, headless, direct SSH, CLI, and mobile with negotiated mixed-version cutover.
- The thin loading, freeze, crash, and output-stall reports remain diagnosis-first unless a reproduction demonstrates this turn-recovery mechanism.

## Required sibling commits and integration order

1. Integrate C1 reducer contract (`a0702c7c28`, originating from `1375d66859`).
2. Integrate C5 exact owner binding (`9b41a2df3a`) and C10 committed launch membership (`2d715e87cb`); wire their adopted attachment to `registerAgentTurnOwner` before provider evidence is accepted.
3. Integrate C4 scoped provider adapters/runners (`f5dc3f120b`) plus the provider-specific turn-record and inventory producers still required by the cases above.
4. Integrate C6 exact-attachment execution observation and verdict publication, then feed its certified exit/unverifiable evidence into this bridge.
5. Integrate C7 host-store replication (`c31dd00e11`, `94bda37fc8`) and negotiated readers; retain compatibility mode until both transport directions consume the same lifecycle projection.

The copied launch brief and triage HTML are intentionally local and untracked.
