# Direct SSH reconnect fan-out

Status: implemented and validated; ready for maintainer merge

This design was reviewed in two full rounds, reconciled with current main, and implemented across main, preload, renderer, shared contracts, reliability gates, and Docker SSH fixtures. Review findings are absorbed into the invariants and implementation below.

Validated against `origin/main` at `21dee21a6d9d398bb332ddf0f85fbb4d5de7cd1b`. Current main includes remote-runtime resume/online recovery (#8255), worktree-owned multi-host routing (#10986), negotiated paired close intent (#10129), fail-closed runtime SSH setup (#10799), terminal-view parking (#11016), host-correct SSH folder adoption (#10818), hydration-loop ID indexes (#10891), runtime output chunking (#10915), consolidated changed-code quality gates (#11117), orchestration migration safety (#11107), and CLI-compatible remote timeout parsing (#11206). None replaces the direct desktop SSH reconnect path, but each constrains its ownership and lifecycle integration below.

Scope: direct SSH reconnect recovery across main, preload, and renderer

## Summary

One direct SSH reconnect currently starts two sequential target-preparation waves, or three when a nonempty remote-workspace snapshot is applied. Each wave refreshes every target repo and then lineage. Because the next preparation starts after the previous one settles, the existing in-flight repo coalescer does not collapse these sequential scans. Simultaneous targets multiply the work, while disconnect handling separately calls the single-tab `clearTabPtyId` action once per live tab.

Replace this with host-qualified, epoch-fenced provider reads and a renderer coordinator with two distinct modes:

- reconnect finalization retries the exact target's terminal panes immediately, before optional discovery;
- preparation-only refreshes the exact target's catalog, worktrees, and lineage without remounting panes.

Main owns one provider-incarnation authority per direct SSH target. It is a strict composition of the existing `connectionGeneration` and a new opaque `providerEpoch`: one helper rotates both atomically on the same transition set, and provider work carries and compares the pair. Existing file-mutation fencing continues to carry `connectionGeneration`, but it now advances on every provider-invalidating transition too; reconnect recovery cannot advance one clock without revoking the other. Every authoritative request carries the exact execution host and captured authority through preload to main; main selects the provider by that complete identity and revalidates the authority before any durable side effect. Renderer preparation deduplicates only overlapping work with identical concrete inputs. A completed preparation is not cached for the lifetime of an authority.

Direct SSH provider calls use a dedicated fair limiter with five local slots, explicit deadlines, and cancellation. Cancel acknowledgement means local waiter settlement; the existing fire-and-forget `rpc.cancel` does not acknowledge relay-handler completion. A separate cancel-debt allowance bounds replacement admission while relay work may be finishing. The five-slot bound applies only to locally unsettled detected-worktree provider calls submitted by this coordinator; aggregate telemetry reports the late-work allowance and other same-relay traffic separately. Runtime discovery, sidebar refreshes, filesystem events, catalog reads, and lineage reads retain their own concurrency behavior and are measured separately.

This remains separate from the sidebar fix in `9d3ae3adc7`, which does not own `ssh:state-changed`, remote-workspace preparation, or terminal binding cleanup.

## Goals

- Recover terminal panes without waiting for Git discovery on the same or another target.
- Keep coordinator-owned direct SSH provider work bounded and fair across targets.
- Make provider selection correct when repo IDs collide across local, direct SSH, and remote-runtime hosts.
- Reject obsolete provider results before any main or renderer authoritative mutation.
- Preserve final-state convergence for later same-connection remote snapshots and wake refreshes.
- Keep disconnect and retry scope symmetric across Git worktrees and folder workspaces.
- Preserve relay reattach identifiers and terminal/session recovery semantics.
- Make timeout, cancellation, non-authoritative data, and operational failure separately observable without exposing identifiers.

## Non-goals

- Changing SSH credentials, backoff policy, or user-facing reconnect controls.
- Moving runtime-owned work into the direct SSH coordinator.
- Changing the component-scoped sidebar refresh queue added by `9d3ae3adc7`; the shared detected-worktree provider coalescer does gain lease accounting.
- Expanding remote-workspace serialization to folder workspaces.
- Changing Git commands, worktree parsing, or Git capability detection.
- Changing the remote-runtime wire protocol.
- Establishing a renderer-wide or application-wide provider-call ceiling.

## Current flow and root cause

### Connected path

`applySshConnectionStateChange` currently:

1. filters `store.repos` by raw `connectionId`;
2. calls `Promise.all(remoteRepos.map(fetchWorktrees))`;
3. calls `fetchWorktreeLineage`;
4. scans target worktrees and bumps terminal generations one worktree at a time; and
5. calls `syncRemoteWorkspaceAfterConnect`.

`syncRemoteWorkspaceAfterConnect` calls `prepareRemoteWorkspaceTarget`, repeating repo and lineage refresh. A nonempty snapshot then reaches `applyRemoteWorkspaceSnapshot`, which prepares a third time.

For a target with `R` repos, the connected path therefore performs `2R` detected-worktree scans and two lineage reads without a snapshot, or `3R` scans and three lineage reads with one. The existing detected-worktree single-flight joins only requests whose provider reads overlap. These preparation waves are sequential in the current call chain, so it does not collapse their scan count. Other overlapping callers can still join a scan; telemetry must measure observed calls rather than infer a global `kR` multiplier.

### Disconnect path

Terminal failure states walk repo-derived worktrees and call `clearTabPtyId(tab.id)` for each tab whose `ptyId` is present. The general single-tab action scans workspace buckets, clones global terminal maps, publishes store changes, bumps worktree activity, and can persist metadata on every call.

For `T` live tabs, `W` workspace buckets, and terminal maps of size `M`, synchronous work is approximately `O(T × (W + M))`, plus repeated Zustand publications and session-persistence debounce resets. Connection loss is not user activity.

### Boundary and ownership defects

- Renderer `fetchWorktrees(repoId, { executionHostId })` uses the host to choose and stamp renderer ownership, but the local preload/main request currently carries only `repoId`.
- Main then calls first-match `store.getRepo(repoId)` and cannot enforce the renderer's intended host. The proven producer is renderer-catalog aliasing across hosts, not duplicate UUID rows created by main; same-ID main rows remain a defensive ambiguity case.
- Main can prune lineage and backfill metadata before renderer receives a result, so a renderer-only stale-result fence is insufficient.
- Current main-owned `connectionGeneration` and the renderer-local state-change counter have different sources and advance rules. Only the main-owned value is authoritative.
- Relay replacement can change the provider incarnation without advancing the existing main-owned generation. The correction is to rotate the generation and provider epoch together, not to use the renderer counter.
- Raw repo-ID filtering can select another execution host. Folder workspace keys are omitted entirely.
- Direct SSH catalog and lineage preparation follows focused-runtime ownership in some paths.
- Direct SSH lineage preparation currently calls bare `fetchWorktreeLineage()`, whose ownership can follow focused-runtime settings rather than the SSH target.

### Deterministic current-main baseline

The falsifiable current-main invariants are:

1. one connected direct SSH event must issue at most one detected-worktree scan per exact repo input and one host-qualified lineage read;
2. an authoritative detected-worktree or lineage result must identify one exact execution host and, for direct SSH, the complete provider authority;
3. explicit worktree, repo-derived, runtime-owner, folder, and PTY provenance must not contradict one another; and
4. a first timeout classified as retryable must not release lineage, sync, or token creation before its retry reaches a terminal outcome.

Current main violates the first two at the smallest deterministic seams:

- `applySshConnectionStateChange` runs `fetchWorktrees` plus lineage and then calls `syncRemoteWorkspaceAfterConnect`;
- `syncRemoteWorkspaceAfterConnect` calls `prepareRemoteWorkspaceTarget`, and a nonempty snapshot calls `applyRemoteWorkspaceSnapshot`, which calls it again;
- the shared renderer coalescer joins only overlapping promises and deletes the entry when they settle, so these awaited sequential waves remain `2R` scans and two lineage reads without a snapshot or `3R` and three with one;
- renderer refresh selection accepts `executionHostId`, while preload `worktrees.listDetected` and main `worktrees:listDetected` accept only `{ repoId }`; main then uses first-match `store.getRepo(repoId)`.

Baseline commands run from the rebased worktree:

```bash
pnpm install --frozen-lockfile
rg -n "prepareRemoteWorkspaceTarget|applyRemoteWorkspaceSnapshot|syncRemoteWorkspaceAfterConnect|store.fetchWorktrees|fetchWorktreeLineage" src/renderer/src/hooks/useIpcEvents.ts
rg -n "listDetected: \\(args: \\{ repoId: string \\}\\)|store.getRepo\\(args.repoId\\)" src/preload/api-types.ts src/main/ipc/worktrees.ts
pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/store/slices/worktrees.test.ts -t "coalesces concurrent duplicate refreshes for the same repo and host|keeps same-repo refreshes separate for different execution hosts|fetches the requested host when duplicate repo ids exist"
pnpm exec vitest run --config config/vitest.config.ts src/main/ipc/worktrees.test.ts -t "coalesces concurrent authoritative detected worktree scans"
pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/hooks/useIpcEvents.test.ts -t "clears stale remote PTYs when an SSH connection fully disconnects|waits for the remote workspace client id before dropping self notifications"
pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/hooks/ssh-reconnect-pane-retry.test.ts
pnpm exec vitest run --config config/vitest.config.ts src/main/ipc/ssh.test.ts src/main/ssh/ssh-channel-multiplexer.test.ts src/renderer/src/runtime/use-remote-runtime-recovery-triggers.test.ts -t "surfaces relay channel loss while the SSH connection remains alive|does not broadcast a premature connected when relay deploy fails|times out after 30s with no response|advances both recovery schedulers"
pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/terminal-pane/terminal-hidden-view-parking.test.ts src/renderer/src/components/terminal-pane/use-manual-terminal-worktree-parking.test.ts src/renderer/src/lib/manual-terminal-worktree-parking.test.ts
pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/lib/agent-background-session-launch-host.test.ts src/renderer/src/lib/launch-agent-background-session-remote.test.ts src/renderer/src/hooks/useAutomationDispatchEvents.test.ts src/renderer/src/components/terminal-pane/pty-connection.test.ts
pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/store/slices/worktree-by-id-index.test.ts src/main/runtime/rpc/terminal-output-frame-chunks-equivalence.test.ts
```

Results initially on `79ec57d04`, then rerun after rebasing through `974447175`: 3/3, 1/1, 2/2, 4/4, and 3/3 selected SSH seam tests passed respectively; the three newly relevant parking files passed 39/39. On `1fd0f731f`, the four folder-automation/adoption files passed 516/516. On `694363805`, the hydration-index and output-frame equivalence files passed 25/25. Source-contract inspection confirmed the `2R`/`3R` call graph and the dropped host field; later main changes did not alter those seams. This is the historical baseline evidence used to define the candidate oracles. Candidate runtime and Docker SSH evidence is recorded separately below.

### Candidate implementation and validation

The candidate implements the composed authority pair, host-qualified catalog/worktree/lineage reads, separate waiter and provider identities, five-slot fair scheduling with a seven-start provider budget, the first-timeout retry barrier, exact-target terminal recovery, fenced remote-workspace hydration, and privacy-safe aggregate telemetry. Coordinator routing defaults on and can be disabled per build with `VITE_DIRECT_SSH_RECONNECT_COORDINATOR=false` or per renderer session with `orca.directSshReconnectCoordinator.enabled=false`; the fallback retains host/authority fencing, atomic terminal recovery, and bounded preparation.

Deterministic validation on the final rebased implementation passed all 42 changed unit suites (1,960 tests), including the 11-file direct-SSH terminal gate (637 tests), the 11-file renderer provider/transport gate (763 tests), and the 12-file main/preload/runtime/shared authority gate (513 tests), plus full typecheck, changed-code quality, reliability-gate and max-lines checks, `git diff --check`, and an Electron E2E-mode build. The authority gate proves retained SSH connection and detected-port payload admission is wired into native preload and runtime-client/environment production routes. An earlier full `pnpm test` exercise ran 3,707 files and 39,083 tests; only two assertions in unchanged `agent-exec-handler.test.ts` failed because the managed terminal already injects `GIT_CONFIG_*` prompt settings. The file passed 10/10 with those inherited settings removed. Final exact-head CI evidence is recorded in the PR description.

Real transport validation used a macOS Electron headless client against an ephemeral Linux Docker SSH/relay target:

```bash
ORCA_E2E_SSH_DOCKER=1 SKIP_BUILD=1 pnpm exec playwright test \
  tests/e2e/ssh-docker-relay-perf.spec.ts \
  --config tests/playwright.config.ts \
  --project electron-headless \
  --workers=1

ORCA_E2E_SSH_DOCKER=1 SKIP_BUILD=1 pnpm exec playwright test \
  tests/e2e/ssh-cold-activation-restore.spec.ts \
  --config tests/playwright.config.ts \
  --project electron-headless \
  --workers=1
```

The four-test relay suite and the cold-restore journey passed. The relay suite covered streaming, a background ACK-stalled PTY, file/Git pressure, and live terminal input/output before and after SSH disconnect/reconnect; the reconnect case independently read the post-reconnect proof file inside the Linux container. The cold-restore journey proved all six restored SSH terminals remounted and accepted remote input after renderer reload. Repo registration waits on exact renderer catalog ownership and full authority, requires an authoritative host-qualified worktree response, and uses no timing sleep.

Remaining live gaps are headed paired-Orca-server and headless `orca serve` non-interference, WSL, physical Windows and Linux desktop clients, and a multi-target live fan-out/large-terminal-map benchmark. Docker SSH proves the direct SSH provider/relay path, not paired-runtime parity.

Current-main reconciliation:

- #8255 advances paired remote-runtime control and pane backoffs on resume/online. Direct SSH registers its own wake input and must not call or absorb that scheduler; one OS event may wake both ownership domains, but each exact pane finalizes at most once.
- #10986 correctly routes an exact worktree by its own host in multi-host projects. Direct reconnect reuses that worktree-specific precedence only after rejecting any contradictory provenance; it never falls back to project-wide repo ambiguity or focused-runtime ownership.
- #10129 makes capable paired-runtime reasonless close fail closed. Direct SSH cleanup clears transient bindings only: it never emits `session.tabs.close`, retires a tab, or kills a provider PTY.
- #10799 confirms runtime project setup must refuse `ssh:` rather than act locally. The desktop direct-SSH handler likewise rejects `runtime:` hosts, and runtime-owned SSH rows remain under runtime authority.
- #11016 parks terminal views without clearing their PTYs. Direct SSH binding cleanup does not invoke parking, close, or layout mutation; the mounted view observes the atomic PTY-state patch independently.
- #10818 routes folder automation through `getKnownWorktreeById` and ambiguity-aware `getFolderWorkspaceConnectionId`, and publishes agent tabs only after binding the spawned PTY. Direct reconnect uses the same effective folder connection as provenance, rejects mixed ownership, preserves agent state, and never treats an adopted PTY as live under a newer authority without matching binding evidence.
- #10891 preserves legacy first-wins semantics while indexing ID-only hydration lookups. Direct reconnect must not treat `buildWorktreeByIdIndex` as ownership proof: target hydration and reattach resolve a host-qualified worktree first and fail closed on duplicate or contradictory ownership.
- #10915 changes runtime output-frame chunking without changing PTY binding, authority, close intent, or hydration ownership. Direct reconnect does not reset output sequence state or reinterpret runtime frames.

## Invariants

### Authoritative provider authority

1. Main is the sole issuer of `SshProviderEpoch` and `connectionGeneration`. Renderer never increments, orders, parses, or synthesizes either value.
2. Direct SSH state is normalized to `providerEpoch: SshProviderEpoch | null` plus `connectionGeneration?: number`. Main-originated direct SSH state always carries a valid pair. `null` or a missing generation means unknown authority, not zero and not a renderer fallback.
3. A single `rotateSshProviderAuthority(targetId)` helper advances both values atomically before every provider-invalidating transition: new connect ownership, transport replacement or loss, relay/multiplexer replacement or loss, provider disposal, target readoption/reassignment, and permanent target removal. No producer may rotate or publish only one component.
4. `connectionGeneration` remains the existing SSH mutation expectation. Expanding its rotation set closes relay-only mutation races. Provider/reconnect operations compare the full `(providerEpoch, connectionGeneration)` pair; this is the formal composition rule, not two independent clocks.
5. Main registers the provider serving the new pair before broadcasting `connected`. A broadcast-first transition is invalid because it can start a preparation against an unregistered provider with no guaranteed self-heal event.
6. Renderer partial state writers are patches. They preserve both main authority fields and cannot author a `connected` state with a new value.
7. Every boundary that decides equality, copies state, admits retained state, preloads state, reconciles state, or republishes state must preserve both fields. This inventory includes `sshConnectionStatesEqual`, `admitSshConnectionState` and its byte/range checks, public-state projection, `ssh:getState`, `ssh:state-changed`, startup reconnect, runtime-client retained payloads, renderer/runtime SSH state stores, web-file mutation reads, and all fixtures/builders. Allowlisted clones must name both fields; equality treats either field changing as significant.
8. A recovery operation captures one exact `DirectSshAuthority = (targetId, providerEpoch, connectionGeneration)`. Equality is the only permitted authority operation.
9. If a connected event lacks either component, the renderer performs one bounded `ssh:getState` reconciliation with a per-target arrival watermark. The reply may fill authority only if no newer push event arrived and the stored event/status still matches the initiating event; it cannot transition status or resurrect an older `connected` state. If authority remains unknown, authoritative preparation, retry, sync, and snapshot mutation fail closed with `authority-unknown`; disconnect cleanup remains allowed.
10. After every await and inside every authoritative store updater, current state must still name the same connected target and exact authority pair.
11. Supersession is determined by coordinator arrival order and exact equality, never numeric ordering.
12. On any authority change, before new preparation admission, cancel the target's queued work, locally settle obsolete waiter leases, send exactly one cancellation for every affected in-flight provider request ID, mark all late results stale, and retain main-side post-await fences. Terminal finalization for the new authority does not wait for old relay work.
13. Exhausting one target's per-session generation counter rolls the process generation scope and revokes every direct SSH target, not only the target that exhausted its counter. Main invalidates every cached authority and aborts every registered provider request from the old scope before any target can publish or admit work under the new scope.

### Host-qualified ownership

1. Direct reconnect work owns only `toSshExecutionHostId(targetId)`.
2. Every coordinator detected-worktree provider invocation carries `(repoId, executionHostId, expectedAuthority, providerRequestId)`. Each renderer consumer separately owns a `waiterLeaseId`; a lease ID never crosses IPC or names provider work.
3. Main resolves a repo by the complete `(repo.id, executionHostId)` identity only after validating all present repo provenance. `executionHostId` and legacy `connectionId` must agree when both are present; a catalog row for which either source names the requested host while the other names another SSH, local, or runtime host makes the host catalog non-authoritative. Zero, contradictory, or multiple matches fail closed. Main never uses explicit-field precedence to hide a contradiction and never falls back to first-match `getRepo(repoId)` for a host-qualified request.
4. A local host request can select only a local repo. A direct SSH host request can select only the matching target/provider. A runtime host is rejected by the desktop handler and must use the existing runtime RPC route.
5. A successful response uses a local or direct-SSH discriminant. The direct-SSH variant cannot be constructed without the resolved execution host and full authority pair. Renderer validates the wire discriminant and rejects a mismatch before any use.
6. Runtime-owned or runtime-transported worktrees remain under the runtime environment scheduler, including SSH execution hosts whose `runtimeOwnerEnvironmentId` names a HUB.
7. Raw repo IDs, paths, UI focus, and unqualified legacy metadata are not ownership evidence. Pre-catalog scope resolution uses explicit worktree/repo provenance and `getExplicitRuntimeEnvironmentIdForWorktree`; it must not use the focused-runtime fallbacks in `getExecutionHostIdForWorktree` or `getRuntimeEnvironmentIdForWorktree`. `runtime:unresolved-owner` and focus-only results are ambiguous, not another host's. Unknown ownership is diagnostic and retryable, but never authoritatively replaced or deleted.
8. All present provenance must agree. Explicit worktree ownership takes precedence only after agreement is proven; repo-derived ownership is a fallback only when explicit worktree ownership is absent. A worktree stamped `ssh:B` with repo-derived `ssh:A`, or any direct-SSH row with an explicit runtime owner, is `contradictory-owner` and is preserved without refresh, merge, retry, or pruning.

### Merge fencing

1. Provider results are immutable until all host and authority checks pass.
2. Main revalidates the request host, provider instance, and exact authority after the provider await and before:
   - remembering worktree roots;
   - pruning persisted lineage;
   - stamping or backfilling worktree metadata; or
   - returning an authoritative result.
3. Renderer revalidates immediately after the preload/runtime await and before any use of the result, including:
   - `routeListingBranchSwitchesThroughGitIdentity`;
   - hosted-review sanitation;
   - `updateWorktreeGitIdentity`;
   - `buildWorktreePurgeState`;
   - `worktreesByRepo` or `detectedWorktreesByRepo` merges; and
   - best-effort lineage refresh.
4. Host-scoped catalog and lineage snapshots are revalidated before their sole renderer merge.
5. A remote-workspace token and snapshot revision are revalidated after hydration and immediately before session merge/publish. The merge also preserves any terminal-recovery revision newer than the snapshot operation.
6. Stale, superseded, timed-out, and canceled results perform zero authoritative mutations and are not logged as operational errors.

### Terminal state

The disconnect action preserves the current call-site predicate: a tab is affected only when `tab.ptyId != null`. A tab without a `ptyId` remains byte-identical even if it has `pendingActivationSpawn` or an inconsistent auxiliary PTY index.

For each affected tab, the atomic action must:

- set `tab.ptyId` to `null`;
- empty its `ptyIdsByTabId` entry;
- consume `pendingActivationSpawn`;
- remove pending Codex restart and restart-notice entries for the cleared live PTY;
- preserve `lastKnownRelayPtyIdByTabId` for relay-grace reattach and the `#9911` orphan-safety invariant; and
- leave layouts, deferred SSH sessions, pending reconnect IDs, suppression/shutdown guards, tab IDs, titles, generations, and agent state unchanged.

The action must not bump activity, sort worktrees, or persist worktree metadata. A repeat after all qualified bindings are clear returns the original store state.
It also must not emit `session.tabs.close`, `session.tabs.closeLifecycle`, provider shutdown, or process signals. Binding loss is not close intent, tab retirement, or proof that a PTY died.

Reconnect finalization must:

- use `shouldRetryPaneSpawnOnSshReconnect`;
- include exact direct SSH Git-worktree and folder-workspace keys;
- run synchronously before catalog or provider awaits;
- treat a non-null `ptyId` as live only when transient binding provenance names the current authority and the current tab-wide spawn/reattach attempt has established live authority;
- clear stale binding evidence from a missed disconnect or prior authority before testing retry eligibility;
- keep at most one tab-wide retry attempt in flight per tab and authority;
- join renderer pending-spawn promises only for the same retry attempt; authority or tab-generation advance starts independently, and a late obsolete fresh PTY is rejected and retired;
- accept a spawn or reattach acknowledgement only when its attempt, authority, tab generation, target-qualified PTY, and committed PTY index all match; the first split success establishes the tab fallback and a live continuation lease, and later or post-success-mounted siblings capture and commit through that exact lease without replacing the fallback;
- admit a reattach identity before publishing renderer PTY handlers; revalidate the captured lease after every asynchronous SSH preparation wait and, after the synchronous already-exited delivery case, before error or launch-metadata publication, deferred-state mutation, binding cleanup, or replacement spawn; drop stale owned handlers without killing the durable PTY a current lease may adopt;
- settle retirement of a newly created session-expired fallback when admission rejects it, including after transport destruction, and surface shutdown refusal as unknown, without killing a rejected reattach or cold restore that another current lease may adopt;
- preserve the continuation lease if its primary PTY exits while another split leaf from the same attempt is still activating, then promote the late sibling when it commits;
- on an attempt-one sibling failure or timeout, revoke that attempt and rotate the whole tab once; after attempt two is exhausted, retain its continuation lease for siblings already settling while forbidding attempt three;
- when a split pane detaches to a new tab, project the same exact live or pending authority and retry history to both resulting tabs, including a bound-plus-unbound split or an all-null continuation gap before any leaf binds; the detached null-PTY tab remains activation-pending, and a rejected acknowledgement or detach returns the original relevant maps unchanged;
- permit a tab hydrated, newly discovered, or left unbound after a failed spawn to receive a bounded same-authority corrective bump;
- update all affected workspace buckets in one Zustand publication; and
- leave preparation-only requests, nonqualifying tabs, and every other host unchanged.

The coordinator keeps separate authority-scoped pending-attempt state and successful-binding state, not a set of bump attempts and not a cached preparation outcome. The live binding carries the exact attempt ID as a continuation lease for every split leaf in that tab generation. A healthy live binding, including a bounded empty-primary activation gap, suppresses correction; an unresolved tab is reconsidered on wake, snapshot completion, and preparation completion with at most one tab-wide attempt in flight. One authority chain preserves its complete attempt history and has a hard limit of two automatic attempts. A timeout taking longer than the former rolling 30-second window cannot age out the first attempt and start a third automatic attempt; later wake, snapshot, and preparation triggers remain exhausted until authority replacement rotates pending, binding, and history state.

## Design

### 1. Composed provider authority and host-qualified IPC

Add `SshProviderEpoch` to the shared SSH types and compose it with the existing main-owned connection generation in `src/main/ssh/ssh-provider-authority.ts`. This module owns atomic rotation and delegates generation storage/assertion to `ssh-connection-generation.ts`; it does not introduce an independently advancing clock.

The direct SSH state boundary becomes:

```ts
type SshProviderEpoch = string & { readonly __sshProviderEpoch: unique symbol }
type ProviderRequestId = string & { readonly __providerRequestId: unique symbol }
type WaiterLeaseId = string & { readonly __waiterLeaseId: unique symbol }
type SshExecutionHostId = Extract<ExecutionHostId, `ssh:${string}`>

type DirectSshStateAuthority = {
  providerEpoch: SshProviderEpoch | null
  connectionGeneration?: number
}

type DirectSshAuthority = {
  targetId: string
  providerEpoch: SshProviderEpoch
  connectionGeneration: number
}
```

The epoch wire value is a bounded opaque string. Branding is compile-time only. Main state broadcasts and `ssh:getState` include the pair; renderer state stores it without interpretation. `rotateSshProviderAuthority` is the only transition writer and `assertSshMutationExpectation` observes the generation advanced by that same call.

Extend preload/main detected-worktree APIs:

```ts
type LocalDetectedWorktreeRequest = {
  providerRequestId: ProviderRequestId
  repoId: string
  executionHostId: typeof LOCAL_EXECUTION_HOST_ID
}

type DirectSshDetectedWorktreeRequest = {
  providerRequestId: ProviderRequestId
  repoId: string
  executionHostId: SshExecutionHostId
  expectedAuthority: DirectSshAuthority
}

type ListDetectedWorktreesArgs = LocalDetectedWorktreeRequest | DirectSshDetectedWorktreeRequest

type AuthoritativeHost =
  | {
      kind: 'local'
      executionHostId: typeof LOCAL_EXECUTION_HOST_ID
    }
  | ({
      kind: 'direct-ssh'
      executionHostId: SshExecutionHostId
    } & DirectSshAuthority)

type HostQualifiedDetectedWorktreeResult =
  | {
      status: 'complete' | 'non-authoritative'
      providerRequestId: ProviderRequestId
      repoId: string
      authority: AuthoritativeHost
      result: DetectedWorktreeListResult
    }
  | {
      providerRequestId: ProviderRequestId
      executionHostId: ExecutionHostId
      status:
        | 'canceled'
        | 'timed-out'
        | 'stale'
        | 'ambiguous-owner'
        | 'authority-unknown'
        | 'rejected'
    }
```

`DirectSshDetectedWorktreeRequest` requires the full pair as one `expectedAuthority`; local requests cannot carry it. Construction and runtime admission also require `executionHostId === toSshExecutionHostId(expectedAuthority.targetId)`. Every data-bearing direct-SSH response, including `non-authoritative` metadata fallback, is therefore impossible to construct without both fields. Runtime validation rejects decoded SSH data payloads missing either component even if an untyped or older boundary fabricates one. Main owns the 30-second provider deadline; no renderer-supplied timeout can extend it. The desktop handler rejects runtime hosts. Keep an explicitly unqualified legacy overload only for existing callers during migration; it fails closed when more than one host owns the repo ID and is removed after all callers pass a host.

Main selects the repo and provider before starting work, captures the provider object and full authority, and checks all three again after `provider.listWorktrees`. A host-qualified SSH response cannot be restamped by renderer as another host.

Use host-qualified lineage ownership as well:

```ts
type ListDesktopLineageForHostArgs =
  | { executionHostId: typeof LOCAL_EXECUTION_HOST_ID }
  | {
      executionHostId: SshExecutionHostId
      expectedAuthority: DirectSshAuthority
    }

type HostLineageSnapshot =
  | {
      authoritative: true
      authority: AuthoritativeHost
      worktreeLineageById: Record<string, WorktreeLineage>
      workspaceLineageByChildKey: Record<string, WorkspaceLineage>
    }
  | {
      authoritative: false
      executionHostId: ExecutionHostId
      reason: 'ambiguous-owner' | 'authority-unknown' | 'stale' | 'unavailable'
    }
```

Main filters the snapshot to the requested host. Renderer replaces only an authoritative discriminated host scope; malformed SSH authority is rejected before merge. Direct SSH preparation replaces the current bare `fetchWorktreeLineage()` call with this host-qualified API; it does not substitute `{ forceLocalOwner: true }`.

Main destructive pruning must use qualified repo/worktree ownership. An existing row `meta.hostId` must agree with the resolved repo host in every case. Only an absent legacy host may be inferred when exactly one stored repo owns the repo ID, preserving today's path-reuse cleanup. When multiple hosts can own the ID, pruning requires row `meta.hostId`; absence or conflict makes the result non-authoritative and preserves the row. Authoritative scans backfill absent `meta.hostId` so legacy rows self-heal. Never use repo-ID-prefix pruning across hosts.

The shared renderer store and web preload retain their existing non-direct-SSH callers. Preserve the legacy/runtime overload and its argument/echo shape in `web-preload-api.ts`, but do not broaden the web client into direct-SSH coordination: paired web clients cannot subscribe to desktop `ssh:state-changed`, so the proposed total direct-SSH web break is not reachable. Shared API type changes still receive compatibility tests so a runtime-routed web read is not rejected merely because the wrapper dropped its requested host.

### 2. Exact direct SSH target scope

Add `src/renderer/src/lib/direct-ssh-target-scope.ts`:

```ts
type DirectSshGitRepoRef = {
  repoId: string
  executionHostId: SshExecutionHostId
}

type DirectSshTargetScope = {
  catalogRevision: number
  gitRepos: DirectSshGitRepoRef[]
  gitWorktreeIds: Set<string>
  terminalWorkspaceKeys: Set<string>
  lineageWorkspaceKeys: Set<WorkspaceKey>
  ambiguousOwnerCount: number
  contradictoryOwnerCount: number
}
```

Resolution rules:

- Build the expected host with `toSshExecutionHostId(targetId)`.
- Resolve repos by `(repo.id, executionHostId)`.
- Collect explicit worktree host, exact repo-derived host, projected runtime owner, and any restored host evidence before selecting a row.
- If two present sources disagree, classify the row as `contradictory-owner`; preserve it and exclude it from refresh, merge, terminal retry, snapshot projection, and pruning.
- When explicit worktree host is present and no source contradicts it, require it to equal the expected host. Use exact repo-derived ownership only when the explicit worktree host is absent.
- Require `getExplicitRuntimeEnvironmentIdForWorktree` to be `null`; an explicit runtime owner contradicts direct SSH even when another source names the expected SSH host.
- Do not use focused-runtime fallback ownership during pre-catalog reconnect. Focus-only local/runtime results and `runtime:unresolved-owner` are ambiguous.
- Do not use `buildWorktreeByIdIndex`, raw `getKnownWorktreeById`, or another first-wins ID-only lookup as authoritative direct-SSH ownership. Hydration and reattach use an exact host-qualified row or fail closed.
- Accept a folder workspace only when its effective connection is exactly `targetId`, its execution host is expected, runtime owner is `null`, and all candidate repo/group/workspace provenance agrees.
- Treat mixed/conflicting folder provenance as contradictory; duplicate same-host owners and unresolved legacy rows are ambiguous/unowned.
- A parsed live app-SSH PTY can recover a stale-catalog terminal only when no explicit other-host or runtime ownership contradicts it.

Git refresh uses `gitRepos`; terminal clear/retry uses raw Git IDs and folder keys from `terminalWorkspaceKeys`; unified lineage uses `worktree:<id>` and folder keys from `lineageWorkspaceKeys`; snapshot projection uses `gitWorktreeIds`. Folder workspaces never enter the path-based remote-workspace schema.

When exact repo rows are missing, use a new host-scoped desktop catalog read rather than focused `fetchRepos()` or an all-desktop refresh:

```ts
listReposForExecutionHost({
  executionHostId,
  expectedAuthority
})
```

Main validates explicit and legacy ownership before producing the host snapshot. A row with contradictory `executionHostId` and `connectionId` cannot be filtered into one host by precedence or silently omitted from the other; a contradiction touching the requested host returns a non-authoritative catalog with no rows.

The renderer merges the immutable response into only that host scope after a full-authority fence. This action owns a per-host catalog revision and in-flight entry; it does not share `reposFetchGeneration` with focused-runtime or all-host fetches. Thus a concurrent runtime-focused catalog refresh cannot silently supersede direct SSH hydration.
Its authoritative response uses the same `AuthoritativeHost` discriminant as detected worktrees and lineage, so direct-SSH catalog data also requires the complete pair.

### 3. Bounded and cancelable direct SSH provider scheduler

Add `src/renderer/src/hooks/direct-ssh-worktree-refresh-scheduler.ts`. It is owned by the `useIpcEvents` effect and used only for direct SSH coordinator scans.

Required behavior:

- at most `DIRECT_SSH_WORKTREE_SCAN_CONCURRENCY` (five) locally unsettled coordinator-owned detected-worktree requests in flight;
- owner-aware round-robin selection by target, with repos submitted incrementally rather than flattening one target into a global FIFO;
- no fixed collection window for an idle singleton request;
- an input key of `(repoId, executionHostId, providerEpoch, connectionGeneration, catalogRevision, authoritative requirement)`;
- join only a currently running logical repo task with the exact same key;
- retain the logical key across a first `retrying` timeout and delete it only on a terminal outcome;
- explicit `complete`, `non-authoritative`, `timed-out`, `cancel-budget-exhausted`, `canceled`, `stale`, and `rejected` outcomes; and
- no console error or degraded count for expected cancellation/supersession.

Each provider invocation has the existing 30-second main-owned deadline. Main creates an `AbortController`, passes its signal to `SshGitProvider.listWorktrees`, and therefore reaches the multiplexer `rpc.cancel` path on timeout. A transient first timeout changes the repo task to `retrying` and requeues it once at the tail of that target's round-robin lane if the full authority remains current. That repo task promise does not settle, and target lineage/token creation does not start, until the retry completes, reaches its second timeout, is invalidated, or retry admission terminates as `cancel-budget-exhausted`. Add cancellation IPC keyed only by `providerRequestId`; authority advance, target invalidation, last-waiter release, and effect teardown abort matching main requests. Queued requests have no provider request ID and cancel without IPC.

The first timed-out provider invocation and its leases settle before retry admission. The logical repo task remains pending and acquires a fresh provider request ID plus fresh waiter leases for the retry; preparation waiters never reuse an already-canceled provider identity.

Cancellation uses waiter leases:

- `waiterLeaseId` and `providerRequestId` are different opaque types generated independently. A provider request ID names one underlying preload/main/provider invocation; every consumer of that shared invocation receives its own renderer-only waiter lease ID.
- The shared detected-worktree coalescer, not the direct coordinator alone, owns the lease registry so sidebar/filesystem consumers also keep a joined provider invocation alive.
- Canceling or superseding one lease settles only that consumer. It does not call cancellation IPC while any other lease remains.
- Releasing the last lease sends exactly one cancellation IPC carrying the provider request ID and captured host/authority. Main never receives, stores, or accepts waiter lease IDs.
- Main aborts the provider request when that cancellation identity matches or when provider authority is invalidated. It does not reconstruct waiter ownership.
- Local cancellation returns after waiter settlement and, for the last lease, main provider-promise settlement. `ssh-channel-multiplexer` rejects its local provider promise when it sends fire-and-forget `rpc.cancel`; no relay response is awaited.
- The scheduler releases the local slot when the underlying provider promise settles locally. The original relay handler may observe abort later, so this metric is not a hard relay-process concurrency claim.
- Track every locally canceled underlying call as conservative cancel debt on its provider instance. Admission requires `locallyUnsettled + cancelDebt <= DIRECT_SSH_PROVIDER_START_BUDGET` (seven), so five canceled calls permit at most two replacements and repeated cancel/retry cannot create unbounded client-originated work. Debt is not cleared by elapsed time or local promise settlement because neither proves relay completion; it clears only when the owning provider/multiplexer is disposed or replaced. A logical task denied admission by this budget settles terminally as `cancel-budget-exhausted`; it never waits for provider replacement and never leaves the preparation barrier pending indefinitely. A hard bound on handlers surviving disposal is impossible without a relay acknowledgement, so telemetry states this as a seven-start per-provider budget rather than a total remote-process guarantee.

```ts
type DetectedWorktreeRefreshLease = {
  waiterLeaseId: WaiterLeaseId
  providerRequestId: ProviderRequestId
  result: Promise<HostQualifiedDetectedWorktreeResult>
  release(reason: 'superseded' | 'invalidated' | 'stopped'): void
}
```

Each lease has its own settlement promise. Normal provider settlement resolves all remaining leases and removes the provider entry automatically; early `release` is idempotent and settles only that lease as canceled.

Every other preparation await is bounded too: host-scoped catalog and lineage IPC use five-second deadlines, workspace hydration retains its ten-second deadline, and existing remote-workspace RPC deadlines remain in force. Catalog and lineage waiters accept coordinator cancellation; because their main work does not launch a provider process, a late reply is discarded by the renderer fence rather than holding a scheduler slot.

The existing runtime project scheduler keeps its own five-worker pool, 250 ms debounce, and 5-second minimum interval. Sidebar and filesystem-event refreshes remain unchanged. Cross-subsystem isolation is intentional; the coordinator's bound is not presented as a renderer-wide bound.

Keep the public `detectedWorktreeRefreshKey` shape unchanged. Its in-flight entry records a provider invocation identity and a lease map; direct-SSH authoritative work may join only when host and full authority also match. An incompatible entry under the same public key gets a separate underlying invocation rather than an unsafe join. The coordinator's authority/revision key wraps this coalescer without fragmenting compatible sidebar or filesystem-event sharing. The shared coalescer owns provider request IDs and waiter leases; the coordinator owns authority/revision fencing, retry state, and scoped metrics.

### 4. Per-target reconnect coordinator

Add `src/renderer/src/hooks/direct-ssh-reconnect-coordinator.ts`, instantiated once in `useIpcEvents`:

```ts
type DirectSshAuthority = {
  targetId: string
  providerEpoch: SshProviderEpoch
  connectionGeneration: number
}

type PreparationInput = DirectSshAuthority & {
  catalogRevision: number
  repoRefs: DirectSshGitRepoRef[]
  authorityRequirement: 'required' | 'allow-metadata-fallback'
  snapshotRevision?: number
  reason: 'reconnect' | 'initial-hydration' | 'workspace-snapshot' | 'wake-refresh'
}

type DirectSshReconnectCoordinator = {
  requestReconnect(authority: DirectSshAuthority): Promise<ReconnectOutcome>
  prepareOnly(input: PreparationInput): Promise<PreparationOutcome>
  finalizeHydratedTerminals(authority: DirectSshAuthority): number
  correctUnboundTerminals(authority: DirectSshAuthority, reason: CorrectionReason): number
  replaceAuthority(authority: DirectSshAuthority): void
  invalidate(targetId: string): void
  stop(): void
}
```

There is no global reconnect wave and no authority-long prepared-outcome cache. Transient per-tab pending/live-binding state is separate and exists only to settle or re-arm terminal recovery.

`replaceAuthority` compares the complete authority tuple. An exact-equal replacement is a no-op: it does not settle leases, clear pending/live terminal state, cancel provider work, or fragment an overlapping preparation. Only a different tuple performs authority replacement.

#### Reconnect-finalization flow

```ts
async function requestReconnect(authority) {
  if (!isCurrentConnectedAuthority(authority)) return stale()

  // Authority replacement first settles all obsolete local leases and fences their late work.
  coordinator.replaceAuthority(authority)

  // A missed disconnect can leave a non-null PTY from the old provider incarnation.
  invalidateStaleDirectSshTargetPtyBindings(authority)

  // Terminal-critical and synchronous: no catalog, Git, lineage, or other target can gate it.
  const retried = retryDirectSshTargetPanes(authority)

  // Relay flapping never delays terminal recovery, but it does damp full Git preparation.
  if (!hasAuthorityBeenStableFor(authority, RELAY_LOST_STABILIZED_MS)) {
    scheduleLatestAuthorityPreparation(authority, RELAY_LOST_STABILIZED_MS)
    return terminalOnlyOutcome(retried, 'stabilizing')
  }

  const input = await capturePreparationInput(authority, 'reconnect')
  if (!input.ok) return terminalOnlyOutcome(retried, input.reason)

  const prepared = await prepare(input.value)
  if (!prepared.token || !isCurrentConnectedAuthority(authority)) {
    return combine(retried, prepared)
  }

  // Catch tabs whose exact ownership or hydration became visible during this target's preparation.
  const discoveredRetries = correctUnboundTerminals(authority, 'preparation-complete')
  void syncRemoteWorkspaceAfterConnect(prepared.token)
  return combine(retried + discoveredRetries, prepared)
}
```

The first terminal retry is complete before `capturePreparationInput` performs any await. Target B therefore retries even when target A has five slow provider requests. A same-authority duplicate runs bounded correction: healthy live bindings are no-ops, pending attempts are not duplicated, and failed/unbound tabs can re-arm. When workspace hydration completes, `finalizeHydratedTerminals` reruns against the current authority and handles newly hydrated or still-unbound tabs.

Preparation for each target progresses independently. While authority remains current, it performs its host-scoped lineage read only after every repo task reaches a terminal state: `complete`, `non-authoritative`, final `timed-out`, `cancel-budget-exhausted`, or `rejected`. Authority-wide `canceled`/`stale` returns without lineage or a token. A first retryable timeout is the nonterminal `retrying` state and cannot release lineage, terminal correction, sync, or token creation. The target never waits for another target's repos or lineage.

When authority rotates again within `RELAY_LOST_STABILIZED_MS` (currently five seconds), replace the delayed preparation with the latest authority and perform terminal finalization immediately. Only the authority that survives the stabilization window starts catalog/Git/lineage work. A same-authority wake during that window coalesces into the pending latest-authority preparation. This is damping, not an epoch-long result cache.

#### Preparation-only flow

`prepareOnly` runs catalog/worktree/lineage preparation and returns a token. It never invokes terminal retry and never starts reconnect sync. An unsolicited snapshot uses this mode, then applies that snapshot with the returned token.

Reconnect and preparation-only requests may share exact overlapping catalog, repo, or lineage promises through ref-counted waiter leases. Superseding one consumer settles only its lease; it does not abort work still owned by another current consumer. They do not share finalization side effects.

#### Input-scoped deduplication

Preparation captures concrete inputs: exact authority pair, catalog revision, sorted repo/host refs, authoritative requirement, and snapshot revision when present. Only currently overlapping operations with identical relevant inputs join.

Completed entries are removed immediately. Consequently:

- a later same-authority wake rebroadcast runs another bounded refresh;
- a later snapshot revision runs another bounded preparation;
- a newly discovered repo changes the catalog revision/repo fingerprint and cannot join an older scope;
- a snapshot received during reconnect can share the still-running provider reads; and
- the reconnect call chain can pass its completed token directly to sync/apply without a second preparation.

The token is an operation result, not a coordinator cache entry:

```ts
type DirectSshPreparationToken = {
  authority: DirectSshAuthority
  catalogRevision: number
  repoFingerprint: string
  authorityRequirement: PreparationInput['authorityRequirement']
  snapshotRevision: number | null
  outcome: 'complete' | 'degraded'
}

type SnapshotApplyToken = DirectSshPreparationToken & {
  snapshotRevision: number
}
```

An unsolicited snapshot passes its revision into `prepareOnly`, so the returned token is already snapshot-bound. Reconnect preparation returns `snapshotRevision: null`; after `remoteWorkspace.get`, sync revalidates authority and creates a `SnapshotApplyToken` by copying the fetched revision onto that token. `applyRemoteWorkspaceSnapshot` accepts only `SnapshotApplyToken` and requires exact revision equality, so it cannot reuse preparation across incompatible snapshots.

### 5. Fenced worktree, catalog, and lineage merges

Refactor detected-worktree listing so provider acquisition and store mutation are separate:

```ts
const listed = await listDetectedWorktreesForRepoCoalesced(request)
if (!isCurrentHostAuthority(request, listed)) return canceled('stale')

// No code using listed.result may occur above this fence.
return mergeDetectedWorktrees(listed.result, request)
```

`mergeDetectedWorktrees` performs the sole renderer mutation for that result. It owns git-identity routing, review-link sanitation, purge state, and both worktree maps in one fenced path. It must not start an unfenced lineage refresh.

The existing shared coalesced refresh key already includes `executionHostId` and remains unchanged. Add the full authority and concrete input revision only to the coordinator wrapper key. Do not describe host parsing as new key behavior and do not alter cross-subsystem coalescing.

Host-scoped catalog and lineage functions likewise return immutable results. Each has one merge entry point that revalidates the current exact authority inside the Zustand updater. A stale result produces zero publications.

Main uses the same pattern around provider work:

```ts
const authority = resolveExactProvider(args)
const gitWorktrees = await authority.provider.listWorktrees(repo.path, { signal })
if (!stillOwnsExactProvider(authority, args.expectedAuthority)) return stale()

return buildAndCommitAuthoritativeResult(authority, gitWorktrees)
```

No prune, root-memory update, or metadata backfill occurs before `stillOwnsExactProvider`.

### 6. Atomic terminal disconnect and retry

Add terminal-slice actions:

```ts
clearDirectSshTargetPtyBindings(targetId: string): number
invalidateStaleDirectSshTargetPtyBindings(authority: DirectSshAuthority): number
retryDirectSshTargetPanes(authority: DirectSshAuthority): number
settleDirectSshPaneRetry(result: DirectSshPaneRetryResult): void
```

Put pure projections in `src/renderer/src/store/slices/direct-ssh-terminal-recovery.ts`.

`clearDirectSshTargetPtyBindings` traverses `tabsByWorktree` once, selects exact target scope, then applies the `tab.ptyId != null` predicate. For every affected tab the same atomic projection sets `tab.ptyId` to `null`, empties its `ptyIdsByTabId` entry, consumes `pendingActivationSpawn`, and removes pending Codex restart/restart-notice entries for the cleared live PTY. It preserves `lastKnownRelayPtyIdByTabId`, layouts, deferred SSH sessions, pending reconnect IDs, shutdown/suppression state, IDs, titles, generations, and agent state. It lazily clones only changed workspace arrays and maps, commits one patch, and triggers no activity, sorting, or metadata persistence. Tabs without a current `ptyId`, including those with `pendingActivationSpawn`, are untouched.

`invalidateStaleDirectSshTargetPtyBindings` validates the authority inside the updater and applies that complete atomic projection to a non-null `ptyId` when its transient `ptyAuthorityByTabId` does not equal the current authority. Snapshot-imported or legacy bindings without current-authority provenance are wake hints, not live bindings.

`retryDirectSshTargetPanes` validates the exact authority inside the updater, resolves scope from that same state snapshot, applies `shouldRetryPaneSpawnOnSshReconnect` plus stale-binding evidence, excludes only current live-success and pending-attempt tab IDs, and commits one `tabsByWorktree` patch. It records a unique tab-wide attempt outside the success ledger. `settleDirectSshPaneRetry` records current-authority success only after a live PTY binding is committed. A failed or timed-out first attempt rotates the tab once; an exhausted second attempt retains continuation authority for sibling callbacks but cannot start a third attempt.

`clearTabPtyId` keeps genuine single-PTY exit semantics, but split recovery adds two exact-authority projections: promote an already-bound surviving PTY under the same lease, or preserve the lease and activation suppression across an empty-primary gap until a same-attempt sibling commits or settles. `syncPaneDetachPtyOwnership` likewise projects one current split lease and history to both resulting tabs without spawning, exiting, or changing authority, even when the pending attempt has not produced its first PTY. A pane mounted after the first sibling succeeds captures the retained live lease; every spawn callback rechecks the full authority pair and retires a stale provider PTY. Permanent target removal continues through `src/renderer/src/store/slices/ssh-target-cleanup.ts`, whose deletion of last-known and deferred liveness is invalid for a reconnectable disconnect.

`applySshConnectionStateChange` receives an explicit origin and becomes orchestration:

```ts
type SshStateApplyOrigin = 'push' | 'initial-hydration'

const applySshConnectionStateChange = (targetId, state, origin: SshStateApplyOrigin) => {
  const previous = getSshConnectionState(targetId)
  setSshConnectionState(targetId, state)

  if (isTerminalFailure(state.status)) {
    coordinator.invalidate(targetId)
    clearRemoteDetectedAgents(targetId)
    clearPortForwards(targetId)
    setDetectedPorts(targetId, [])
    clearDirectSshTargetPtyBindings(targetId)
    return
  }

  if (state.status === 'connected') {
    if (!state.providerEpoch || state.connectionGeneration === undefined) {
      void reconcileAuthorityOnce({
        targetId,
        initiatingEventWatermark: getStateEventWatermark(targetId),
        initiatingState: state,
        initiatingOrigin: origin
      }).then(applyAuthorityPatchIfStillCurrent)
    } else {
      const authority = {
        targetId,
        providerEpoch: state.providerEpoch,
        connectionGeneration: state.connectionGeneration
      }

      if (origin === 'initial-hydration') {
        coordinator.replaceAuthority(authority)
        void coordinator.prepareOnly({
          ...authority,
          authorityRequirement: 'required',
          reason: 'initial-hydration'
        })
      } else if (
        previous?.status !== 'connected' ||
        previous.providerEpoch !== state.providerEpoch ||
        previous.connectionGeneration !== state.connectionGeneration
      ) {
        void coordinator.requestReconnect(authority)
      } else {
        coordinator.correctUnboundTerminals(authority, 'wake-refresh')
        void prepareAndSyncWithoutHealthyTerminalRemount({
          ...authority,
          reason: 'wake-refresh'
        })
      }
    }
  }
}
```

Increment the per-target state-event watermark before applying every push event. `setSshConnectionState` must publish when either authority component changes. Reconciliation may only patch missing authority onto the still-current initiating state; it never enqueues a complete stale state reply.

The terminal-failure cleanup order remains `clearRemoteDetectedAgents`, `clearPortForwards`, `setDetectedPorts([])`, then atomic PTY binding clear. Preserve the current port-broadcast race defense and detected-agent re-detection behavior.

An already-connected same-authority rebroadcast is a wake refresh, not a healthy-pane remount. It performs bounded unbound/stale correction, fresh bounded preparation, and sync. Initial hydration always carries `origin: 'initial-hydration'` and uses `prepareOnly`; it is never inferred from the absence of `previous`. A bounded authority reconciliation retains the initiating origin, so filling a retained state's missing pair also cannot become a reconnect transition. Hydrating an already-live state must not remount healthy panes. Workspace session completion invokes `finalizeHydratedTerminals` only for reconnect authorities recorded during that hydration interval, but a failed/unbound attempt remains eligible for later same-authority triggers.

## Remote-workspace data flows

### Reconnect sync

1. Reconnect finalizes qualifying terminals immediately.
2. Its target-scoped preparation returns a token.
3. Before awaiting `remoteWorkspace.get`, `syncRemoteWorkspaceAfterConnect(token)` captures whether the exact target currently has local tabs. This capture-before-await ordering is load-bearing.
4. The function validates the token, obtains the snapshot, and passes the same token to `applyRemoteWorkspaceSnapshot`.
5. Snapshot apply does not prepare again and is preparation-only with respect to coordinator retry; existing snapshot-driven `reconnectPersistedTerminals` behavior remains.
6. For `revision === 0`, mark hydration and publish the current local session only when the pre-await `hasLocalTabs` capture was true. Revalidate authority before upload. Do not recompute that predicate after preparation/hydration, which could overwrite a newer relay snapshot with locally imported state.
7. Snapshot projection and persisted-terminal reconnect receive only host-qualified worktree references from the token's exact target scope. They cannot reset, replace, remove, or reattach sibling SSH, local, WSL, or runtime-owned tabs or their PTY indexes, layouts, active selection, generations, retry state, or live-binding state, even when raw repo/worktree IDs or paths collide.

### Unsolicited snapshot

1. Capture current target authority and the incoming snapshot revision.
2. Call `prepareOnly` with those concrete inputs.
3. Wait for existing workspace-session hydration, bounded by the current 10-second deadline.
4. Capture the target terminal-recovery revision and same-ID local tab recovery fields before snapshot projection.
5. Revalidate the token, snapshot revision, arrival order, and recovery revision immediately before merge. If recovery advanced, rebase the projection on the latest local recovery fields rather than applying the stale captured copy.
6. Apply once as preparation-only. For a same-ID tab, preserve any newer local `generation`, pending attempt, successful current-authority binding, and terminal-recovery revision. Remote `generation` is not comparable across clients and cannot overwrite a local retry. Imported `ptyId`/pending reconnect data is a wake hint until `reconnectPersistedTerminals` settles and current-authority binding provenance is recorded.
7. Run the target-scoped, host-qualified `reconnectPersistedTerminals`, then `finalizeHydratedTerminals` for a reconnect authority. A failed reattach clears pending state and re-arms correction; a successful exact reattach atomically retires its pending attempt and records the current binding without an extra bump.
8. If path resolution still reports unknown worktrees, record a degraded result; do not loop unboundedly.

A later same-authority snapshot always receives a new preparation attempt after earlier work completed. This preserves convergence when another client creates a worktree while the connection stays live.

Remote snapshot identity is repo-qualified where the schema provides repo identity: resolve by `(executionHostId, repoId, normalizedPath)` and fail closed on ambiguity. For legacy path-only entries, retain the existing resolver only when the path has exactly one candidate in the exact target scope. Two worktrees at the same absolute host path were not proven producible, so this is a robustness invariant rather than a claim that current storage necessarily creates that collision.

The existing `buildWorktreeByIdIndex` and `reconnectPersistedTerminals` path retains first-wins ID-only compatibility for its current callers. Direct-SSH snapshot apply must pass host-qualified worktree refs through a dedicated overload or pre-resolved map; it cannot hand raw IDs back to an ID-only lookup and recover authority afterward.

## Failure handling

- **Unknown authority:** reconcile once behind the per-target arrival watermark; then fail closed with a retryable diagnostic. Do not use a renderer counter or apply the reply's status.
- **Catalog timeout/failure:** retain cached exact-owner scope, record degradation, and continue target preparation and already-completed terminal recovery.
- **One repo is non-authoritative:** keep its safe metadata fallback separate from operational failure and do not authoritatively delete rows.
- **One repo times out:** the provider invocation settles locally and sends best-effort cancel. On the first retryable timeout, keep the logical repo task and target preparation barrier pending in `retrying`, then requeue once at the target lane tail. A second timeout is final and degrades the repo. If current-provider cancel debt denies retry admission, settle the logical task as terminal `cancel-budget-exhausted`; this releases one degraded preparation outcome rather than an early-success token or an indefinite wait. None of these states blocks another target's terminal retry.
- **One repo rejects:** locally settle it without retry unless classified by the existing narrow transient predicate; operational rejection remains distinct from timeout and non-authoritative data.
- **Lineage timeout/failure:** preserve current lineage, mark target preparation degraded, and continue sync with exact cached worktree scope.
- **Authority advance or target invalidation:** synchronously cancel queued work, settle obsolete local waiter leases, send exactly one cancellation for every affected in-flight provider request ID, rotate renderer in-flight inputs and terminal-attempt state, and reject late results at both main and renderer fences. The new authority begins terminal finalization without waiting for relay acknowledgement.
- **Relay flapping:** finalize terminals for every new authority, but replace/defer full preparation until the latest authority survives `RELAY_LOST_STABILIZED_MS`.
- **Missed disconnect/stale binding:** clear only PTY bindings whose transient binding authority is absent or old, retain last-known relay identifiers, then retry under the new authority.
- **Failed terminal spawn/reattach:** settle the attempt as failed, remove it from pending/success state, and allow rate-limited correction on later preparation, hydration, snapshot, or wake triggers.
- **Workspace hydration timeout:** set existing per-target sync error; do not undo terminal or worktree recovery. Snapshot merge never replaces a newer local recovery revision.
- **Coordinator stop:** cancel queued work, locally settle every waiter, send best-effort aborts for unshared provider calls, and return without waiting for relay acknowledgement. Effect cleanup stops coordinator after subscriptions and before disposing its dedicated scheduler.
- **Unknown owner:** preserve state, count it, and retry on later host-qualified catalog input.
- **Contradictory owner:** preserve state, report the conflicting provenance classes without identifiers, and do not retry or mutate that row until a later catalog revision changes the evidence.

No failure path falls back to unbounded `Promise.all`.

## Observability

Emit one aggregate diagnostic per target operation, not per global wave and not per repo/tab. Use `[direct-ssh-reconnect]` for reconnect finalization and `[direct-ssh-prepare]` for preparation-only work.

Fields:

- mode and reason;
- terminal panes retried, stale bindings cleared, successful corrections, and terminal-finalization duration;
- catalog outcome and duration;
- repo tasks completed, non-authoritative, retrying, final timed-out, cancel-budget-exhausted, canceled, stale, and rejected;
- direct-scheduler queue-wait and provider-execution duration distributions;
- timeout retry count, local waiter settlements, cancel debt, and replacement admissions delayed by cancel debt;
- peak locally unsettled coordinator-owned detected-worktree concurrency and estimated late-work allowance;
- lineage outcome;
- Git-worktree, folder-workspace, ambiguous-owner, and contradictory-owner counts;
- overlapping request joins;
- authority rotations observed and preparations damped during flapping;
- total target-operation duration.

Expected supersession/cancellation is debug-level and does not increment degraded/error metrics. Timeout is separate from queue wait and operational rejection. `fetchWorktrees === false` is not used as a failure proxy; the new discriminated result preserves non-authoritative versus rejected outcomes.

Do not log target IDs, repo IDs, paths, labels, hosts, usernames, credential errors, snapshot content, raw request IDs, or terminal output. A stable per-session opaque target alias may correlate concurrent aggregate events and is discarded at process exit.

The product event deliberately omits terminal correction failure/re-arm counts, concurrent non-coordinator call counts, and arrival-order discard counts because this implementation has no truthful production observation for them. It does not populate unobserved fields with constant zeroes.

Typed product telemetry is implemented with one strict identifier-free aggregate event per target operation. Queue and provider percentiles are derived from that operation's real scheduler samples. The seven-day dogfood dashboard/query is operational follow-up outside this repository; this PR does not claim a dashboard artifact. Schema tests reject identifiers and keep queue wait, execution, timeout, operational rejection, cancellation, and stale results distinct.

The concurrency metric is explicitly `coordinator_owned_direct_ssh_detected_worktree_concurrency`. It measures locally unsettled provider promises and says nothing about runtime lineage RPCs, sidebar's eight-worker pool, filesystem-event calls, catalog/lineage IPC, total application provider concurrency, non-coordinator same-connection calls, or relay handlers finishing after local cancel.

## Tests

This implementation registers the worktree scan-count, host/authority, timeout-barrier, and no-cross-host mutation oracles in the existing `git-worktree.refresh-event-semantics` gate. It extends `terminal-provider.ssh-remote-reattach-contract` for direct-SSH binding clear/retry, hydration, folder workspace, paired-close non-interference, and #8255 wake isolation. A new reliability gate is unnecessary because those existing gates own the lifecycle contracts.

### Main/preload host and authority contract

- Preload forwards `repoId`, `executionHostId`, the complete expected authority, and `providerRequestId` unchanged; main owns the deadline and never receives `waiterLeaseId`.
- Renderer host intent across local, direct SSH A/B, and runtime-alias catalog rows routes to the exact provider. Fabricated duplicate main-store rows still fail closed as defense in depth.
- Desktop main rejects a runtime execution host.
- Zero or multiple same-host matches fail closed; unqualified legacy calls fail closed when ownership is ambiguous.
- Compile-time fixtures cannot construct a direct-SSH `complete` result or `authoritative: true` lineage snapshot without both authority fields. Runtime admission rejects malformed wire values that omit either field. Local authoritative variants carry neither SSH field.
- A response echoes exact host and complete authority; renderer rejects any host, target, epoch, generation, provider request, or discriminant mismatch.
- Relay loss/replacement, transport loss/replacement, provider disposal, target readoption, and permanent removal rotate epoch and generation in one helper.
- A per-target generation counter exhaustion rolls the process generation scope, revokes every target's old authority and mutation token, and aborts every old-scope provider request before new-scope admission.
- Relay-only replacement rejects both old reconnect/provider work and an old `SshMutationExpectation`.
- A fresh `connected` authority is not broadcast until its provider is registered.
- An old provider result after any rotation performs no root-memory, lineage-prune, or metadata-backfill mutation.
- Cancellation and timeout reach the provider `AbortSignal` and multiplexer `rpc.cancel`.
- Duplicate repo IDs never trigger cross-host repo-prefix lineage pruning.
- Legacy lineage prunes under a unique repo owner, ambiguous legacy rows are preserved, and an authoritative scan backfills `meta.hostId`.
- `sshConnectionStatesEqual`, retained-payload admission, public projection, preload push/get, startup reconnect, runtime retained/client payloads, renderer/runtime stores, and state builders preserve both authority fields.
- Main-originated broadcasts always publish the complete authority pair. Malformed epoch-only or generation-only retained inputs are rejected; compatibility push/get inputs can only remain `authority-unknown` for bounded reconciliation and perform no authoritative mutation. One valid pair change publishes once and an exact duplicate is a no-op.
- Retained-state admission accepts a bounded valid epoch, rejects malformed/oversized epochs, and never strips a valid authority component.
- The web preload compatibility overload preserves requested-host echo for runtime reads; this does not enable direct-SSH coordination in paired web clients.
- A stale `ssh:getState` reply arriving after a disconnect/reconnect push cannot change status or fill authority; a same-watermark reply can fill only missing authority.
- Main host-catalog admission rejects a row whose explicit execution host contradicts its legacy connection host; it returns no authoritative rows instead of selecting or hiding that row by precedence.

### Renderer worktree/catalog/lineage fences

- The coordinator in-flight key differs by host, full authority, catalog revision, and authoritative requirement; the shared coalescer key remains unchanged.
- Inputs that differ only by `authorityRequirement` do not join, and the resulting token echoes that exact requirement.
- Exact overlapping requests join; the same key after completion runs again.
- An old result after disconnect/reconnect or relay-only replacement causes zero store publications.
- Git identity, hosted-review links, purge state, both worktree maps, and best-effort lineage remain byte-identical on stale results.
- Local, another SSH target, and runtime owners with the same repo ID remain unchanged.
- Target snapshot hydration and persisted-terminal reconnect use host-qualified worktree references, prune the retry/live/history ledgers of tabs authoritatively deleted from that exact scope, and leave retained or sibling SSH, local, WSL, folder, and runtime tabs, PTY indexes, layouts, active state, generations, and recovery ledgers unchanged.
- A renderer worktree result is admitted only while every current same-ID repo row still has valid, non-contradictory explicit/legacy ownership; malformed or contradictory provenance introduced during the provider await makes the result stale without store mutation.
- A target-scoped catalog fetch cannot be superseded by focused-runtime `fetchRepos`.
- Host-scoped lineage deletes a stale direct SSH row while preserving local, another SSH target, runtime, and unknown-owner rows.
- Runtime-focused UI state cannot redirect direct SSH catalog, worktree, or lineage ownership.
- An ID-only first-wins hydration index containing the same worktree ID under SSH A and SSH B is never authoritative for direct reconnect; a target-B snapshot reattaches only the host-qualified B row or fails closed.
- Pre-catalog direct SSH scope with a focused runtime treats focus fallback as ambiguous and still recovers tabs supported by explicit PTY/host provenance.
- An explicit `ssh:B` worktree with repo-derived `ssh:A` is `contradictory-owner` for both targets and remains byte-identical. The inverse mismatch, an SSH host plus explicit runtime owner, and conflicting folder group/repo connections fail the same way.
- Repo-derived ownership is accepted only when explicit worktree ownership is absent; adding a conflicting explicit owner converts the same row from accepted to preserved/contradictory without cross-host deletion.
- Git 2.25-compatible worktree fallbacks remain unchanged.

### Direct SSH scheduler/coordinator

- A singleton reconnect begins terminal finalization immediately without a collection delay.
- Target B terminal finalization completes while all five direct provider slots are occupied by target A.
- Target B's first repo starts after at most one bounded provider deadline when it arrives behind five A calls.
- Round-robin admission prevents a large target from continually reoccupying every released slot.
- Peak coordinator-owned detected-worktree calls is five; runtime/sidebar activity can raise total app concurrency without failing this assertion.
- Joined consumers receive distinct waiter lease IDs and one shared provider request ID. Canceling one settles only that lease while the other completes from the original call; no provider cancel is sent.
- Last-waiter release sends exactly one cancellation for that shared provider request ID. Authority invalidation sends exactly one cancellation for each affected in-flight provider request, including multi-repo preparation; no cancellation is sent merely because one lease leaves while another current-authority lease still owns that invocation. A waiter lease ID presented to main is rejected and cannot abort provider work.
- A coordinator lease joining sidebar/filesystem work cannot abort that work when the coordinator is superseded; the remaining non-coordinator lease keeps the provider request alive.
- A timeout sends `rpc.cancel`, settles locally, and releases its local slot without a relay acknowledgement.
- Repeated timeout replacements never exceed the two-call cancel-debt allowance; denied work settles as terminal `cancel-budget-exhausted` and is reported separately.
- After a first retryable timeout, the repo task is `retrying`: lineage calls, preparation tokens, sync, and snapshot apply remain at zero until the retry settles.
- A successful retry then releases one lineage read and one token; a second timeout or cancel-budget exhaustion releases a degraded result without starving another target.
- An exact-equal `replaceAuthority` call preserves every pending lease, live binding, and overlapping preparation and sends no cancellation.
- A same-authority reconnect rechecks terminals but does not rebump a healthy current-authority binding.
- A newly hydrated tab receives one retry later under the same authority.
- A tab whose exact ownership becomes visible during that target's preparation receives one retry without delaying the first terminal finalization.
- An authority advance with five old slow calls cancels queued work, settles/aborts old leases, starts new terminal finalization immediately, admits new work under cancel-debt rules, and permits zero old main/renderer mutations.
- A changed authority supersedes old target work by arrival, without numeric comparison.
- A same-authority connected rebroadcast performs bounded correction plus preparation/sync without retrying healthy terminals.
- A failed or timed-out pane on attempt one rotates the tab once; attempt-two failure cannot start attempt three or revoke continuation authority from siblings already settling.
- Three authority rotations inside the stabilization window perform three immediate terminal checks but only one full preparation for the final stable authority.
- `prepareOnly` never invokes terminal retry or reconnect sync.
- A preparation-only request shares exact in-flight repo work with reconnect preparation but not reconnect finalization.
- A completed preparation never suppresses a later same-authority wake or snapshot preparation.
- Stop locally settles queued/in-flight waiters without waiting for relay acknowledgement and prevents post-stop finalization.
- One system resume/browser-online event advances #8255 remote-runtime backoffs and direct-SSH wake preparation independently; runtime-owned SSH rows never enter the direct coordinator, and a direct tab already live under current authority is not double-bumped.

### Atomic terminal recovery

- Many live tabs/worktrees clear in one store publication; a second clear is a true no-op.
- Only tabs with `tab.ptyId != null` are changed.
- A null-PTY tab with `pendingActivationSpawn` remains byte-identical.
- A live-PTY tab consumes `pendingActivationSpawn` in the same patch that clears its tab and split-pane PTY indexes.
- `lastKnownRelayPtyIdByTabId` survives and the `#9911` orphan predicate remains reconnectable.
- Live split-pane PTY indexes and Codex restart metadata clear.
- Layouts, deferred sessions, pending reconnect IDs, shutdown/suppression state, titles, and agent state remain unchanged.
- No worktree activity, sorting, or metadata persistence occurs.
- Exact target A clear/retry leaves target B, local, WSL, floating, and runtime-owned tabs unchanged even with duplicate repo IDs.
- Exact direct SSH folder workspaces clear/retry; mixed, ambiguous, and runtime folders do not.
- A parsed target PTY recovers a stale-catalog tab only without contradictory ownership.
- A relay/provider replacement after a missed disconnect clears a pre-authority `ptyId` and retries it while preserving last-known relay IDs.
- Binding provenance for another authority or no provenance is stale; a successful current-authority spawn becomes live and suppresses healthy correction.
- One authority chain permits at most two automatic correction attempts even when each timeout exceeds 30 seconds; later same-authority triggers remain exhausted until authority replacement.
- Rejected stale/mismatched acknowledgements preserve every store map and publish nothing. Concurrent split spawn or reattach acknowledgements share one exact attempt; the first establishes the fallback/live lease, and both already-mounted and post-success-mounted siblings join it.
- Primary exit before a sibling binds preserves the exact continuation lease and activation suppression; the sibling then becomes the fallback without a corrective remount.
- Primary and non-primary split detach both preserve exact authority and retry history on the surviving source and detached destination; an all-null pending-only detach preserves the lease before either side binds, and a same-authority correction leaves both live.
- Disconnect retains exact existing ordering and effects for `clearRemoteDetectedAgents`, `clearPortForwards`, `setDetectedPorts([])`, and atomic PTY clear.
- Disconnect and reconnect emit zero paired `session.tabs.close`/`closeLifecycle`, provider shutdowns, or process signals.
- A manually parked direct-SSH worktree follows the same store patch and retry eligibility without invoking parking, close, or layout mutation.

### Remote-workspace and hydration integration

- Connect plus sync performs one logical preparation and passes its token through a nonempty snapshot apply without preparing again.
- An unsolicited snapshot joins exact in-flight preparation but starts a new preparation after that work settles.
- A later same-authority snapshot referencing a newly created worktree resolves and imports its tabs.
- Preparation-only snapshot handling never bumps terminal generations.
- Preparation-only means no coordinator generation bump; existing snapshot-driven terminal reattach remains and is finalized afterward.
- Initial hydration with no previous renderer state follows the explicit `initial-hydration` origin into `prepareOnly` and performs zero reconnect retries; reconciliation retains that origin.
- Reconnect finalized before session hydration retries newly hydrated tabs exactly once afterward.
- Immediate finalization bumps a tab, then a snapshot with the same stable tab ID and an older/absent generation cannot reduce the local generation or suppress correction.
- Snapshot hydration that lands after a newer local retry preserves the newer terminal-recovery revision, pending attempt, and current binding provenance.
- Snapshot-imported `ptyId` without current-authority live evidence remains retry-eligible; successful exact target-scoped `reconnectPersistedTerminals` retires the pending attempt and records it live, while failure re-arms it.
- Snapshot projection and reconnect are host-qualified end to end; another SSH target, local, WSL, and runtime-owned state remain byte-identical despite colliding raw IDs or paths.
- Same-authority wake rebroadcast performs bounded fresh discovery.
- Revision-zero sync captures `hasLocalTabs` before `remoteWorkspace.get`, uploads only on that capture, and revalidates authority before publish.
- Snapshot apply rejects a token whose `snapshotRevision` differs, and reconnect sync can create a `SnapshotApplyToken` only from the snapshot fetched by that same fenced operation.
- Repo-qualified snapshot mapping keeps same-named repo paths isolated; a legacy path-only entry applies only with one exact-target candidate and otherwise fails closed.
- Folder workspace keys never enter snapshot projection.
- Hydration timeout does not undo terminal recovery.

### Performance and diagnostics

Seed direct SSH targets, a runtime environment, sidebar refreshes, worktrees, folder workspaces, split tabs, and large terminal maps. Assert:

- coordinator-owned direct SSH detected-worktree concurrency never exceeds five;
- runtime and sidebar work are excluded from, and may exceed, that scoped count;
- terminal retry is submitted before any provider task and uses one publication;
- disconnect uses one publication and schedules session persistence once;
- queue wait, provider duration, timeout, and cancellation are distinct;
- canceled/stale outcomes do not console-error or increment degraded counts;
- diagnostics contain counts/durations plus only an ephemeral target alias;
- the typed telemetry schema rejects identifiers and emits observed queue/provider distributions, timeout/retry/cancel-debt counts, flapping damping, and successful correction results; and
- the adapter computes bounded p50/p95/p99 values from each operation's real scheduler samples.

## Implementation map

- `src/main/ssh/ssh-provider-authority.ts` composes epoch issuance with `ssh-connection-generation.ts`; `src/main/ipc/ssh.ts` rotates on every provider transition, registers before `connected`, and publishes the pair.
- `src/shared/ssh-types.ts`, `ssh-retained-payload-admission.ts`, `runtime-client-events.ts`, and public SSH state projection define, validate, and retain the complete authority. `src/preload/api-types.ts`, `src/preload/index.ts`, startup reconnect, runtime SSH state, and web mutation readers copy it unchanged.
- `src/renderer/src/store/slices/ssh-target-cleanup.ts` and `ssh.ts` make the authority pair equality-significant and patch-preserving. The state-event/reconciliation code in `useIpcEvents` owns arrival watermarks.
- `src/main/ipc/worktrees.ts` and the provider authority module own exact host/provider resolution, the provider-request registry, main deadlines/aborts, post-await fences, qualified lineage pruning, and host metadata backfill. Main has no waiter-lease concept.
- `src/renderer/src/store/slices/detected-worktree-refresh-leases.ts` owns the existing public coalescer key, compatible provider invocation entries, independently generated provider request and waiter lease IDs, ref-counted last-waiter cancellation, and per-lease settlement for every caller.
- `src/renderer/src/hooks/direct-ssh-worktree-refresh-scheduler.ts` acquires shared leases and owns the five local slots, target round-robin, authority/revision wrapper key, nonterminal `retrying` state, one timeout retry, and cancel-debt allowance.
- `src/renderer/src/hooks/direct-ssh-reconnect-coordinator.ts` owns per-target authority replacement, preparation waiters, stabilization damping, preparation barriers/tokens, pending terminal attempts, success ledger, and bounded corrective triggers.
- `src/renderer/src/lib/direct-ssh-target-scope.ts` uses explicit provenance for Git and folder scope; it never reads focused-runtime ownership.
- Terminal slice actions and `src/renderer/src/store/slices/direct-ssh-terminal-recovery.ts` own atomic clear, stale-binding invalidation, transient PTY authority, attempt settlement, and single-publication retry projection.
- `src/renderer/src/hooks/remote-workspace-target-sync.ts` owns capture-before-await revision-zero push, token/revision fences, repo-qualified legacy-safe resolution, local recovery preservation, snapshot-driven reattach, and post-hydration finalization.
- Typed aggregate telemetry owns the privacy schema, per-operation distributions, and fail-soft histogram emission. External dogfood dashboard/query configuration remains an operational follow-up.

## Rollout

The implementation preserves this dependency order:

1. Add the opaque epoch and `rotateSshProviderAuthority`, expand `connectionGeneration` rotation to the same transition set, and inventory every state equality/copy/preload/retained/reconciliation boundary. Land complete-pair publication, malformed partial-authority rejection, retained-admission, stale-reconciliation, provider-before-broadcast, and old-mutation-expectation tests before any coordinator routing.
2. Add host-qualified detected-worktree and lineage IPC, discriminated authoritative response admission, exact main provider selection, main-owned 30-second deadline, provider-request cancellation, and main pre-mutation fences. Preserve the web/runtime overload without enabling direct-SSH web coordination. Keep the coordinator disabled.
3. Refactor renderer worktree/catalog/lineage reads to immutable results with pre-mutation full-authority fences. Add the host-scoped catalog lane independent of focused-runtime supersession, all-provenance contradiction rejection, legacy lineage host backfill, and shared coalescer leases with distinct waiter/provider IDs.
4. Add exact target scope, atomic disconnect clear, stale-authority binding invalidation, retry-attempt settlement, and transient binding provenance. Switch disconnect and reconnect terminal handling together so Git/folder clear-retry symmetry and detected-agent/port cleanup remain intact in every commit.
5. Add the dedicated fair direct SSH scheduler and per-target coordinator with local-settlement semantics, the first-timeout preparation barrier, one timeout retry, cancel-debt admission, authority-advance invalidation, same-authority correction, and flapping damping. Route connected events through reconnect finalization; leave #8255 remote-runtime recovery and runtime-owned SSH rows unchanged.
6. Extract `prepareRemoteWorkspaceTarget`, `syncRemoteWorkspaceAfterConnect`, and `applyRemoteWorkspaceSnapshot` into `src/renderer/src/hooks/remote-workspace-target-sync.ts`. Split preparation-only from reconnect mode, pass the full operation token through revision-zero push and snapshot apply, preserve newer local recovery state, finalize imported terminal hints, and remove repeated preparation calls.
7. Enable typed aggregate diagnostics/telemetry and dogfood with renderer-catalog owner aliasing, many direct targets, an active focused runtime, sidebar activity, folder workspaces, relay-only flapping, timeout/retry/cancel debt, missed disconnects, failed pane spawns, arrival-order races, system resume/browser online events, and cross-device snapshot changes.

Stage 5 is gated on stages 2–4. The coordinator must never call catalog or lineage APIs whose ownership depends on `settings.activeRuntimeEnvironmentId`; a partial coordinator-first rollout is forbidden. System-resume/browser-online recovery must not double-bump a tab already live under the direct SSH authority ledger.

Release checks:

- zero host/authority mismatch accepted at either main or renderer mutation fences;
- zero authority component dropped at equality, retained, preload, startup, public-state, or reconciliation boundaries;
- zero authoritative direct-SSH result constructible or admitted without the full authority pair;
- no cross-host provider selection in duplicate-ID integration tests;
- no contradictory provenance accepted by OR-matching or repo fallback;
- terminal finalization is scheduled before provider discovery and is not delayed by another target or runtime/sidebar work;
- p95/p99 direct scheduler queue wait and provider duration, plus timeout/retry/cancel-debt rates, are reported separately from same-relay non-coordinator traffic;
- peak coordinator-owned direct SSH detected-worktree concurrency is at most five;
- waiter cancellation is lease-local, last-waiter release sends one cancellation for its provider request, authority invalidation sends exactly one per affected in-flight provider request, provider cancellation settles without relay acknowledgement, and cancel debt remains bounded;
- no lineage read, preparation token, or sync starts while a first timed-out repo remains retrying;
- authority advance invalidates old queued/in-flight work and relay flapping produces only one stable preparation wave;
- missed disconnect, failed spawn, and hydration overwrite cases converge through bounded same-authority correction;
- later same-authority snapshots containing new worktrees converge;
- revision-zero push preserves capture-before-await ordering and stale reconciliation cannot resurrect connected state;
- direct SSH lineage deletion is host-correct; and
- Git and folder terminal overlays clear and retry symmetrically while port and detected-agent cleanup remains intact.

Rollback disables coordinator routing with build-time `VITE_DIRECT_SSH_RECONNECT_COORDINATOR=false` or session key `orca.directSshReconnectCoordinator.enabled=false` while retaining composed authority rotation, authority-boundary preservation, host-qualified IPC, mutation fences, and atomic terminal actions. The fallback reconnect path uses the dedicated bounded scheduler and preserves port/detected-agent cleanup; it does not restore host-blind or unbounded `Promise.all`.

## Cross-platform and compatibility

- Use existing execution-host, folder-workspace, workspace-key, SSH PTY-ID, and path utilities. Do not concatenate execution-host IDs or parse filesystem paths.
- The design introduces no keyboard behavior or platform-specific UI.
- Direct SSH on Windows, macOS, Linux, and WSL follows the same host/authority rules.
- Cancellation uses typed provider request IDs over Electron IPC and existing `AbortSignal` support; waiter lease IDs remain renderer-local, and no OS signal semantics or new cancel-ack protocol crosses the wire.
- No Git command, option, parser, or native dependency changes. Git 2.25 compatibility and capability fallbacks remain authoritative.
- Remote runtimes require no server upgrade. Runtime-host requests continue through the existing runtime RPC route.
- Keep new modules within normal line limits; do not add or widen a `max-lines` disable.

## Rejected alternatives and overreach

### Treat in-flight coalescing as collapsing the current sequential scan count

Rejected. The connected refresh, sync preparation, and snapshot preparation await one another. Their provider reads do not overlap, so the current single-flight map has no live promise for the later wave to join. It can reduce unrelated overlapping calls, but does not invalidate the `2R`/`3R` sequential-path diagnosis.

### Use either main connection generation or provider epoch as an independent clock

Rejected. The renderer fallback counter has different ownership and is never authoritative. The existing main generation and new opaque epoch are composed by one rotation helper and transition set: mutation consumers compare the generation, provider/recovery consumers compare the pair, and no producer may advance them independently.

### Cache completed preparation for an entire authority

Rejected. Stable connections can receive wake refreshes and later snapshots referencing newly created worktrees. Only exact overlapping input work is shared; completed work never suppresses later inputs.

### Use one global wave and FIFO for direct SSH plus runtime discovery

Rejected. It couples terminal recovery and target preparation to unrelated queues and timeouts. Direct terminal finalization is synchronous per target; direct provider work uses a dedicated fair bounded scheduler.

### Let preparation-only reuse reconnect finalization

Rejected. Snapshot preparation must never initiate coordinator retry or reconnect sync. Existing snapshot-driven persisted-terminal reattach remains part of apply and is reconciled with current-authority binding evidence afterward. Only immutable catalog/repo/lineage reads may be shared.

### Fence only before the final worktree-map merge

Rejected. Main lineage/metadata changes and renderer git-identity routing occur earlier. Every authoritative side effect is downstream of an exact host/authority fence.

### Use `{ forceLocalOwner: true }` for direct SSH lineage

Rejected. It cannot authoritatively replace an SSH host scope and leaves deleted SSH lineage behind. The wire response and renderer replacement scope must both name the exact execution host.

### Reuse the component sidebar single-flight coalescer

Rejected. It is component-scoped, fire-and-forget, and lacks provider-authority, cancellation, terminal, and preparation semantics. The coordinator instead acquires leases from the shared detected-worktree provider coalescer while preserving its public key shape.

### Replace direct `Promise.all` with `refreshRuntimeProjectWorktrees`

Rejected. It bounds only one invocation, remains host-blind at the desktop IPC boundary, and does not remove repeated preparation.

### Use one scheduler per SSH target

Rejected. It permits `5 × targetCount` locally unsettled provider calls. One dedicated fair scheduler provides a truthful five-local-call bound without a cross-target completion barrier; cancel debt states the separate late-relay allowance.

### Wait for a relay cancellation acknowledgement

Rejected. `rpc.cancel` is a notification and canceled handlers intentionally send no response. Local waiter/provider settlement releases scheduler ownership; late effects remain authority-fenced and replacement admission is bounded by cancel debt.

### Expand direct SSH coordination to the paired web client

Rejected. Paired web clients cannot subscribe to the desktop direct-SSH state path. Preserve shared overload compatibility and host echoes, but do not create a new direct-SSH web transport to address an unreachable version of the shim claim.

### Apply a fixed collection debounce

Rejected. It taxes the singleton common case and is unnecessary when exact overlapping work already coalesces. Fair incremental admission handles multi-target bursts.

### Call `fetchAllWorktrees`

Rejected. It refreshes unrelated hosts, weakens failure isolation, and collides with the separate sidebar surface.

### Reuse permanent target-removal cleanup

Rejected. Removal intentionally deletes last-known and deferred liveness. Reconnectable disconnect must preserve them.

### Batch repeated `clearTabPtyId` calls

Rejected. React batching does not remove Zustand updater work, global map cloning, activity writes, or session debounce resets.

### Move reconnect recovery into main

Rejected. Main owns provider authority and mutation fences; renderer owns tab bindings, session projection, and Zustand updates. The host/authority boundary is the smaller ownership correction.
