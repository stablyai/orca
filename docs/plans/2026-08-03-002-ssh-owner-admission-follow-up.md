---
title: "refactor: Make SSH PTY owner admission explicit and non-destructive"
type: refactor
date: 2026-08-03
status: draft
---

# Make SSH PTY owner admission explicit and non-destructive

## Summary

Complete the owner-admission cleanup after the reconnect hotfix in #12367. Keep the stable logical lease, per-admission generation fence, single pending publication, and bounded publication retry. Add explicit resume outcomes and owner-refusal codes so the client never converts a recoverable relay decision into checkpoint deletion or a subscriber-shaped failure.

## Goals

- Report whether a requested owner recovery was honored.
- Grant a fresh owner in one round trip when the relay no longer has an owner record.
- Never return a subscriber grant to an authenticated, owner-capable request.
- Distinguish an attached incumbent from a disconnected incumbent without parsing messages.
- Preserve recovery identity and checkpoints on relay refusal.
- Reject duplicate owner opens whose independent response settlements cannot be coupled safely.

## Non-goals

- Multiple simultaneous pending owner publications.
- Changes to PTY output sequencing, acknowledgement, or replay.
- Changes to `ownerGeneration` delivery fencing.
- Replacing the current publication commit/rollback contract.
- Changing local, daemon, WSL, folder-workspace, or Git-provider behavior.

## Reliability contract

- **Invariant (`agent-session.provider-ownership`):** exactly one published generation has owner authority, and a relay refusal cannot destroy recovery state belonging to the current attempt or a newer attempt.
- **Failure source:** a missing relay owner record, a different owner still inside grace, or a duplicate request can currently collapse into stale-recovery cleanup or an unusable subscriber grant.
- **Oracle:** deterministic tests must prove grant publication, refusal, retry, rollback, connection close, recovery persistence, and losing-attempt fencing across the interleavings below.
- **Gate:** extend the existing terminal ownership/reconnect reliability gate with the new contract tests before implementation lands.
- **Performance budget:** admission remains O(1); retry remains bounded and cancellable; no polling, process creation, or unbounded state is added.

## Design

### Identity and fencing

- `ownerLease` identifies one logical ownership claim and remains stable across reconnect admissions.
- `ownerGeneration` increments for every owner admission and fences data-path authority.
- Resume identity matches `(ownerLease, clientInstanceId, principal)`.
- `ownerGeneration` remains on the resume request as diagnostic context but does not participate in identity matching.

### Serialized publication

Retain the current `OwnerRecord.replaces` publication transaction. At most one owner admission may be pending:

| Current state | Owner-capable request | Result |
| --- | --- | --- |
| Vacant | With or without resume proof | Fresh pending owner, `resumed: false` |
| Active or disconnected | Matching logical proof | Pending replacement, same lease, higher generation, `resumed: true` |
| Pending | Matching logical proof | Existing coded publication-pending refusal |
| Active | Non-matching proof | Attached-owner refusal |
| Disconnected | Non-matching proof | Clamp grace and return disconnected-owner refusal |

The pending refusal is retried by the existing bounded publication loop. Commit activates the replacement and retires the incumbent. Rollback or connection close restores the incumbent. No pending admission supersedes another pending admission.

### Grant contract

Add `resumed: boolean` as a required field on every `session-owner` grant:

- `true`: the relay matched the existing logical claim and reused its lease.
- `false`: the relay created a fresh claim, including when the request carried proof for an owner record the relay no longer has.
- Subscriber grants do not carry `resumed`.

The client rejects an owner grant with a missing or non-boolean `resumed`. Client and relay deployments are build-coupled, so malformed same-build data should not be interpreted as a legacy response.

### Refusal contract

Use separate stable numeric codes because the dispatcher currently transports only code and message:

- `PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR`
- `PTY_CONSUMER_OWNER_HELD_DISCONNECTED_ERROR`

Do not add message parsing or structured error data solely for this distinction.

