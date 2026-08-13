# STA-3077 / PR #13326 session handoff

> **Status:** paused at an approved bounded redesign; not release-ready.
>
> **Review/fix round:** 6.
>
> **Do not continue the current six-file implementation.** It is a rejected,
> uncommitted grant-map approach. Remove it with `apply_patch`, then implement
> the dedicated main-owned replacement transaction described below.

This is the continuation entrypoint for the current PR. It records the whole
session at the point the user asked to pause, including what shipped to the PR
branch, what failed review, the agreed design boundary, and the next safe work.

## Executive summary

The session started with STA-3077's SSH reconnect failure class: reconnects
could graft panes the user never created, accumulate remote shells, fabricate
process death from an attach failure, or let stale identities affect a
successor. The branch now contains extensive fixes, tests, design records, and
two user-visible recovery actions for an unreachable pane.

The pushed candidate is still incorrect in one important action. “Start a new
terminal” invokes generic `pty:spawn` while the old durable pane binding remains.
Main can adopt that old owner, so the action can reopen the old shell instead of
creating the one blank shell the user requested.

An attempted six-file fix added `freshSpawnForUnreachablePtyId` to generic spawn
and a process-global grant map. Three independent read-only audits rejected it.
The common verdict was that replacement must be a dedicated local transaction
owned by Electron main, with exact incarnation identity, one durable Store
commit, runtime ownership transfer, output quarantine, reconnect fencing, and
renderer generation guards.

The user approved this bounded redesign. It applies only to the broken
unreachable-pane replacement operation. It is not authority to restart the
earlier whole-system architecture effort.

## Repository checkpoint

Verified before this handoff was written:

| Item                                | Value                                                |
| ----------------------------------- | ---------------------------------------------------- |
| Worktree                            | `/Users/nwparker/orca/workspaces/orca/eye-React-185` |
| Local branch                        | `nwparker/sta-3077-reattach-pane-cardinality`        |
| HEAD                                | `df6edfcebd2ea401a6feda1fccf31189e57eceda`           |
| HEAD subject                        | `fix(ui): center narrow terminal recovery actions`   |
| Actual PR                           | `stablyai/orca#13326`                                |
| Actual PR ref                       | `origin/nwparker/sta-3077-d-affordance-and-review`   |
| Actual PR ref SHA                   | exactly `df6edfcebd2ea401a6feda1fccf31189e57eceda`   |
| Configured upstream                 | `origin/nwparker/sta-3077-reattach-pane-cardinality` |
| Configured upstream SHA             | `518dac34415e0f67883461c3f58e5586209c7f24`           |
| Local `origin/main`                 | `889dd4c7d2fe255aac552e4dcc91204279dc022c`           |
| Merge base with local `origin/main` | `58a926170cd99baf8920a83a86799bfbd307d735`           |
| Local `origin/main...HEAD`          | 10 commits on main / 109 commits on HEAD             |

The configured upstream is stale. Its `[ahead 387]` status is not the PR's
push state. The PR ref is exactly at HEAD. When the work is genuinely ready,
push explicitly:

```bash
git push origin HEAD:nwparker/sta-3077-d-affordance-and-review
```

Before this document, the worktree had six modified tracked files, no untracked
files, and a `+163/-11` uncommitted diff. `git diff --check` was clean. No
product test, typecheck, lint, build, Electron, or E2E command was run against
that dirty state.

## The intended outcome

For a pane whose old SSH terminal cannot currently be reached, the UI offers:

- **Try again:** attempt to reattach the exact existing shell without claiming
  it exited or spawning a replacement.
- **Start a new terminal:** keep the same pane and leaf, create exactly one
  genuinely blank shell, move durable and runtime pane ownership to it, and
  leave the unproven old process alive but unbound.

The second action must never:

- silently adopt or resume the old shell;
- resume an agent, command, launch token, startup sequence, or saved telemetry;
- create another pane or tab;
- kill a process whose exact incarnation is not proven;
- let a reconnect restore the predecessor after replacement wins;
- let stale renderer work clear, kill, or republish the successor;
- expose provider output before the replacement commits; or
- add replacement intent to SSH, relay, provider, paired-runtime, or stream
  wire contracts.

## What was done during the session

The branch has 109 first-parent commits over its current merge base, including
two large updates from `origin/main`. The useful progression is below; use the
git history for the complete commit-by-commit record.

