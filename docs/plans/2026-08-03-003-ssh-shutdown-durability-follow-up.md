---
title: "refactor: Make SSH shutdown snapshots durable and teardown bounded"
type: refactor
date: 2026-08-03
status: draft
---

# Make SSH shutdown snapshots durable and teardown bounded

## Summary

Separate synchronous SSH recovery-state detachment from slow transport teardown. The committed quit path must mark every active SSH lease detached before the final store flush snapshots state, then drain forwards, sessions, transports, and in-flight work under one SSH-local deadline. Timed-out work may finish best-effort but cannot mutate the final persisted recovery state.

## Problem

The current quit path starts SSH teardown before `store.flushAsync()`, but per-target teardown awaits port-forward removal before detaching session recovery state. The store flush can therefore latch and snapshot while a lease still says attached. A later per-session durable flush is rejected because persistence has already been finalized.

The current SSH shutdown bound applies only to the in-flight join between two drains. Either drain can consume the global quit deadline. A system SSH forward also has no final timer after `SIGKILL`, so a child that never reports exit can leave teardown pending.

## Goals

- Put detached SSH lease state into the final store snapshot.
- Keep the ordinary non-quit detach durability fence unchanged.
- Fence new and in-flight connects before the shutdown snapshot.
- Bound the entire SSH drain/join/drain sequence with one deadline.
- Report unfinished work by target and phase.
- Resolve forward teardown even when a child never reports exit after `SIGKILL`.

## Non-goals

- Changing PTY owner admission or reconnect error taxonomy.
- Weakening ordinary durable writes.
- Making the final store flush infallible.
- Waiting indefinitely for remote cleanup.
- Changing local, WSL, folder-workspace, or Git-provider shutdown behavior.

## Reliability contract

- **Invariant (`agent-session.provider-ownership`):** once committed quit begins, no SSH connection can publish new recovery authority, and every active SSH recovery lease is detached in the in-memory state captured by a successful final flush.
- **Failure source:** a slow forward close or connect continuation can cross the final persistence snapshot; unbounded teardown can then consume the global quit deadline.
- **Oracle:** a real-ordering test pauses forward removal, begins shutdown, starts the final store flush, and requires the written snapshot to contain detached leases before the paused transport work resumes. Fake-time tests prove the shared deadline and post-kill timer.
- **Gate:** extend the terminal/session ownership gate with quit snapshot ordering, late continuation fencing, and bounded child-process teardown.
- **Performance budget:** shutdown performs one O(active SSH targets) pre-pass and one bounded async drain; it adds no steady-state work, polling, or timers.

## Design

### One shutdown entry point

Expose one function from the SSH lifecycle module:

```ts
function beginSshShutdown(): Promise<SshShutdownResult>
```

Calling it performs all required in-memory work synchronously and returns the asynchronous transport-drain promise. It is idempotent: later calls return the same promise and do not repeat state transitions.

The committed quit path uses this order:

1. The shared quit gate is already latched.
2. `const sshShutdown = beginSshShutdown()`.
3. `const storeFlush = store.flushAsync()`.
4. Join both promises inside the existing global quit barrier.

No await may occur between steps 2 and 3.

### Synchronous pre-pass

`beginSshShutdown()` immediately:

1. Snapshots active session identities and in-flight target work.
2. Invalidates connect and reset authorities.
3. Aborts current reconnect/establish work.
4. Transitions each active session into shutdown-detached state.
5. Marks its recovery lease detached in memory.
6. Prevents every late callback from publishing recovery or scheduling persistence.

The pre-pass does not remove forwards, disconnect transports, wait for promises, or perform a per-session durable flush.

### Persistence ownership

Add a shutdown-specific session transition rather than exposing `Store.quitFlushStarted`:

- Ordinary `detachAndPersist()` keeps its current synchronous mutation plus required durable session flush.
- Shutdown detachment mutates the same in-memory recovery state but deliberately delegates durability to the immediately following final store flush.
- Async shutdown drain code cannot change recovery state after the pre-pass.

The guarantee is conditional: when the final store flush succeeds, its snapshot contains detached SSH leases. Write failure or the outer process deadline remains visible as residual risk; the design does not claim unconditional durability.