An attached-owner refusal is blocked and exits owner-admission retry immediately. A disconnected-owner refusal is transient: the relay clamps the remaining grace to a shared short floor, and the owner-admission layer retries within a bounded budget. Both initial establish and reconnect use the same owner-admission path; the raw SSH transport classifier remains unchanged.

Requests that are not owner-capable retain their existing subscriber behavior. Verification must distinguish authorization from an authenticated owner-capable request.

### Duplicate requests

Reject every second `pty.openClient` on one transport connection, even if its hello is identical. Two RPC responses have independent publication settlements; sharing one admission object cannot make rollback and commit atomic across both responses.

RPC timeout or transport failure recovery opens a new connection. The server does not attempt response-level idempotency for owner publication.

### Client recovery state

Handle outcomes as follows:

- `resumed: true`: retain checkpoints and persist the returned generation with the existing lease.
- `resumed: false`: clear checkpoint-dependent state, preserve the recovery row and `clientInstanceId`, replace the old lease/generation with the fresh grant, durably record it before ready, and continue with the ownership already granted.
- Either held-owner refusal: mutate no checkpoint, owner, migration, or persisted recovery state.
- Superseded local attempt: mutate nothing after its attempt authority is lost.

`removeSshPtyConsumerOwnerRecovery` remains reserved for genuine target/recovery removal, not admission refusal.

## Implementation units

### 1. Contract and session decisions

Files:

- `src/shared/pty-consumer-session-contract.ts`
- `src/shared/pty-consumer-session.ts`
- `src/shared/pty-consumer-session.test.ts`

Add required `resumed`, the two refusal codes, vacant-resume ownership, grace shortening, and duplicate rejection. Keep the one-pending publication transaction and publication-pending code.

### 2. Owner-admission retry and error routing

Files:

- `src/main/ssh/ssh-owner-recovery-retry.ts`
- `src/main/ssh/ssh-owner-recovery-retry.test.ts`
- `src/main/ssh/ssh-relay-session.ts`
- `src/main/ipc/ssh.ts`

Keep publication-pending retry bounded. Add bounded disconnected-holder retry at the owner-admission layer. Surface attached-holder refusal through a typed blocked relay error path rather than raw transport reconnect classification.

### 3. Non-destructive recovery persistence

Files:

- `src/main/ssh/ssh-pty-consumer-session.ts`
- `src/main/ssh/ssh-pty-consumer-recovery.ts`
- `src/main/ssh/ssh-relay-session.ts`
- recovery race and durability tests

Validate `resumed`, replace a lost claim atomically, preserve `clientInstanceId`, and remove refusal-triggered recovery deletion.

## Required tests

- Vacant relay plus resume proof grants owner with `resumed: false` and a fresh lease.
- Matching active and disconnected claims grant `resumed: true`, stable lease, and higher generation.
- Matching request during pending publication receives only the pending code; commit and rollback retries both succeed.
- Attached different claim returns the attached code and mutates no recovery state.
- Disconnected different claim returns the disconnected code, clamps grace, and succeeds after the bounded floor.
- Matching original owner proof wins during the shortened floor.
- Owner-ineligible request retains the explicitly chosen authorization behavior.
- Duplicate open is rejected before a second publication callback is registered.
- `resumed: false` persists the new lease before ready while preserving `clientInstanceId`.
- A losing local attempt cannot clear or overwrite the winner's recovery row.
- Malformed or missing `resumed` is rejected.

## Rollout and diagnostics

- Keep the existing pending error and retry metrics/logs until production evidence shows the window is absent.
- Log refusal code, holder condition, and attempt identity without logging leases or checkpoint contents.
- Record retry exhaustion separately for publication pending and disconnected holder.
- Do not log raw terminal output or persisted recovery payloads.

## Acceptance criteria

- The user never receives a subscriber-shaped success for an owner-capable request.
- No relay refusal deletes recovery identity or checkpoints.
- A forgotten owner record recovers in one request.
- Only one pending owner publication exists.
- All retry paths are bounded, cancellable, and covered by deterministic fake-time tests.
- The wire and persistence changes have explicit same-build and restart coverage.