### 1. Reconnect and persistence containment

The early work stopped SSH reconnect from treating persisted rows as permission
to create UI, made pane binding authoritative during duplicate arbitration,
and added rollback around durable lease retirement.

Representative commits:

- `5d8bb18fd3f` — stop reconnect from grafting panes and stacking leases.
- `ae134995c13` — heal duplicate pane leases from older state.
- `ccb082740fc` — let the durable pane binding outrank recency.
- `8d9aeb55e03` — roll back lease retirement when durable writing fails.
- `03d794a0f90` — pass `mayCreate: false` from the production reattach writer.
- `a7558a837ca`, `13ca7630116`, and `8ec025e4e46` — add and strengthen pane,
  process, binding, and lease census oracles.

### 2. Unknown is not death

The session removed several paths that inferred a dead process from missing,
unavailable, timed-out, or disconnected state.

Representative commits:

- `eec807d7594` — stop respawning a shell that may still be running.
- `356d6b52b24` — apply positive-proof requirements to both reattach paths.
- `b9d58423121` and `7589df8b348` — let PTY liveness remain unknown.
- `7cd7fef927f` — a reattach not-found is not itself proof of shell death.
- `e39514e9ab2` and `41613b5c84c` — distinguish bare not-found from a relay-
  proven exit and retire a lease only in the latter case.

This work also stopped one exhausted delivery recovery from tearing down every
session on an SSH host (`07e382ec196`) and made parked delivery recoveries
expire/re-enter correctly (`124e00e8a83`, `601604d17b1`).

### 3. Exact operation and incarnation fencing

The branch added or strengthened stale-operation refusal, host-attested shell
identity, remembered-exit identity, and reconnect fences.

Representative commits:

- `0de5994be91` and `980e5d846b5` — fence stale writes, resize, and signals.
- `235e45ad0f2` — record host-attested shell identity on a lease.
- `30441f1ebbb` — fence recycled relay PTY IDs by shell identity.
- `8f0c8e3ed35`, `42cbe34523f`, `c14ba64d9dc`, and `0cb187f6035` — require an
  exit proof to name the shell for which it grants replacement authority.
- `5793f186e96`, `be02c4e7f5c`, and `901dd06b8d1` — apply incarnation and pane
  fences on reconnect, including clients unable to name a shell.
- `c8d08e1b215` — strengthen the incarnation write-fence regression oracle.

These improvements are valuable, but the round-6 review found that raw PTY ID
is still used as identity in important lease/runtime/cleanup paths. The new
replacement transaction must finish that exact-incarnation work for its own
surface rather than assuming the existing fencing is complete.

### 4. Pane arbitration and rollback hardening

Lease arbitration moved from tab-level assumptions toward the actual pane leaf,
and rollback was hardened so an already-expired duplicate cannot be revived.

Representative commits:

- `b92498468a5` — arbitrate on the pane, not the tab.
- `1697b3be163` — supersede on the leaf.
- `7724a950ecd` — mutate only the plane that supplied the supersession proof.
- `21ad47c0bc5` — fence duplicate-lease rollback and add a regression oracle.

The existing `upsertSshRemotePtyLease` key remains `(targetId, ptyId)`. That is
insufficient when an old and a new process reuse the same raw ID but have
different incarnations. Replacement requires exact lease identity.

### 5. Unreachable-pane product behavior

The renderer now presents a provider-neutral disconnected card with two
explicit actions and copy that does not claim an unobserved exit.

Representative commits:

- `5e1b57bb2f9` — add the two-action disconnected pane affordance.
- `d27927b84b5` — remove a remote-host-only assumption from its copy.
- `037ee535b8a` — centralize unreachable-pane guards.
- `f7eb6f26656` — suppress the entire saved startup set for a fresh shell.
- `b46a1f8773e` — avoid stranding a local pane after restore failure.
- `ab6ce176f3f` — do not unbind a live shell that generic spawn adopted.
- `df6edfcebd2` — center the recovery actions in narrow panes.

The last item in that list makes the pushed behavior internally safer but also
exposes the unresolved product bug: generic spawn can adopt the incumbent, so
“Start a new terminal” is not guaranteed to start anything new.

### 6. Tests, design records, and platform evidence