### Bounded async drain

Use one absolute deadline for all SSH shutdown phases:

```ts
const deadline = now() + SSH_SHUTDOWN_BUDGET_MS
```

Every phase receives the remaining duration rather than its own full timeout:

1. First drain of the snapshotted sessions and transports.
2. Join connect, reset, and test-probe work admitted before the fence.
3. Second drain for any resource published before its cancellation checkpoint.

Track work as `{ targetId, phase, promise }`. When the deadline expires:

- stop awaiting later phases;
- return a result listing each unfinished target and phase;
- log one bounded aggregate summary;
- allow underlying work to finish best-effort;
- prevent late completion from mutating recovery state, re-registering sessions, or scheduling persistence.

A bare `Promise.race` is insufficient unless these late-work rules are enforced.

### System SSH forward termination

`waitForSystemSshForwardStop` uses two timers:

1. Send `SIGTERM`; after the existing stop timeout, send `SIGKILL`.
2. Arm a short final timer when `SIGKILL` is sent; resolve if no exit event arrives.

Natural exit clears both timers and listeners. Already-exited children resolve without sending signals. Signal errors remain best-effort but cannot leave the promise pending.

## Implementation units

### 1. Session shutdown transition

Files:

- `src/main/ssh/ssh-relay-session.ts`
- `src/main/ssh/ssh-pty-consumer-recovery.ts`
- recovery durability tests

Split the synchronous recovery/session transition from ordinary durable flush. Add an idempotent shutdown-only transition that cannot later schedule recovery persistence.

### 2. Atomic quit ordering

Files:

- `src/main/ipc/ssh.ts`
- `src/main/index.ts`
- `src/main/persistence.ts` tests only unless an existing public snapshot oracle is insufficient
- quit-path durability tests

Replace separate pre-pass/drain calls with `beginSshShutdown()`. Call it immediately before `store.flushAsync()` and prove ordering through the real quit sequence.

### 3. Shared SSH deadline

Files:

- `src/main/ipc/ssh.ts`
- `src/main/ipc/ssh.test.ts`

Use a remaining-time helper, target-labelled work, bounded aggregate reporting, and explicit late-completion fencing.

### 4. Post-kill bound

Files:

- `src/main/ssh/system-ssh-forward-process.ts`
- `src/main/ssh/system-ssh-forward-process.test.ts`

Add the final post-`SIGKILL` timer and timer/listener cleanup coverage.

## Required tests

- Slow forward removal cannot keep an attached lease in the final successful snapshot.
- A connect paused before session publication cannot publish after the pre-pass.
- A reset paused behind a connect cannot open a transport after the pre-pass.
- Shutdown pre-pass is idempotent and performs no per-session durable write.
- Ordinary non-quit detach still requires and reports durable write failure.
- First drain, in-flight join, and second drain share one deadline.
- Deadline expiry reports target and phase, performs no later awaited phase, and returns within budget.
- Late transport completion cannot mutate recovery state or schedule persistence.
- Fast shutdown returns promptly rather than waiting for the deadline timer.
- Child already exited: no signal.
- Child exits after `SIGTERM`: no `SIGKILL` or final timer.
- Child exits after `SIGKILL`: final timer is cleared.
- Child never exits: stop resolves after the post-kill bound.

## Diagnostics

- Log counts of snapshotted sessions and admitted in-flight tasks, not recovery payloads.
- Report unfinished targets as bounded `{ targetId, phase }` entries.
- Distinguish store-flush failure from SSH transport-drain timeout.
- Never log owner leases, credentials, terminal output, or full persisted state.

## Acceptance criteria

- A successful final store flush contains detached state for every session present at the shutdown pre-pass.
- No SSH connect/reset continuation publishes after the pre-pass.
- The whole SSH shutdown path returns within its local budget.
- A never-exiting forward child cannot hold quit open.
- Ordinary detach durability behavior is unchanged.
- Local, SSH, WSL, mobile/relay, folder workspace, and supported desktop platform impact is documented as covered, unaffected, or an explicit gap.