The session added substantial focused and E2E coverage for local restart,
daemon/WSL survival, SSH pane cardinality, two-host isolation, `MaxSessions=1`,
mixed-version decoding, lease termination, relay exit proof, and renderer
recovery behavior. The main records are:

- `docs/reference/terminal-session-behavior-contract.md`
- this folder's `goalposts.md`, `design-final-detail.md`, and `resume-plan.md`
- `src/main/ipc/pty.test.ts`
- `src/main/ipc/pty-superseded-operation-fence.test.ts`
- `src/main/persistence.test.ts`
- `src/main/persistence-ssh-lease-termination.test.ts`
- `src/main/runtime/orca-runtime.test.ts`
- `src/main/ssh-reattach-pane-cardinality.test.ts`
- `src/main/ssh/ssh-relay-reattach-exit-proof.test.ts`
- `src/main/ssh/ssh-relay-session-reconnect-incarnation.test.ts`
- `src/renderer/src/components/terminal-pane/pty-connection.test.ts`
- `src/renderer/src/components/terminal-pane/pty-transport.test.ts`
- `src/renderer/src/components/terminal-pane/TerminalPaneDisconnectedBanner.test.tsx`
- `tests/e2e/ssh-disconnected-pane-affordance.spec.ts`

Historical receipts in `goalposts.md` include discriminating native macOS,
Linux, Windows, physical WSL, daemon, and Docker work at earlier candidate
SHAs. They are historical evidence, not a current-HEAD validation receipt.

Important proof corrections were also recorded during the session:

- a guard tested only through a direct Store call can still have no production
  caller;
- a green E2E that also passes without the fix is a forward guard, not proof;
- the disconnected-pane state is not currently inducible with the existing
  Docker host faults; and
- the first recovery grant and a later pane-binding fold were deleted after
  review showed their premises were false or their path was unreachable.

## The proven current bug

At pushed HEAD, the renderer's disconnected action calls `startFreshSpawn`,
which calls the normal transport `connect`, which invokes generic `pty:spawn`.
The old durable binding is still present. Generic spawn resolves stable pane
ownership and may attach/adopt that incumbent rather than create a blank shell.

Consequences:

- “Start a new terminal” can reopen the old terminal.
- A same-ID/new-incarnation result is not representable in the current renderer
  result contract.
- The action's success path may compare or clear ownership by raw PTY ID.
- The full product oracle is not running.

The decisive E2E is
`tests/e2e/ssh-disconnected-pane-affordance.spec.ts`, test “starting a new
terminal adds exactly one shell and leaves the panes alone,” beginning near line 314. It is still unconditionally held by
`test.fixme(true, UNREACHABLE_PANE_INDUCTION_UNAVAILABLE)` near line 318.

## Dirty WIP that must be removed

The six uncommitted files implement the rejected
`freshSpawnForUnreachablePtyId`/grant-map design:

| File                                                               | Uncommitted behavior                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/ipc/pty.ts`                                              | Adds a max-256 process-global grant map, records a raw `StablePaneOwner` after attach failure, accepts replacement intent on generic spawn, skips adoption, and performs best-effort raw-ID cleanup. |
| `src/preload/api-types.ts`                                         | Adds `freshSpawnForUnreachablePtyId` to generic spawn.                                                                                                                                               |
| `src/preload/index.ts`                                             | Forwards that generic spawn option.                                                                                                                                                                  |
| `src/renderer/src/components/terminal-pane/pty-connection.ts`      | Passes the old `sessionId` as replacement authority.                                                                                                                                                 |
| `src/renderer/src/components/terminal-pane/pty-transport-types.ts` | Adds the option to the generic transport contract.                                                                                                                                                   |
| `src/renderer/src/components/terminal-pane/pty-transport.ts`       | Forwards it to generic spawn and suppresses telemetry with saved startup.                                                                                                                            |

Why it was rejected:

1. Raw PTY ID is not process identity; same-ID/different-incarnation leases and
   runtime owners collapse.
2. Renderer input becomes replacement authority on a broad generic IPC.
3. Grants have no TTL, sender binding, one-shot operation state, reload
   invalidation, or post-spawn revalidation.
4. Concurrent pane reservations can return another operation's result rather
   than re-resolving the caller's intent.
5. Binding and lease changes flush separately, so no atomic replacement exists.
6. Provider output can reach the old model before persistence/runtime commit.
7. Generic spawn still accepts renderer-derived environment and other startup
   data, so it is not a guaranteed blank shell.
8. Runtime pane ownership is registered, not exactly transferred; lookup can
   continue returning the old record.
9. Renderer callbacks remain authoritative after dispose or a newer attempt.
10. Failure cleanup calls ID-only shutdown and can kill the wrong incarnation.
11. The grant is minted on only one attach-failure path, while the UI action can
    be published from other paths, leaving a visible dead action.
12. Replacement intent leaks into `PtySpawnOptions`-adjacent contracts, making
    remote-wire and mixed-version reasoning unnecessarily dangerous.

No uncommitted tests cover this WIP, and no test was run against it.

Remove only these WIP edits with `apply_patch`. Do not use `git reset`,
`git checkout --`, or another broad restoration command in this dirty worktree.

## Round-6 independent review result

Three read-only reviews converged:

- **Relay/wire review:** request changes. It identified raw-ID identity,
  ambiguous cleanup, missing atomic Store commit, precommit output publication,
  broad IPC authority, incomplete blank-shell enforcement, and wire-
  compatibility blockers.
- **Targeted transaction review:** recommended a dedicated IPC, owner-keyed
  mutex, token-keyed idempotency, combined Store transaction, reconnect CAS,
  post-image inspection on flush error, and deterministic race tests.
- **Final readiness audit:** request changes. It independently found the same
  persistence/runtime/grant/incarnation/renderer/cleanup defects and one hard
  feasibility boundary: existing SSH shutdown is raw-ID-only.

All three reviews were read-only. They ran no tests or builds and changed no
files.

## Approved bounded redesign

### 1. Main-issued replacement ticket

When main classifies an attach as unreachable but not proven dead, return a
typed local result containing an opaque ticket. The ticket is authority, not a
renderer-supplied PTY ID.

Bind it to:

- the issuing `webContents`/sender;
- connection and provider generation;
- worktree or folder-workspace identity;
- tab, leaf, and pane key;
- exact old application PTY ID and provider-native ID;
- persisted and runtime incarnation IDs;
- exact active lease identity;
- issuance generation and short expiry;
- a random operation ID; and
- state `issued | running | committed | rejected | unresolved` plus the
  idempotent result where applicable.

Invalidate tickets on renderer reload/destruction, provider replacement,
connection re-registration, expiry, or exact-owner change. A consumed or
rejected ticket must not become valid again after any request was dispatched.

### 2. Dedicated local IPC

Add a local-only API such as:

```ts
pty.replaceUnreachablePane({ ticketId, cols, rows })
```

It should return a structured result such as:

```ts
{
  ;(ptyId, incarnationId, operationId)
}
```

It must not route through generic `pty:spawn` or `PtyTransport.connect`, and it
must not add fields to provider, SSH, relay, paired-runtime, or stream payloads.
Authenticate the sender as the main renderer window before ticket lookup.

### 3. Shared owner lock and idempotency

Use one host/worktree/pane owner mutex for:

- ordinary pane spawn/adoption;
- unreachable-pane replacement; and
- relay reconnect's final owner activation.

Each waiter must re-resolve its own intent after acquiring the lock. It may not
return another operation's result merely because it waited on the same lock.

Use the ticket's operation ID for idempotency. A double-click, lost response,
or retry while running awaits the same operation and returns the same result.
It must create at most one shell.

### 4. Main-constructed blank spawn

Under the owner lock, re-read the workspace and re-derive CWD. Repeat folder-
workspace path validation at that moment; do not trust the path captured when
the ticket was issued.

Construct provider spawn options from a narrow main-owned allowlist. Exclude:

- command and command delivery;
- `sessionId`, `attachOnly`, or resume metadata;
- launch config, token, agent, or telemetry;
- arbitrary renderer environment or environment deletion;
- shell override;
- startup command delivery; and
- sequenced-startup environment.

Only the validated pane/workspace identity, dimensions, and provider-required
blank-shell metadata may cross the provider boundary.

### 5. Exact incarnation lease identity

Lease identity for this transaction must include incarnation, not only
`(targetId, ptyId)`. Old `pty-1/inc-A` and new `pty-1/inc-B` must coexist as:

- old exact lease: expired/unbound; and
- new exact lease: attached/bound.

Every mark, remove, attach, rollback, and reconnect CAS touched by replacement
must name the exact lease incarnation. Preserve compatibility with persisted
legacy rows that lack optional incarnation data; unknown identity may not
authorize destructive cleanup.

### 6. One Store transaction

Add one Store method, for example `replaceUnreachableSshPaneOwner`, that under
one mutation and one flush:

1. exact-CASes the old durable pane binding;
2. exact-CASes the old active lease;
3. installs the new binding and incarnation;
4. installs the new exact attached lease;
5. expires the exact old lease without shutting down its process;
6. advances topology and lease mutation versions, including affected already-
   expired siblings; and
7. flushes once.

Snapshot every mutated in-memory field before starting.

Because durable-file replacement renames the new image before directory fsync,
a thrown flush is not proof that disk stayed old. Inspect the persisted post-
image before deciding what happened:

- **Old image:** restore memory and clean only a provably exact new process.
- **New image:** treat the transaction as committed.
- **Mixed or unreadable:** kill neither process; mark the operation unresolved,
  quarantine publication, and reconcile from disk/provider evidence.

### 7. Runtime ownership replacement

Add a non-exit runtime primitive along these lines:

```ts
runtime.replaceTerminalPaneOwner({
  paneKey,
  worktreeId,
  expected: { ptyId, incarnationId },
  replacement: { ptyId, incarnationId }
})
```

It must:

- exact-CAS the current owner;
- clear the old record's pane ownership without `onPtyExit`;
- leave the old process live and unbound;
- move the pane/leaf/handle lookup to the replacement;
- invalidate old handles so they cannot silently target the successor; and
- correctly reset ID-keyed state when raw PTY ID is reused with a new
  incarnation.

Prepare and validate runtime replacement before the Store commit. Make the
final in-memory step synchronous and designed not to fail. If an unexpected
post-durable failure still occurs, never roll durable ownership back to the old
process and never kill either shell; quarantine and retry publication/
reconciliation idempotently.

### 8. Quarantine provider output

Capture the provider object and generation before spawn and recheck them after
every await. Quarantine output for the exact
`{ provider generation, ptyId, incarnationId }` until durable and runtime
replacement commit.

Only then activate source delivery and publish the new runtime owner. A new
shell reusing the old raw ID must never send bytes into the predecessor model.

### 9. Fence relay reconnect

Relay reconnect must acquire the same owner lock after network attach and,
before changing ownership or delivery, exact-CAS:

- the current pane binding;
- the lease incarnation; and
- the provider/connection generation.

Only a winning reconnect may set ownership, restore incarnation, activate
source delivery, or register runtime state. A reconnect for the predecessor
must be unable to publish it after replacement commits.

### 10. Renderer adoption rules

The renderer calls only the dedicated API. Guard every completion/failure by:

- connection object not disposed;
- current transport identity;
- current action generation; and
- matching ticket/operation generation.

Accept same-raw-ID/new-incarnation as a real successor. Adopt only the exact
structured committed result. A stale or disposed callback does nothing: it does
not clear a binding, republish the card, or kill a result. Main owns the durable
transition, so the renderer must never clear the old durable binding after
success.

## Hard cleanup boundary and selected policy

Current provider and SSH relay shutdown APIs identify only a PTY ID. If spawn
returns `pty-1/inc-B`, then reconnect races and `pty-1` may refer to a different
incarnation by the time rollback runs. Calling `shutdown('pty-1')` is not exact
cleanup.

The safe policy for this PR is:

- do not add replacement intent to the remote wire;
- use existing capability-gated create-operation replay and host-attested
  incarnation when they provide conclusive identity;
- clean a failed new shell only when its exact incarnation is provable through
  a provider-owned rollback handle or equivalent existing evidence;
- otherwise park/quarantine the ambiguous shell for reconciliation;
- never blind-retry an ambiguous legacy spawn; and
- never risk killing the incumbent merely to avoid a leak.

Legacy relays without create-operation replay or host-attested incarnation must
fail closed or leave the outcome unresolved. If implementation cannot satisfy
this with current local/provider contracts, stop at the design gate. Do not
silently add `expectedIncarnationId` to remote shutdown; that is a separate,
capability-negotiated wire design and review.

## Transaction outcome table

| Outcome                                      | Durable owner     | Process action                                    | Publication                           |
| -------------------------------------------- | ----------------- | ------------------------------------------------- | ------------------------------------- |
| Ticket/pre-spawn validation or fence failure | Old               | None                                              | Reject                                |
| Spawn failure before dispatch                | Old               | None                                              | Reject; ticket may be safely terminal |
| Spawn response ambiguous after dispatch      | Old or unresolved | No blind retry or ID-only shutdown                | Park/reconcile                        |
| Known new shell, post-spawn CAS loss         | Winner or old     | Stop only the exact new incarnation when provable | Publish nothing                       |
| Store commit succeeds                        | New               | Leave old process alive; expire exact old lease   | Publish new                           |
| Flush throws; disk has old image             | Old               | Clean exact new only when provable                | Reject                                |
| Flush throws; disk has new image             | New               | Leave both processes                              | Publish new                           |
| Flush throws; disk mixed/unreadable          | Unresolved        | Kill neither                                      | Quarantine/reconcile                  |
| Post-commit runtime/publication failure      | New               | Never roll back or kill                           | Retry publication idempotently        |

## Required deterministic oracles

These are completion requirements, not optional follow-ups.

### Main transaction

- Seed an exact failed owner, ticket, binding, and lease.
- One explicit replacement call makes exactly one provider fresh spawn.
- Provider options contain no session, attach, command, startup, resume,
  renderer env, launch metadata, or telemetry.
- The same pane remains; the old shell receives no shutdown or synthetic exit.
- Exactly one combined Store handoff occurs and runtime lookup resolves the new
  owner.

### Authorization and lifecycle

- Missing, expired, replayed, wrong-sender, wrong-host, wrong-worktree,
  wrong-pane, and renderer-reload tickets reject before provider spawn.
- Changed/missing binding, persisted/runtime incarnation, lease, provider, or
  generation rejects before mutation.
- Folder-workspace path changes after ticket issuance are revalidated under the
  lock.

### Identity and races

- Old and new may both be raw `pty-1` with distinct incarnations.
- Double-click and lost-response retry create one operation and one shell.
- Ordinary spawn racing replacement does not inherit the replacement result.
- Reconnect before spawn yields no spawn.
- Reconnect after spawn cannot republish the predecessor.
- Provider replacement during every await prevents an unsafe commit.
- A delayed old-incarnation exit cannot affect the new incarnation.

### Persistence and durability

- Success survives save/reload with exactly one flush.
- Old exact lease is expired, new exact lease attached, and new binding exact.
- Pre-rename failure restores old memory/disk state.
- Post-rename failure recognizes the new image as committed.
- Mixed/unreadable post-image kills neither process.
- Duplicate-retirement rollback cannot revive an already-expired sibling.
- Same raw PTY ID with different incarnations remains representable.

### Runtime and renderer

- Exact non-exit runtime rebind moves pane/leaf/handle lookup to the successor.
- The old owner remains live but unbound and receives no exit.
- Disposed, stale-generation, late-success, and late-failure callbacks cannot
  spawn, clear, kill, or republish over newer state.
- Same-ID/new-incarnation structured results are adopted.
- A disposed transport never kills a main-committed replacement.

### Compatibility and E2E

- No replacement field appears in provider, SSH, relay, runtime RPC, paired
  RPC, or stream payloads.
- Legacy relay degradation is fail-closed/unresolved, never destructive.
- Current-to-release and release-to-current terminal compatibility suites stay
  green.
- Unfix the decisive Docker test and add a deterministic production seam that
  leaves the target connected while one pane attach is unreachable.
- The E2E must prove old PID plus start ticks stay alive, exactly one blank
  shell is added, pane/leaf count is unchanged, new durable `(id,
incarnation)` is bound, new lease is attached, old exact lease is expired,
  and no agent/resume/startup transcript is duplicated.

## Remaining work, in dependency order

### Phase 0 — resume safely and freeze the invariants

1. Read this document and the repository `AGENTS.md` instructions.
2. Run the checkpoint commands below.
3. Confirm the PR ref remains at the recorded SHA and inspect any newly arrived
   changes before editing.
4. Treat ambiguous cleanup as unresolved rather than adding a remote wire field.
5. If that constraint becomes infeasible, stop and return to the user instead
   of widening scope.

### Phase 1 — remove the rejected WIP

Use `apply_patch` to remove only the current six-file
`freshSpawnForUnreachablePtyId` and grant-map edits. Preserve every committed
change and any unrelated user work. Run `git diff --check` and verify the only
remaining change is this handoff document before beginning the replacement.

### Phase 2 — build the identity and persistence foundation

1. Add incarnation-aware exact lease identity with legacy-row compatibility.
2. Add exact lease lookup/mark/remove APIs required by replacement and
   reconnect.
3. Add the single Store replacement transaction and one-flush rollback state.
4. Add post-image inspection for pre-rename, post-rename, and mixed/unreadable
   outcomes.
5. Write persistence tests first and demonstrate the intended failure on the
   current implementation.

### Phase 3 — build runtime and coordination primitives

1. Add the exact non-exit runtime pane-owner replacement primitive.
2. Add the host/worktree/pane owner mutex shared by normal spawn,
   replacement, and reconnect final activation.
3. Add operation-token idempotency independent from that lock.
4. Update reconnect to revalidate exact binding, lease incarnation, and
   provider generation after it acquires the lock.
5. Add same-ID/new-incarnation and delayed-old-exit tests.

### Phase 4 — implement the main replacement transaction

1. Issue typed, sender-bound, expiring, one-shot tickets from every renderer
   path that can publish the unreachable action.
2. Add the dedicated preload/main IPC and main-window sender check.
3. Re-derive CWD and validate folder workspaces under the lock.
4. Construct the blank provider spawn from the main allowlist.
5. Capture provider generation and quarantine exact new output.
6. Revalidate after every await; prepare runtime; execute the Store commit;
   finish runtime activation; publish output/result.
7. Implement all transition-table outcomes without ID-only cleanup.

### Phase 5 — adopt through the renderer

1. Remove replacement from generic transport/spawn types.
2. Thread the typed ticket and structured committed result through the
   disconnected action only.
3. Add disposed/current-transport/action-generation guards.
4. Remove renderer-side binding clearing or committed-result killing.
5. Verify UI layout, copy, and behavior through Electron Playwright CDP as
   required by repository instructions.

### Phase 6 — validate and review once

1. Run the focused deterministic suite.
2. Make the Docker E2E inducible, remove its unconditional `fixme`, and prove
   it fails for the intended reason on the unfixed candidate before claiming
   it as evidence.
3. Run typecheck, lint, full unit tests, build, reliability gates, and relevant
   SSH/daemon/cross-version regressions.
4. Run independent repository and release-readiness reviews, including
   security, performance, mobile/backcompat, Windows, Linux/glibc, SSH, folder
   workspace, and provider-neutrality coverage.
5. Resolve every P0/P1 and relevant P2. If another architectural invariant
   fails, pause instead of entering an unbounded seventh patch loop.

### Phase 7 — deliver

Only after the implementation and reviews are clean:

1. Commit the replacement work.
2. Push explicitly to
   `origin/nwparker/sta-3077-d-affordance-and-review`.
3. Update PR #13326's body with the transaction, compatibility behavior, and
   exact validation receipts.
4. Resolve the seven saved review threads only when their findings are actually
   addressed.
5. Request `@coderabbitai review` and monitor CI to completion.
6. Use the `orca-linear` workflow to post one concise STA-3077 completion
   update and attach the PR if needed.

## First safe resume commands

Run from the primary worktree before editing:

```bash
git status --short --branch --untracked-files=all
git rev-parse HEAD
git rev-parse origin/nwparker/sta-3077-d-affordance-and-review
git rev-parse origin/main
git rev-list --left-right --count origin/main...HEAD
git diff --stat
git diff --check
```

Expected before any external state changes:

- HEAD and the PR ref are both `df6edfcebd2ea401a6feda1fccf31189e57eceda`;
- the six rejected production-file edits are present;
- this handoff file is the only additional local artifact; and
- `git diff --check` exits 0.

Do not use the configured upstream to infer PR state.

## Suggested validation commands after implementation

Adjust the focused file list only when the final implementation clearly moves
the covered behavior. Record exact commands and outcomes in the PR.

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/ipc/pty.test.ts \
  src/main/persistence.test.ts \
  src/main/persistence-ssh-lease-termination.test.ts \
  src/main/runtime/orca-runtime.test.ts \
  src/main/ssh-reattach-pane-cardinality.test.ts \
  src/main/ssh/ssh-relay-session.test.ts \
  src/main/ssh/ssh-relay-session-reconnect-incarnation.test.ts \
  src/main/ssh/ssh-relay-session-reattach-pane-fence.test.ts \
  src/renderer/src/components/terminal-pane/pty-connection.test.ts \
  src/renderer/src/components/terminal-pane/pty-transport.test.ts \
  src/renderer/src/components/terminal-pane/TerminalPaneDisconnectedBanner.test.tsx \
  --reporter=dot

pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

For the Docker product oracle, use the repo's Electron Playwright configuration
with `ORCA_E2E_SSH_DOCKER=1` after adding the deterministic induction seam and
removing the test's unconditional `fixme`. Keep the run POSIX-only as the
existing Docker fault harness requires.

Run the current↔release cross-version terminal suite and the relevant Docker
SSH cardinality, `MaxSessions=1`, and two-host scripts as part of broad
regression coverage.

## Validation record at pause

### Current redesign/WIP

No product validation was run after the rejected six-file WIP was introduced.
No product validation was run during the three final read-only audits or while
writing this handoff. Therefore this document claims no current test, typecheck,
lint, build, Electron, Docker, cross-version, or packaging pass.

### Read-only checkpoint commands run for this handoff

The following repository inspections completed successfully:

```bash
git status --short --branch
git status --short --branch --untracked-files=all
git rev-parse HEAD
git branch --show-current
git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'
git rev-parse origin/nwparker/sta-3077-d-affordance-and-review
git rev-parse origin/nwparker/sta-3077-reattach-pane-cardinality
git rev-parse origin/main
git rev-list --left-right --count origin/main...HEAD
git merge-base origin/main HEAD
git log --oneline --decorate -12
git reflog --date=iso
git diff --stat
git diff --name-status
git diff --check
```

Observed results are recorded in the repository checkpoint above. In
particular, `git diff --check` exited 0.

Historical validation details are preserved in `goalposts.md` and
`resume-plan.md`. Those receipts belong to their recorded SHAs and must not be
reported as validation of the final replacement candidate without rerunning
them.

## Security, compatibility, migration, and release risks

- **IPC authority:** a renderer-supplied PTY ID is forgeable/piggybackable;
  tickets must be opaque, sender-bound, short-lived, one-shot, and revalidated.
- **Same-ID reuse:** raw PTY ID cannot distinguish an incumbent from a
  successor. Every destructive or ownership operation needs exact incarnation.
- **Durability:** a thrown fsync after rename can leave the new image on disk.
  Blind in-memory rollback can diverge from restart state.
- **Remote ambiguity:** ID-only shutdown cannot safely clean same-ID reuse.
  Prefer a visible/reconcilable leak to killing an unproven process.
- **Output isolation:** precommit bytes from a successor can corrupt the old
  pane model unless quarantined by provider generation plus incarnation.
- **Mixed versions:** clients and hosts update independently. Keep replacement
  local; any future exact-shutdown wire field needs capability negotiation and
  both-direction live skew tests.
- **Legacy persisted rows:** missing incarnation is unknown, not permission to
  mutate or delete. Migration must be additive and old-reader-safe.
- **Folder and SSH workspaces:** re-resolve current paths and host generation
  under the lock; neither git worktree presence nor local filesystem access may
  be assumed.
- **Cross-platform:** preserve macOS, Linux/glibc floor, Windows, WSL, path, and
  shortcut rules even though the Docker fault harness is POSIX-only.
- **Performance:** avoid global scans, unbounded ticket/operation maps,
  repeated fsyncs, or hot-path lock contention. Bound retention and measure
  affected reconnect/spawn paths.
- **Release evidence:** the key E2E remains held. The change is not release-
  ready until that product path is deterministic and discriminating.

## Stop conditions

Pause and return to the user if any of these occurs:

- exact cleanup appears to require an unreviewed remote-wire change;
- the Store/runtime transaction cannot distinguish old, new, and mixed durable
  post-images;
- replacement requires treating unknown identity as proof;
- the deterministic E2E still cannot enter the actual production state;
- the shared lock introduces a new global serialization or deadlock risk; or
- the next independent review finds another architectural invariant failure.

The point of this handoff is to prevent another opaque loop: one bounded
redesign, deterministic evidence, one adversarial review, then either delivery
or a principled stop.
