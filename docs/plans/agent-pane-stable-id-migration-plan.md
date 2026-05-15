# Agent Pane Stable ID Migration Plan

## Problem

Agent status routing currently uses pane keys shaped as:

```ts
`${tabId}:${paneId}`
```

The `paneId` portion is the renderer-local numeric id from `PaneManager`. That id is useful as a live layout handle, but it is not stable across renderer reloads, tab replay, split layout restoration, PTY reattach, or pane teardown.

This leaks into cross-boundary state:

- `ORCA_PANE_KEY` passed to agent hook scripts
- `agentStatusByPaneKey`
- `retainedAgentsByPaneKey`
- cache timers
- click-to-focus routing
- auto-ack viewed logic
- Activity terminal pane isolation

When a split tab is restored or reattached, the live manager may contain panes `1` and `2` while a retained agent row still points at `3` or `4`. In Activity, that makes `applyExpandedLayoutTo(stalePaneId, ...)` fail and the whole split terminal remains visible instead of only the agent pane.

## Decision

Land the stable UUID pane identity work. This should be treated as a targeted identity-layer migration, not a terminal rewrite or a PTY ownership rewrite.

Use one canonical durable logical-pane identity: the terminal layout leaf id. For new/current layouts, every `TerminalPaneLayoutNode.leafId` is a stable UUID. It may be typed as `StablePaneId` or `TerminalLeafId`, but it is still the layout leaf id, not a second identity stored beside the leaf.

Numeric `pane.id` should remain the in-memory renderer handle. PTY id should remain the process/session handle. Agent identity and any state that crosses renderer, process, or persistence boundaries should use the stable layout leaf UUID:

```ts
`${tabId}:${leafId}`
```

If a pane key cannot be resolved to a live pane, consumers should fail closed: drop the stale status or show an unavailable pane state. They should not guess the active pane or render the whole split tab.

System context:

```text
PTY registry/hooks -> agent status store -> Activity rows/focus
        ^                    |                  |
        |                    v                  v
   TerminalPane <------ pane-key resolver <--- PaneManager
        |
   split layout snapshots
```

Data-flow mapping:

- Happy: PTY gets `${tabId}:${leafId}`, hooks echo it, renderer resolves it to the current numeric pane immediately before layout/focus work.
- Nil: no isolation requested means no pane key; Activity can show the tab-level/default terminal state intentionally.
- Empty: requested pane key resolves to no live pane; Activity reports `unavailable` or `pending` and restores isolation snapshots.
- Upstream error: hook/status IPC carries an invalid or legacy numeric key. Invalid keys are dropped before focus, Activity, or retention state. Identifiable live mixed-version numeric-key PTYs first create PTY-id-backed `migration-unsupported`/`unavailable` state, then discard the numeric pane-key payload instead of forwarding it as normal pane-key status.

## Reference OSS Findings

The durable identity should follow the layout/content object, while live renderer handles and PTY/session handles stay separate.

- VS Code terminal persistence separates live UI `instanceId` from persistent process identity. Split layout persistence stores terminal entries by `persistentProcessId`, while `instanceId` remains a runtime/UI identity.
- Wave Terminal uses durable `BlockId` as the layout/content identity. Jobs attach through `AttachedBlockId` / `JobId`, so process identity is separate from the layout block.
- Tabby serializes split layout as a tree of child recovery tokens, not live component handles.

Chosen direction for Orca: make the terminal layout leaf UUID the one durable logical-pane identity. Do not add a parallel `stablePaneIdByLeafId` map. Existing legacy leaf ids such as `pane:1` are migration inputs only; they must be replaced with UUID leaf ids during upgrade.

## Reference Work

Port focused pieces from these branches rather than merging old branches wholesale:

- `brennanb2025/agent-panes-stable-identity`
  - `39c2813d Add stable pane identity foundation`
- `brennanb2025/agent-panes-pane-key-migration`
  - `3a0c0c68 Migrate pane keys to stable pane IDs`
  - `fa7f3dd5 Clarify internal pane fit key naming`
- `brennanb2025/agent-panes-reporting`
  - `d42b0a26 Harden stable pane replay identity`
  - `7a18230d Fix stale agent pane status routing`
- `brennanb2025/agent-panes-teardown-retention`
  - retention and stale-row cleanup pieces that still apply cleanly

Those branches predate some Activity code in this branch, so Activity integration must be added on top.

## Landing Order

### 1. Add Stable Leaf Identity Foundation

Goal: every terminal layout leaf has a stable UUID, and every live pane can resolve back to that leaf.

Expected changes:

- Add `src/shared/stable-pane-id.ts`.
  - `StablePaneId`
  - `TerminalLeafId`
  - `PaneKey`
  - `isStablePaneId(value)`
  - `isTerminalLeafId(value)`
  - `makePaneKey(tabId, stableLeafId)`
  - `parsePaneKey(paneKey)`
  - `makePaneKey(...)` must reject tab ids containing `:` and `parsePaneKey(...)` must accept exactly one delimiter plus a valid UUID suffix.
- Validate tab ids at creation and workspace/session load before any pane-key construction. Persisted legacy tab ids containing `:` are quarantined fail-closed with diagnostics; do not attempt a partial remint across tab-keyed session maps in this migration.
- Add `src/renderer/src/lib/pane-manager/mint-stable-pane-id.ts`.
- `TerminalPaneLayoutNode.leafId` is the stable UUID logical pane id for new/current layouts.
- `PaneManager` may expose `stablePaneId` and/or `leafId` on `ManagedPane` and `ManagedPaneInternal`, but that value is the layout leaf UUID, not a separate durable identity.
- Mint a UUID leaf id when creating a new layout leaf.
- Let `createInitialPane(...)` and `splitPane(...)` accept a creation-time leaf UUID for replay before they fire `onPaneCreated`.
- Treat post-create `adoptStablePaneId(...)` or `adoptLeafId(...)` as controlled repair only. It must reject adoption after PTY/status identity has been published through `onPaneCreated`.
- Expose lookup/adoption methods on `PaneManager`:
  - `getLeafId(numericPaneId)`
  - `getNumericIdForLeaf(leafId)`
  - `adoptLeafId(numericPaneId, leafId)`
  - `getLeafIdMap()`
- Keep numeric ids as the only API for existing layout operations at this step.

Tests:

- `stable-pane-id` parser/maker tests.
- `PaneManager` creates unique UUID leaf ids.
- split panes each get UUID leaf ids.
- replay creation can inject UUID leaf ids before `onPaneCreated`.
- close/destroy removes stale lookup entries.
- adopting a leaf id updates both directions, rejects collisions, and rejects use after PTY/status identity publication.
- pane-key parsing rejects tab ids or inputs with delimiter ambiguity, including extra `:` characters.
- workspace/session load quarantines a legacy tab id containing `:` before pane keys are constructed.

### 2. Persist UUID Leaf IDs Through Layout Replay

Goal: split layout restore preserves pane identity even when numeric ids are reminted.

Expected changes:

- Update `TerminalPaneLayoutNode.leafId` expectations so new/current snapshots persist UUID leaf ids directly.
- Persist the UUID directly everywhere layout state references a leaf: `leafId`, `activeLeafId`, `expandedLeafId`, `ptyIdsByLeafId`, `buffersByLeafId`, and `titlesByLeafId`.
- Update `serializeTerminalLayout(...)` to write UUID leaf ids in every leaf node.
- Update `replayTerminalLayout(...)` to pass each saved UUID `leafId` into `createInitialPane(...)` / `splitPane(...)` before `onPaneCreated` can trigger lifecycle code such as `connectPanePty`.
- Update the runtime workspace-session schema in `src/shared/workspace-session-schema.ts` so `parseWorkspaceSession(...)` preserves UUID `leafId`, `activeLeafId`, `expandedLeafId`, `ptyIdsByLeafId`, `buffersByLeafId`, and `titlesByLeafId` keys.
- Update the main-process sync spawn persistence path (`pty:spawn` -> `persistPtyBinding(...)`) to receive the canonical UUID `leafId` or full `PaneKey` and write `ptyIdsByLeafId[leafId]` before `pty:spawn` returns. This closes the crash window where the PTY environment already contains the stable `ORCA_PANE_KEY` but the renderer's debounced layout snapshot has not written yet.
- `persistPtyBinding(...)` must merge per leaf under either one serialized session mutation queue or a compare-and-swap session mutation with bounded reread/merge/retry. Concurrent split-pane spawns for the same tab must compose field-wise and preserve sibling `ptyIdsByLeafId` entries from the latest durable session object; they must not replace whole maps from stale snapshots.
- A CAS conflict or failed serialized mutation must not be treated as success. After retry exhaustion, log/drop diagnostics and surface spawn persistence failure if durability cannot be guaranteed before `pty:spawn` returns.
- The `leafId` passed to `pty:spawn` / `persistPtyBinding(...)` must be the canonical UUID layout leaf id from the replay-created leaf result, such as `restoredLeafId`; do not use a reminted live helper key like `pane:${pane.id}`.
- When `persistPtyBinding(...)` creates a minimal layout for first spawn, include the UUID leaf node and matching `ptyIdsByLeafId[leafId]`.
- Preserve previously durable UUID leaf-keyed metadata when stale renderer `session:set` or layout snapshot writes race after the sync spawn flush, matching the existing stale-write protection for `ptyIdsByLeafId`.
- All session writers that touch terminal layout must preserve durable UUID leaf ids and leaf-keyed metadata for existing leaves when the incoming payload omits newer fields or comes from an older schema/version.
- Produce one created-leaf replay result and use it for all leaf-keyed metadata: `ptyIdsByLeafId`, scrollback buffers, titles, active leaf, and expanded leaf.
- Every non-UUID leaf id is a legacy/invalid upgrade input, not only `pane:${number}`. During upgrade, mint a fresh UUID for each non-UUID leaf that is actually created, rewrite that leaf's `leafId`, and remap its `ptyIdsByLeafId`, `sshRemotePtyLeases[].leafId`, durable PTY projections that carry leaf ids, scrollback buffers, titles, active leaf, and expanded leaf entries to the new UUID exactly once in the same session mutation.
- The legacy leaf-id remap must cover SSH reattach evidence as well as local PTY metadata. Current SSH persistence can match leases through `lease.leafId === binding.leafId` when present, so `sshRemotePtyLeases[].leafId` and the replay-created UUID leaf must be upgraded together with `ptyIdsByLeafId`; otherwise SSH split panes can lose reattach evidence or classify the wrong pane after replay.
- Preflight all restored leaf ids before remapping metadata, including valid UUIDs and non-UUID/legacy inputs. If the same input id appears more than once in a restored layout, treat it as corrupt restore data and do not preserve both leaves as the same stable identity. Either fail the affected subtree restore, or remint the duplicate leaves while quarantining/dropping ambiguous metadata for that duplicated id. Never copy one old leaf id's PTY ids, buffers, titles, active state, expanded state, or SSH lease evidence to multiple UUID leaves.
- Assign saved UUID leaf ids and leaf-keyed metadata only to leaves that are actually created. If `splitPane(...)` fails while replaying a subtree, do not remap missing legacy or malformed leaves' metadata, PTY ids, buffers, titles, active state, or expanded state to the surviving pane. Quarantine or drop unresolved metadata with diagnostics so Activity, focus, and agent rows fail closed.
- After replay, normalize `activeLeafId` and `expandedLeafId` against the created-leaf set. If `expandedLeafId` is missing, clear it. If `activeLeafId` is missing, either clear it or reset it to the deterministic first surviving created leaf in replay/layout order only to preserve the UI focus/layout invariant; never use that normalization to move the missing leaf's PTY id, buffer, title, or agent state onto the survivor.
- Do not preserve `pane:${numericId}` or any other non-UUID value as a pane-key suffix. After upgrade, it may exist only as an internal input key while transforming the legacy snapshot.

Tests:

- layout serialization writes UUID leaf ids directly.
- workspace-session schema parsing preserves UUID `leafId`, `activeLeafId`, `expandedLeafId`, `ptyIdsByLeafId`, `buffersByLeafId`, and `titlesByLeafId` keys.
- sync spawn persistence writes `ptyIdsByLeafId[leafId]` under the canonical UUID leaf id before `pty:spawn` returns.
- concurrent split-pane spawn flushes preserve all sibling `ptyIdsByLeafId` entries.
- induced CAS conflict rereads, merges, and preserves sibling `ptyIdsByLeafId` entries instead of overwriting with a stale map.
- CAS retry exhaustion logs diagnostics and causes `pty:spawn` to fail before returning a PTY whose stable pane key was not durably persisted.
- stale renderer session/layout writes after the sync spawn flush preserve durable UUID leaf-keyed metadata.
- mixed-version or older-schema session writers cannot replace UUID leaf ids with legacy `pane:${number}` keys after upgrade.
- crash-recovery test covers SIGKILL after PTY spawn succeeds but before the renderer debounced layout snapshot; restart reuses the surviving PTY's stable pane key instead of minting a different UUID leaf id.
- replay remints numeric pane ids, a fresh PTY spawn persists under the restored canonical leaf id, and SIGKILL before debounced layout write still restarts with the same stable pane key.
- replay restores UUID leaf ids onto newly minted numeric panes before PTY/status keys are created.
- legacy snapshots with `pane:${number}` leaf ids still replay by minting UUID leaf ids.
- legacy SSH split-pane upgrade remaps `sshRemotePtyLeases[].leafId`, `ptyIdsByLeafId`, the replay-created UUID leaf, and migration classification/reattach evidence to the same UUID leaf id.
- SSH lease matching after upgrade uses the remapped UUID `leafId`, not the old `pane:${number}` input key.
- three-plus-pane replay does not alias a saved UUID leaf id to the wrong live pane.
- when `splitPane(...)` returns `null` during a three-plus-pane replay, no two saved UUID leaf ids resolve to the same live pane.
- partial replay with missing leaves does not restore their PTY ids, scrollback buffers, titles, active leaf, or expanded leaf state onto survivors.
- partial replay clears missing `expandedLeafId` and clears or deterministically resets missing `activeLeafId` only for UI focus/layout state, without remapping missing-leaf metadata onto the survivor.
- malformed non-UUID leaf ids are reminted when their leaves are created, and their metadata is remapped exactly once.
- malformed non-UUID leaf ids whose leaves are not created have unresolved metadata quarantined or dropped with diagnostics.
- duplicate valid UUID, legacy, or malformed non-UUID leaf ids are detected before remap and do not preserve two leaves as the same stable identity.
- duplicate old-id metadata is quarantined/dropped, or the affected subtree restore fails with diagnostics, rather than aliasing PTY ids, buffers, titles, active/expanded state, or SSH lease evidence across panes.
- duplicate valid UUID leaf ids do not copy the same UUID-keyed metadata to multiple replay-created leaves.
- replay does not briefly publish a fresh UUID pane key before replacing it with the saved leaf UUID.

### 3. Migrate Pane Keys To UUID Leaf IDs

Goal: all agent-facing pane keys use `${tabId}:${leafId}` where `leafId` is a UUID.

Expected changes:

- Replace pane-key construction in `src/renderer/src/components/terminal-pane/pty-connection.ts`.
  - `cacheKey` should use `makePaneKey(deps.tabId, pane.leafId)` or the equivalent exposed `pane.stablePaneId` alias.
  - `ORCA_PANE_KEY` should receive that stable pane key.
  - agent status removal should use the same stable pane key.
  - cache timers should move to stable pane keys.
- Keep internal pending-spawn/layout binding keys separate from agent pane keys when they are intentionally leaf/local keys.
- Update comments and type docs that still say `${tabId}:${paneId}`.
- Update `src/shared/agent-status-types.ts` comments if needed.
- Drop legacy numeric pane keys on ingress once the renderer can generate stable keys. Do not migrate numeric suffixes because they are not reliably routable after renumbering.
- For live PTYs that were spawned before this migration and still emit numeric `ORCA_PANE_KEY` from their process environment, fail closed at ingress. If the PTY can be identified through the local PTY registry or SSH/remote relay registry and that registry proof attaches it to an owning UUID leaf or `paneKey`, restart/respawn it with a UUID leaf pane key or surface a PTY-id-backed `migration-unsupported` / `unavailable` state. Do not map the numeric suffix to a UUID leaf id after the fact.
- PTY-id-backed migration rows are a separate renderer-visible model, not `AgentStatusEntry` and not an extension of `AgentStatusState`. Add a channel/store such as `migrationUnsupportedByPtyId: Record<PtyId, MigrationUnsupportedEntry>` where renderer-visible entries carry `{ ptyId, worktreeId?, tabId, leafId, paneKey, reason, updatedAt, source }`.
- Populate `migrationUnsupportedByPtyId` only from authenticated/authorized local PTY registry or SSH/remote relay registry evidence that proves the owning pane as a UUID leaf or `paneKey`. PTY-id-keyed migration-unsupported state reaches the renderer only after that proof. Before proof, including while a registry refresh is in progress, keep the PTY-id-only finding in main/relay diagnostic state and emit no renderer row, no routable status, and no Activity target.
- Activity, sidebar, and status surfaces must join `migrationUnsupportedByPtyId` separately from `agentStatusByPaneKey`. They may show the joined row as unavailable/migration-unsupported only when registry identity proves the owning pane; otherwise keep or drop the payload in diagnostics instead of creating a normal status row, a PTY-id-only pending target, or a legacy numeric pane-key route.
- Apply the same delimiter rule from `makePaneKey(...)`/`parsePaneKey(...)`: pane keys have exactly one `:` delimiter, with tab id before it and a UUID leaf id after it.
- Apply that ingress filter at the narrow boundary points:
  - hook snapshot hydration;
  - hook status pushes;
  - renderer IPC apply handlers;
  - Activity thread construction;
  - focus helpers before dispatching focus events.

Tests:

- spawned terminal env contains `ORCA_PANE_KEY=${tabId}:${leafId}` with a UUID leaf id.
- title/status transitions write stable pane keys.
- numeric legacy pane keys are rejected or fail closed where routing requires a live pane.
- old numeric-key live PTYs that survive into the stable-key build are classified as migration-unsupported/unavailable or restarted, not shown as silently stopped.
- numeric-key live PTY detection emits migration-unsupported/unavailable before the numeric payload is discarded.
- PTY-id keyed migration-unsupported state reaches the renderer only when registry identity can attach it to the owning pane; otherwise the payload stays in main/relay diagnostics and no Activity, sidebar, or status row is emitted.
- for a proven owning pane, a synthetic migration-unsupported status row/event exists before numeric payload discard, so Activity, sidebar, and status surfaces show unavailable rather than disappearing.
- migration-unsupported rows are stored in `migrationUnsupportedByPtyId`, not `agentStatusByPaneKey`, and do not require adding `migration-unsupported` or `unavailable` to `AgentStatusState`.
- Activity, sidebar, and status surfaces join `migrationUnsupportedByPtyId` separately and clear the joined display row when registry proof, pane ownership, or PTY lifetime no longer matches.
- unidentifiable numeric-key requests fail closed without cache mutation, while identifiable surviving PTYs are classified by startup/reattach scan.
- idle mixed-version PTYs that emit no hook payload after upgrade are found by startup/reattach registry scan and restarted/respawned or surfaced as migration-unsupported.
- PTY-id synthetic migration-unsupported state clears on PTY teardown, pane close, tab close, and stable-key respawn/reattach.
- tab ids containing `:` cannot produce ambiguous pane keys, and extra-delimiter inputs are rejected on parse.
- legacy numeric keys entering through hook hydration, IPC apply, Activity construction, or focus helpers are dropped before state mutation.
- cache timer cleanup still clears tab-scoped entries on tab close.

### 4. Add Stable-Leaf To Numeric-Pane Resolver

Goal: code above `TerminalPane` can resolve stable UUID leaf ids or pane keys back to current numeric ids when it truly needs live layout handles.

Expected changes:

- Define one authoritative resolver interface, owned by the renderer state layer and backed by `PaneManager` data as needed:

```ts
type PaneKeyResolverGeneration = number
type PaneKeyResolverTransaction = {
  readonly baseGeneration: PaneKeyResolverGeneration
  readonly token: string
  readonly reason: 'register' | 'replay' | 'teardown'
}
type PaneKeyResolverCommitResult =
  | { status: 'committed'; generation: PaneKeyResolverGeneration }
  | { status: 'stale'; generation: PaneKeyResolverGeneration }

type PaneKeyUnresolvedReason =
  | 'suspended-replay'
  | 'confirmed-missing'
  | 'ownership-mismatch'
  | 'invalid'

type PaneKeyResolution =
  | { status: 'resolved'; paneKey: PaneKey; leafId: TerminalLeafId; numericPaneId: number; generation: PaneKeyResolverGeneration }
  | { status: 'unresolved'; paneKey: PaneKey; generation: PaneKeyResolverGeneration; reason: PaneKeyUnresolvedReason }

interface PaneKeyResolver {
  getGeneration(): PaneKeyResolverGeneration
  resolvePaneKey(paneKey: PaneKey): PaneKeyResolution
  resolveLeafId(tabId: string, leafId: TerminalLeafId): PaneKeyResolution
  beginTransaction(reason: 'register' | 'replay' | 'teardown'): PaneKeyResolverTransaction
  registerPaneKey(tx: PaneKeyResolverTransaction, paneKey: PaneKey, numericPaneId: number): void
  suspendTabMappings(tx: PaneKeyResolverTransaction, tabId: string): void
  replaceTabMappings(tx: PaneKeyResolverTransaction, tabId: string, nextForTab: Record<PaneKey, number>): void
  unregisterPaneKey(tx: PaneKeyResolverTransaction, paneKey: PaneKey, numericPaneId: number): void
  commitTransaction(tx: PaneKeyResolverTransaction): PaneKeyResolverCommitResult
  abortTransaction(tx: PaneKeyResolverTransaction): void
}
```

- Add store state behind that interface, such as `numericPaneIdByPaneKey: Record<PaneKey, number>` and tab-scoped replay suspension state.
- Add actions to stage register, suspend, replace, and unregister mappings only through the resolver interface. Staged changes are invisible to consumers until `commitTransaction(tx)` succeeds; `abortTransaction(tx)` discards them.
- Generation advancement is owned by the resolver and happens only at commit. Callers receive an opaque resolver transaction/commit token from `beginTransaction(...)`; callers may pass context for validation/logging, but they must not supply arbitrary generation numbers as the source of truth.
- `commitTransaction(tx)` must atomically verify that the transaction token is current and `tx.baseGeneration === currentGeneration`, or an equivalent freshness check, before applying staged changes and advancing generation. If the transaction is stale, it returns `{ status: 'stale', generation: currentGeneration }` without changing committed maps, suspension state, or generation. A successful commit returns `{ status: 'committed', generation: nextGeneration }`. This applies to all staged operations, including `registerPaneKey(...)`, `unregisterPaneKey(...)`, `suspendTabMappings(...)`, and destructive `replaceTabMappings(...)`.
- Callers must branch on the explicit commit result. A stale result must not publish pane readiness, PTY identity, bridge ACK eligibility, focus success, Activity isolation readiness, or auto-ack state; the caller must retry from current resolver state or fail the caller path closed.
- Consumers read only committed maps, committed tab suspension state, and committed generations. A failed, aborted, or still-open transaction must not change `resolvePaneKey(...)`, `resolveLeafId(...)`, or `getGeneration()` results.
- `resolvePaneKey(...)` and `resolveLeafId(...)` must validate ownership at resolve time before returning `resolved`. After reading the committed numeric id, they must verify that `PaneManager` still has that numeric pane and that its current leaf id exactly matches the requested pane key/leaf id. If the numeric id is gone, return `unresolved` with `reason: 'confirmed-missing'`. If the numeric id has been reused or now belongs to a different leaf, return `reason: 'ownership-mismatch'`. Both cases schedule resolver cleanup plus rate-limited diagnostics.
- Resolver unresolved reasons are part of the contract and stay renderer/`PaneManager`-derived. Suspended tab replay returns `reason: 'suspended-replay'`; confirmed missing mappings return `reason: 'confirmed-missing'`; mismatched `PaneManager` leaf ownership returns `reason: 'ownership-mismatch'`; invalid shape/type inputs return `reason: 'invalid'` or are rejected before resolver entry. The resolver does not produce a source-agnostic reattach-pending reason; reattach pending is a bridge classification only when a candidate carries explicit source-scoped registry evidence. Consumers must not collapse these into a generic unresolved state because bridge pending, Activity pending, and unavailable states depend on the distinction.
- Register when a pane is created with its final UUID leaf id, or after pre-publish adoption, and the tab id is known.
- Unregister when a pane closes, a tab closes, or layout replay replaces the manager.
- Guard single-key register/unregister by resolver transaction token, base generation, and numeric pane ownership. A delayed teardown or register from generation N must be ignored if its token/base generation is not current and must not delete or overwrite a mapping committed by generation N+1 for the same stable pane key.
- If an unregister commit is stale, the close path must retry from the current resolver generation when the closing pane's stable identity is still known. If it cannot retry immediately, a deterministic cleanup sweep after pane close, tab close, and replay completion must revalidate committed mappings against current `PaneManager` leaf ownership and remove closed-pane mappings so they cannot persist indefinitely.
- Make pane teardown handoff carry stable identity before `PaneManager` disposes/deletes the pane. Either add an `onPaneClosing` callback or change `onPaneClosed` to receive a payload such as `{ paneId, leafId, paneKey }`; cleanup must not depend on recovering the leaf id from `PaneManager` after `disposePane(...)`.
- When `PaneManager` replay starts for a tab, first commit a replay transaction that stages `suspendTabMappings(tx, tabId)`. If that suspension commit returns stale, retry against the current generation before continuing replay work; if bounded retries are exhausted, fail the caller path closed. Once the tab is suspended, `resolvePaneKey(...)` and `resolveLeafId(...)` for that tab return `unresolved` with `reason: 'suspended-replay'` unless a later committed replacement has proven the key against the current `PaneManager` leaf identity. Pre-replay numeric mappings for the suspended tab must not remain routable.
- Replace resolver maps during layout replay atomically through one committed transaction after the tab is suspended. `TerminalPane` / `PaneManager` replay is per tab while the resolver store is global, so replay must call `replaceTabMappings(tx, tabId, nextForTab)`. Build `nextForTab` from the current `PaneManager` leaf identity and validate that every `nextForTab` key parses to `tabId`; otherwise abort the transaction. On committed replacement, remove only old mappings whose parsed `paneKey` belongs to that tab, replace them with `nextForTab`, and clear that tab's suspension; mappings for unaffected tabs must be preserved.
- A stale final `replaceTabMappings(...)` commit must leave the tab suspended/unresolved with `reason: 'suspended-replay'` and must not restore or expose the pre-replay numeric mappings. The caller must schedule a fresh replacement from the current `PaneManager` state with bounded attempts, or explicitly fail the path closed after retry exhaustion.
- Suspended-tab recovery after stale replacement retry exhaustion must be explicit. While recovery is within the shared attempt and duration limits, the tab remains fail-closed pending with `reason: 'suspended-replay'`, and recovery is retried with bounded backoff on the next resolver generation change, pane create/close in that tab, replay completion timer, or explicit tab replay restart. If those retries still cannot commit a replacement, or the max suspended duration expires, the tab must transition through a tab-level replay restart or an explicit unavailable state with diagnostics; it must not remain silently pending forever.
- Document and share replay replacement recovery limits as constants, for example in `src/shared/pane-key-resolver-recovery-limits.ts`, so resolver code and tests use the same values:
  - `RESOLVER_REPLAY_REPLACEMENT_MAX_ATTEMPTS = 3`
  - `RESOLVER_REPLAY_REPLACEMENT_INITIAL_BACKOFF_MS = 250`
  - `RESOLVER_REPLAY_REPLACEMENT_MAX_BACKOFF_MS = 2_000`
  - `RESOLVER_REPLAY_MAX_SUSPENDED_MS = 30_000`
  - `RESOLVER_REPLAY_DIAGNOSTIC_INTERVAL_MS = 10_000`
- If a full-store replacement API such as `replaceMappings(...)` is kept, mark it as full-store only and do not use it from per-tab replay. Consumers for unaffected tabs should see their previous committed maps until their own tabs replay; consumers for a suspended replaying tab must fail closed instead of reading old or half-updated maps.
- All cross-component consumers that need live numeric ids must use this authoritative resolver. `PaneManager` may own internal lookup data, but focus, auto-ack, Activity isolation, and runtime title merge code must not bypass the resolver with ad hoc direct lookups.
- Update consumers that currently parse numeric suffixes:
  - status row click-to-focus
  - Activity portal descriptors
  - any runtime pane title merge logic that crosses from agent state into live pane state

Tests:

- map registers all panes in a split tab.
- map updates after layout replay with new numeric ids and the same UUID leaf ids.
- replaying tab B with `replaceTabMappings(...)` cannot remove or rewrite tab A mappings in the global resolver store.
- `replaceTabMappings(...)` aborts without changing the committed map when `nextForTab` contains a pane key for another tab.
- consumers never observe a partially rebuilt resolver map during layout replay.
- resolver generation advances only after `commitTransaction(tx)`, never at `beginTransaction(...)` or while staging register/suspend/replace/unregister operations.
- aborted or failed resolver transactions leave the committed map, suspension state, and generation unchanged.
- `commitTransaction(tx)` returns `{ status: 'committed', generation }` only after applying staged changes, and returns `{ status: 'stale', generation }` without applying staged changes or advancing generation after another transaction has already advanced generation.
- callers do not publish readiness, PTY identity, bridge ACK eligibility, focus success, Activity isolation readiness, or auto-ack state after a stale commit result.
- `resolvePaneKey(...)` and `resolveLeafId(...)` return `unresolved` with `reason: 'confirmed-missing'` and schedule cleanup/diagnostics when a committed numeric pane id no longer exists, and return `reason: 'ownership-mismatch'` when its current `PaneManager` leaf id does not match the requested stable leaf.
- replay start suspends only the replaying tab, and old mappings for that tab resolve to `unresolved` with `reason: 'suspended-replay'` while sibling tabs continue resolving from their committed mappings.
- stale `replaceTabMappings(...)` commit aborts without replacing tab mappings or changing generation after another transaction has already advanced generation, leaves the tab suspended/unresolved with `reason: 'suspended-replay'`, and the pre-replay numeric mapping no longer resolves.
- stale final replay replacement schedules a bounded fresh replacement that converges from current `PaneManager` state, or the caller path explicitly fails closed after retry exhaustion.
- after stale final replay replacement exhausts retries, recovery is retried on the next resolver generation change, pane create/close, replay completion timer, or explicit tab replay restart; until convergence or max suspended duration, the suspended tab reports fail-closed pending with `reason: 'suspended-replay'`, then transitions to explicit unavailable rather than pending indefinitely.
- persistent replacement retry exhaustion forces a tab-level replay restart or explicit unavailable transition with diagnostics.
- suspended-tab replacement recovery uses the shared max-attempt, initial-backoff, max-backoff, max-suspended-duration, and diagnostic-interval constants rather than test-local magic numbers.
- resolver tests classify unresolved reasons separately: suspended replay is the only renderer-derived pending disposition, while confirmed missing, ownership mismatch, and invalid inputs are confirmed-unresolved or invalid-drop dispositions unless the main/relay bridge supplies separate source-scoped reattach evidence.
- focus, auto-ack, Activity isolation, and runtime title merge all agree on resolved/unresolved results during replay generation transitions.
- stale callers cannot advance, overwrite, or unregister mappings by supplying their own generation number.
- stale teardown or register from resolver generation N cannot unregister or overwrite a live mapping committed in generation N+1 for the same pane key.
- stale unregister after numeric id reuse leaves the old pane key unresolved and cannot focus, isolate, or auto-ack the sibling/new pane that reused the numeric handle.
- stale unregister cleanup retries from the current generation or is removed by the deterministic pane close/tab close/replay cleanup sweep.
- exact stable-key teardown cleanup still runs when the numeric pane has already been removed from `PaneManager`.
- map entries are removed on pane close/tab close.
- stale UUID leaf pane keys resolve to `{ status: 'unresolved', paneKey, generation, reason }`, not to an active or first pane fallback.

### 5. Fix Focus And Auto-Ack Semantics

Goal: agent rows target the exact pane, not just the tab.

Expected changes:

- Change `FocusTerminalPaneDetail` from numeric `paneId` to stable UUID `leafId` or full `paneKey`.
- Update `activateTabAndFocusPane(...)` so callers pass stable identity.
- Update `use-terminal-pane-global-effects.ts` to resolve stable identity through the authoritative pane-key resolver before `setActivePane`.
- A row click is acknowledged only after the stable UUID leaf id resolves to the active leaf and the pane is actually displayed.
- Update `useAutoAckViewedAgent.ts`.
  - Match only the active leaf's stable pane key.
  - Use the authoritative resolver for live numeric-id checks; do not inspect `PaneManager` directly from auto-ack code.
  - Stop acknowledging every agent whose key starts with `${activeTabId}:`.
  - Include active leaf/layout state in the subscription guard so focus changes inside a split tab rescan.
  - Stale rows must not mark read unless Activity/focus has displayed the requested pane.

Tests:

- clicking a status row focuses the exact agent pane after layout replay.
- clicking a stale status row does not mark read when focus fails.
- clicking a blank split pane does not auto-ack the agent row in the sibling pane.
- switching to the agent pane does auto-ack when the window is focused and visible.
- focus and auto-ack observe the same resolver generation and do not disagree during layout replay.

### 6. Add Minimal PTY Ingress Gate

Goal: stale or malformed child-process hook posts cannot mutate pane state during the identity migration.

Expected changes:

- Add a small ingress helper similar to `agent-status-pane-liveness.ts`, scoped to pane-key validation and exact-pane routing.
- Parse pane keys with `parsePaneKey(...)`. Main/relay rejects only invalid shape, extra delimiters, and legacy numeric suffixes before bridge submission; valid UUID leaf ids remain candidates until bridge validation accepts them, keeps them pending for suspended replay or source-proven reattach, or rejects them as confirmed unresolved.
- Validate hook/status ingress before mutating timing enrichment, `lastStatusByPaneKey`, unknown/pending caches, listener replay state, or `last-status.json`.
- Add an initial-migration main/renderer ingress bridge for sources that first arrive in main or a relay. Main/relay performs transport authorization and shape checks only, parses the UUID pane key, stores valid UUID candidates in a non-durable pre-cache pending queue, and sends candidate envelopes to the renderer for resolver validation.
- Live source identity includes a source epoch that changes on main/relay restart and on source reconnect. Request tokens are unique within that source epoch, either collision-resistant opaque ids or a monotonic per-source-epoch sequence plus nonce. Bridge envelopes, pending storage, and ACK matching must carry both request token and source epoch so stale tokens from an old source lifetime cannot match new candidates.
- Live bridge candidate envelopes from main/relay must include a request token, source epoch, parsed `PaneKey`, source identity, full status snapshot, monotonic `ingressSequence`, `receivedAt`, and expiry. They may include a non-durable source-scoped reattach evidence marker only when the local PTY registry or SSH relay registry proves the same source identity, source epoch, and `paneKey` are inside a bounded reattach window. That marker carries the evidence source and expiry, and it is not a durable ownership/liveness epoch. Candidate envelopes do not carry a mandatory renderer resolver generation because main/relay cannot know the renderer-owned committed generation before validation. The renderer stamps the committed resolver generation only in its ACK or reject after resolving the exact current pane for the same pane key, source identity, source epoch, and request token.
- Renderer bridge validation returns explicit candidate outcomes:
  - `accepted`: a committed resolver generation proves the exact current pane for the same pane key, source identity, source epoch, and request token.
  - `pending-replay-or-reattach`: the resolver returns `reason: 'suspended-replay'`, or it returns `reason: 'confirmed-missing'` and the candidate carries unexpired positive reattach evidence for the same source identity, source epoch, and `paneKey`. The candidate stays in the main/relay pending queue under the TTL and reattach-extension rules.
  - `rejected-confirmed-unresolved`: the resolver returns `reason: 'confirmed-missing'` without unexpired positive same-source reattach evidence, returns `reason: 'ownership-mismatch'`, or otherwise confirms from committed resolver state that there is no live pane for that key or that the tab/pane is closed. Main/relay drops the candidate with diagnostics; same-source reattach evidence expiry is handled by the pending queue's normal expiry/drop rules.
  Invalid shape, legacy numeric suffixes, unauthenticated/unidentified sources, and resolver `reason: 'invalid'` are rejected before cache mutation and never produce a pending outcome.
- The renderer may return an acceptance ACK only after a committed resolver generation proves the exact pane for that same source and request. The ACK must echo the accepted source identity, source epoch, request token, pane key, committed resolver generation, and candidate `ingressSequence`. Main mutates timing enrichment, `lastStatusByPaneKey`, listener replay state, `getStatusSnapshot()` state, or `last-status.json` only after that ACK and only if its authoritative pending queue still has the matching unexpired latest candidate.
- Main/relay must evict pending candidates or bump a non-durable pane/source validation epoch when a pane closes, a tab closes, or a resolver mapping replacement proves the candidate no longer matches the current pane key/source/tab. Replay replacement is split into two cases: destructive invalidation for stale or mismatched candidates, and readiness revalidation for the latest matching suspended-replay candidate whose pane key, source identity, source epoch, and ingress sequence still match after the same-tab replay commit. For that readiness case, main/relay atomically restamps the latest matching candidate to the new validation epoch before resubmitting it; delayed ACKs from the earlier validation attempt remain stale, while the fresh ACK from the replay-readiness validation can promote if all normal checks still pass. ACK promotion requires the candidate to still be the latest entry, unexpired, not evicted, and stamped with the current validation epoch. The ACK's committed resolver generation must not be older than the current pane/source validation epoch's minimum resolver generation. This is local invalidation and restamping for pending candidates, not a durable renderer-generation handshake.
- Rejected, stale-source, stale-source-epoch, stale-request, stale-ingress-sequence, confirmed-unresolved, expired, or evicted bridge candidates are dropped with diagnostics and never promoted from the pre-cache queue. `pending-replay-or-reattach` is not a rejection; it remains pending only while TTL and same-source reattach rules allow. This bridge is a request-scoped resolver acceptance check for the identity migration; it must not grow into durable renderer-generation handshakes, PTY ownership/liveness binding epochs, or ownership-token validation.
- For stable UUID pane keys, forward only when the renderer resolver can associate the key with the current exact pane or when the event can be safely held in the non-durable pre-cache queue until suspended replay or source-proven reattach finishes. Never fall back to active pane, first pane, or whole-tab status.
- Define one bounded pending-status path for safe deferral during suspended replay or source-proven reattach. Main/relay is the authoritative owner of the non-durable pre-cache pending queue, including buffering, TTL extension, eviction, clock source, last-write-wins, diagnostics, and promotion. The renderer acts only as resolver validator and ACK/reject producer; it must not own a second durable or persistent pending set. If the renderer keeps transient validation work, ACKs are ignored unless main/relay still has the matching latest candidate, source epoch, request token, ingress sequence, and validation epoch.
- Use one canonical pending storage model. Live candidates are keyed by `(paneKey, sourceIdentity including sourceEpoch)` with one latest entry containing `{ requestToken, sourceEpoch, ingressSequence, receivedAt, expiry, validationEpoch, snapshot }`. A newer live candidate for the same pane/source replaces the older entry before ACK; the old request token can no longer promote. ACK promotion requires request token, source epoch, ingress sequence, and validation epoch to still match the latest entry.
- Trusted replay/hydration pending entries use their own shape keyed by `(paneKey, trustedSourceIdentity, replayGeneration)` and contain `{ replayGeneration, ingressSequence, receivedAt, expiry, snapshot }`. They never overwrite a newer live-accepted status. Main/relay assigns monotonic `ingressSequence` on ingestion and records `acceptedAt` plus accepted ingress sequence on promotion; live accepted status with a newer accepted ingress sequence takes precedence over trusted replay/hydration, while trusted replay/hydration may seed empty state or replace only older trusted state for the same pane/source/replay generation.
- Initial migration rule: live pending entries must carry request token, source epoch, and source identity sufficient for the current transport, while trusted replay/hydration entries must carry trusted source identity plus `replayGeneration`. Do not require a renderer resolver generation on live candidates, and do not require durable ownership/liveness binding epochs in the initial migration; those belong to the hardening follow-up.
- Treat internal replay/cache sources as internal channels, not live PTY-authenticated ingress. Give them an explicit trusted source identity class, for example `source: { kind: 'trusted-replay'; channel: 'last-status' | 'listener-replay' | 'snapshot' | 'remote-replay'; replayGeneration: number }`. Assign this identity only after the payload was previously accepted through live ingress or loaded from the trusted cache with a valid UUID pane key.
- Invalid keys, extra delimiters, legacy numeric suffixes, and unauthenticated/unidentified sources never enter the pending-status buffer. They fail closed before hook caches, status maps, listener replay state, or `last-status.json` can mutate.
- Live pending candidates may be promoted across resolver generation changes. Promotion requires an ACK proving that the same pane key, source identity, source epoch, request token, and ingress sequence resolve to the exact current pane at the ACK's committed resolver generation. Main/relay must still have the matching latest unexpired candidate at the current pane/source validation epoch. Do not require exact resolver-generation equality for live candidates.
- Main/relay owns live pending revalidation after an initial `pending-replay-or-reattach` renderer result. Revalidation means resubmitting the existing latest live candidate envelope to the renderer for another request-scoped resolver validation; it is not a durable renderer-generation handshake and it does not add a renderer generation to live candidate storage.
- Revalidation triggers are: resolver generation changes; successful tab replay/replay replacement commit for the candidate's tab; tab replay completion, including fail-closed completion after bounded replacement recovery; same-source PTY registry or SSH relay evidence refresh for the candidate's source identity, source epoch, and pane key; and a bounded retry timer while the entry remains inside its existing base TTL or the 120s reattach cap. Retry timers never extend expiry by themselves.
- Each trigger resubmits only latest matching live pending candidates affected by that pane key, source identity/source epoch, or tab. Revalidation must preserve the existing request token, source epoch, ingress sequence, same-source reattach evidence checks, and ACK matching rules; the only validation-epoch change allowed is the atomic restamp for the latest matching suspended-replay candidate after same-tab replay replacement commits. A newer live candidate for the same pane/source supersedes the older candidate before any retry can promote.
- Stale retry work, expired entries, evicted entries, source reconnect/source-epoch changes, same-source evidence mismatch or loss, pane close, tab close, and validation epoch mismatch drop or ignore the candidate with diagnostics and no timing enrichment, `lastStatusByPaneKey`, listener replay state, `getStatusSnapshot()` state, or `last-status.json` mutation. If a retry races with invalidation, its later ACK/reject is ignored under the normal latest-candidate and validation-epoch checks.
- Trusted replay/hydration entries still use `replayGeneration` to reject stale replay payloads. After a new resolver commit, the renderer can revalidate and promote a trusted replay entry if the pane key and trusted source identity still match the exact current pane; stale replay generations, source mismatches, unresolved mappings, dead PTY/relay evidence, timeout, expiry, or eviction drop the snapshot with diagnostics and no cache/status mutation.
- Document and share the pending-buffer limits as constants, for example in `src/shared/agent-status-pending-limits.ts`, so main, relay, renderer, and tests do not drift:
  - `PENDING_STATUS_BASE_TTL_MS = 15_000`
  - `PENDING_STATUS_MAX_REATTACH_TTL_MS = 120_000`
  - `PENDING_STATUS_GLOBAL_LIMIT = 512`
  - `PENDING_STATUS_PER_SOURCE_LIMIT = 64`
  - `PENDING_STATUS_DIAGNOSTIC_INTERVAL_MS = 10_000`
- Base expiry is 15s. Main/relay may extend expiry up to the 120s absolute cap only while the main PTY registry or SSH relay registry has positive same-source reattach evidence for the candidate. Registry evidence must match the candidate source identity, source epoch, and `paneKey`; otherwise the entry expires normally. This evidence is the only initial-migration producer for reattach pending after a resolver `confirmed-missing` result. If an entry expires before resolver readiness, fail closed and rely on listener/relay replay after readiness to repopulate a fresh candidate.
- Define and share a canonical source identity serialization for eviction, for example `kind|transport|ptyId|relayId|channel|sourceEpoch` with that fixed field order, delimiter-safe field encoding, and an explicit empty/null marker such as `-`. Main, relay, renderer tests, and the shared eviction helper must use this normalized `sourceIdentityKey` before tie-breaking with `sourceEpoch`, `ingressSequence`, and request token or `replayGeneration`.
- Eviction is deterministic and uses one total sort key shared by main, relay, and tests: expired entries first by earliest expiry, then `receivedAt`, canonical `sourceIdentityKey`, `sourceEpoch`, `ingressSequence`, and request token for live entries or `replayGeneration` for trusted entries as the final tie-breaker. Enforce caps in this order: expire globally first, then enforce per-source caps within each over-limit source using the shared comparator, then enforce the global cap across the remaining entries using the same comparator. Overflow and expiry diagnostics are rate-limited by reason/source using the shared interval constant. All ingress, replay, hydration, `setListener()` replay, `getStatusSnapshot()`, and remote/relay paths must use this same defer contract rather than ad hoc pending caches.
- For legacy numeric pane keys, use the mixed-version path from stage 3: restart/respawn identifiable local or SSH PTYs with a stable UUID leaf pane key, or surface PTY-id-backed `migration-unsupported` / `unavailable` only when registry/relay proof attaches the PTY to an owning UUID leaf or `paneKey`. Unidentifiable requests and PTY-id-only findings before owning-pane proof fail closed with main/relay diagnostics only.
- Apply the same fail-closed ingress rule to every main-to-renderer status emission path:
  - hook listener forwarding;
  - `setListener()` replay;
  - `getStatusSnapshot()`;
  - startup hydration from `last-status.json`;
  - remote/relay replay.
- Keep this compatible with SSH/remote PTY reattach. The authority for whether a legacy or pending PTY is identifiable is the main-process PTY registry and SSH relay registry, not renderer-only tab layout.
- Defer durable ownership tokens, renderer-generation handshakes, tri-state liveness, auth-failed synthetic statuses, and close-intent tombstones to the `PTY Ownership & Liveness Hardening` follow-up unless explicitly promoted.

Tests:

- hook event with a valid UUID leaf pane key forwards only to the exact resolved pane.
- hook event with an invalid key, extra delimiter, legacy numeric suffix, or `rejected-confirmed-unresolved` UUID leaf id is dropped with diagnostics before cache/status mutation.
- bridge validation maps resolver `reason: 'suspended-replay'` to `pending-replay-or-reattach`; maps resolver `reason: 'confirmed-missing'` plus unexpired same-source reattach evidence to `pending-replay-or-reattach`; maps `reason: 'confirmed-missing'` without that evidence and `reason: 'ownership-mismatch'` to `rejected-confirmed-unresolved`; and treats `reason: 'invalid'` as an invalid drop before pending storage.
- confirmed-missing bridge candidates with missing, expired, mismatched source identity, mismatched source epoch, or mismatched `paneKey` reattach evidence are rejected as `rejected-confirmed-unresolved` and are not buffered as reattach pending.
- unresolved valid UUID pane key during suspended replay or source-proven reattach receives `pending-replay-or-reattach` and stays in the bounded pending-status buffer only when the source is authenticated/authorized live ingress with request token, source epoch, and source identity, or trusted replay/hydration with source identity plus `replayGeneration`.
- confirmed missing without source-scoped reattach evidence or ownership-mismatched UUID pane keys are classified as `rejected-confirmed-unresolved`, not buffered as replay/reattach pending.
- HTTP hook ingress with a valid UUID pane key mutates no timing enrichment, `lastStatusByPaneKey`, listener replay state, `getStatusSnapshot()` state, or `last-status.json` before the renderer returns a matching acceptance ACK.
- remote relay ingress with a valid UUID pane key follows the same pre-cache queue and renderer ACK bridge as local HTTP hooks.
- live bridge candidates do not require main/relay to attach a renderer resolver generation; renderer ACK/reject is where the committed resolver generation is stamped.
- live candidates can promote across resolver generation changes when the ACK proves the same pane key plus source identity/source epoch resolves to the exact current pane and main/relay still has the matching latest unexpired request token, ingress sequence, and validation epoch.
- live pending candidates that first receive `pending-replay-or-reattach` during suspended replay are resubmitted by main/relay after the successful tab replay/replay replacement commit or tab replay completion and promote when the recreated pane with the same UUID leaf id validates, without requiring fresh hook traffic; same-tab replay replacement restamps only the latest matching candidate to the new validation epoch, and delayed ACKs from the pre-restamp validation attempt are ignored.
- live pending candidates that first receive `pending-replay-or-reattach` during source-proven reattach are resubmitted by main/relay after same-source registry/relay evidence refresh or resolver readiness and promote when the exact pane validates, without requiring a new hook or relay event.
- live pending revalidation on resolver generation change, replay commit/completion, evidence refresh, and bounded retry timer resubmits only the latest candidate for the affected pane/source/tab and keeps the original source epoch, request token, ingress sequence, and same-source evidence matching requirements; the validation epoch is preserved except for the explicit same-tab replay-readiness restamp.
- delayed ACKs after pane close, tab close, resolver replacement, replay replacement, candidate eviction, source reconnect, or newer same-pane/source candidate replacement are ignored without cache or persistence mutation.
- stale-but-well-shaped UUID candidates are dropped on stale source, stale source epoch, stale request token, stale ingress sequence, timeout, expiry, eviction, `rejected-confirmed-unresolved`, or renderer rejection without cache or persistence mutation.
- ACKs are ignored when main/relay no longer has the matching authoritative latest candidate, source epoch, request token, and ingress sequence, even if the renderer kept transient validation work.
- pending-status buffer keeps only the latest full snapshot for a matching live pane/source/source-epoch or trusted pane/source/replay-generation entry, drains after resolver validation proves the exact current pane, and drops without cache/status mutation on timeout, expiry, eviction, dead PTY/relay evidence, stale replay generation, source mismatch, or validation epoch mismatch.
- bounded retry timers stop at the existing base TTL or 120s same-source reattach cap, do not resurrect expired or evicted candidates, and do not mutate cache/status state when evidence is lost, the source reconnects, pane/tab closes, or the validation epoch no longer matches.
- pending-status buffer authority for TTL, eviction, clock source, LWW, diagnostics, and promotion lives in main/relay; renderer owns only resolver validation and ACK/reject production.
- pending-status buffer enforces per-pane/source/source-epoch last-write-wins for live candidates, per-pane/source/replay-generation last-write-wins for trusted replay entries, ACK matching on request token/source epoch/ingress sequence/validation epoch, base TTL, 120s reattach max, global cap, per-source cap, deterministic eviction, and rate-limited diagnostics through the shared constants.
- pending-status eviction uses the shared total sort key and produces deterministic ordering for multi-source entries with equal expiry and `receivedAt` timestamps.
- pending-status eviction uses the canonical source identity serialization consistently in main, relay, renderer tests, and the shared eviction helper, including empty/null fields.
- pending-status eviction first removes expired entries globally, then trims over-limit sources to the per-source cap with the shared comparator, then applies the global cap across the remaining entries.
- when one source exceeds the per-source cap and another source has older entries, the over-limit source is trimmed first by per-source overflow before the global cap considers older entries from other sources.
- trusted replay/hydration promotion cannot overwrite a newer live-accepted status as measured by accepted ingress sequence and `acceptedAt`.
- invalid or legacy numeric pane keys never enter the pending-status buffer from hook forwarding, hydration, `setListener()` replay, `getStatusSnapshot()`, or remote/relay replay.
- hook event for a sibling pane key is not routed to the active pane, first pane, or whole tab.
- `last-status.json`, `setListener()` replay, `getStatusSnapshot()`, and remote/relay replay use trusted replay source identity only for payloads previously accepted through live ingress or loaded from trusted cache with a valid UUID pane key.
- `setListener()` replay and `getStatusSnapshot()` omit bridge-pending candidates until renderer acceptance ACK promotes them.
- startup hydration from `last-status.json` validates UUID candidates through the bridge before seeding main caches or rewriting durable `last-status.json`.
- trusted replay pending entries use `replayGeneration` to reject stale replay payloads, but may revalidate after a new resolver commit if pane key and trusted source identity still match the exact current pane.
- base pending TTL is 15s, extends only with positive same-source PTY/SSH relay reattach evidence, and never exceeds the 120s absolute cap.
- slow SSH reattach with positive same-source registry evidence keeps a live candidate pending within the 120s cap; without that evidence the candidate expires fail-closed and must be repopulated by listener/relay replay after resolver readiness.
- `setListener()` replay, `getStatusSnapshot()`, startup hydration, and remote/relay replay all apply the same fail-closed pane-key gate as hook forwarding.
- identifiable local and SSH numeric-key PTYs are restarted/respawned or surfaced as migration-unsupported/unavailable only after registry-backed owning-pane proof; before proof, they remain main/relay diagnostics only.
- unidentifiable numeric-key requests do not enter timing enrichment, hook caches, `last-status.json`, `setListener()` replay, or `getStatusSnapshot()`.
- remote/SSH reattached PTY with a stable UUID leaf pane key still routes after the resolver can prove the exact pane.

### 7. Harden Pane Teardown Retention

Goal: closed split panes do not leave retained rows that later look live or route to the wrong pane.

Expected changes:

- Keep `dropAgentStatus(...)` behavior that removes both live and retained entries for a pane key.
- On pane PTY exit/close, drop or suppress retention for that exact stable pane key when the user intentionally closed the pane.
- The authoritative close source for the initial migration is the renderer pane/tab close action plus the exact stable UUID pane key. Plain PTY exit, SSH detach, relay loss, or timeout must not imply user close.
- If close races with replay/reattach and the exact UUID leaf pane key cannot be proven current, reconcile conservatively: do not suppress retained state for a different or unresolved pane.
- On tab close, continue dropping all pane keys with the tab prefix.
- Pane and tab teardown must also clear any PTY-id-backed synthetic migration-unsupported state for the owning PTYs; that state must not be retained as a stable-key row after the pane is gone.
- The same stable pane key should reappear only through replay or reattach of the same UUID leaf. New panes after user close mint new UUID leaf ids.
- Clear retention suppression for a stable pane key only in replay/reattach cases for the same UUID leaf or after a fresh live status entry for that exact pane key.
- Defer close-intent tombstones and same-logical-pane rebind races to the `PTY Ownership & Liveness Hardening` follow-up unless explicitly promoted.

Tests:

- closing one split pane removes that pane's agent row without removing sibling pane rows.
- PTY exit, SSH detach, relay loss, or timeout does not suppress retention as a user close.
- renderer crash/reload during close preserves retention unless the exact UUID pane close is confirmed.
- close racing replay/reattach does not remove or suppress sibling pane rows.
- tab close removes all rows for the tab.
- late hook events after close do not re-retain the row.
- same-pane reattach or a fresh live status for the exact UUID pane key clears retention suppression.
- PTY-id-backed migration-unsupported rows disappear on pane close, tab close, PTY teardown, or stable-key respawn.

### 8. Integrate Activity Pane Isolation

Goal: Activity shows only the selected agent pane, even in split terminals.

Expected changes:

- Remove `paneIdFromPaneKey(...)` from `ActivityPrototypePage.tsx`.
- Use `parsePaneKey(...)` to get `{ tabId, leafId }`.
- Change `ActivityTerminalPortalTarget`.
  - Make it a discriminated union:
    - tab-default/no-isolation target: no pane isolation is requested; it never enters the stable-pane resolver flow and reports `ready` for the intentional tab-level/default terminal state.
    - stable pane target: carries `paneKey` and/or UUID `leafId`, plus an explicit isolation request/result state.
    - migration-unsupported target: carries `ptyId` plus registry-backed `paneKey` / UUID `leafId` proof and an explicit unavailable result state.
  - Do not use `paneId: null` to mean both "no pane isolation requested" and "requested pane unresolved".
  - Avoid carrying stale numeric `paneId` across the Activity boundary.
- In `TerminalPane`, resolve the Activity UUID leaf id to the current numeric pane id through the authoritative pane-key resolver immediately before calling `applyExpandedLayoutTo(...)`.
- Update or replace current `findActivityTerminalPortal(...)` descriptor lookup. Activity portal descriptors must be routed by `slotId`, target identity, and request token; matching only `{worktreeId, tabId}` is not enough when the same tab has multiple Activity-capable panes.
- Activity must not render PTY-id-only migration-unsupported targets. Migration-unsupported Activity targets are emitted only after local PTY registry or SSH/remote relay registry proof attaches the PTY to an owning UUID leaf or `paneKey`; before that proof, including while registry identity is refreshing, no Activity row or target is emitted.
- Define and share Activity migration-unsupported refresh limits as constants, for example in `src/shared/activity-migration-unsupported-refresh-limits.ts`, so Activity, registry refresh logic, and tests use the same values:
  - `MIGRATION_UNSUPPORTED_REFRESH_TTL_MS = 15_000`
  - `MIGRATION_UNSUPPORTED_REFRESH_DIAGNOSTIC_INTERVAL_MS = 10_000`
- If a previously proven migration-unsupported target is refreshing, Activity may keep that existing target `pending` only while its prior owning-pane proof remains valid and refresh age is within `MIGRATION_UNSUPPORTED_REFRESH_TTL_MS`. Proof remains valid only when the descriptor still matches the same `ptyId`, registry source identity, source epoch, worktree/tab identity, and registry-backed `paneKey`/`leafId`.
- Once the PTY is confirmed migration-unsupported with matching registry-backed pane proof, Activity reports `unavailable` and does not attempt pane-key isolation. If proof is lost or mismatched, Activity removes the target. If the refresh exceeds `MIGRATION_UNSUPPORTED_REFRESH_TTL_MS` before renewed proof arrives, Activity reports `unavailable` for the previously proven target with diagnostics. None of these states may fall back to PTY-id-only routing. Result correlation uses `slotId`, target identity (`ptyId` plus registry-backed `paneKey`/`leafId`), and request token.
- Report unresolved or failed isolation back to Activity so readiness cannot succeed on a whole split tab.
- Include `slotId`, target identity (`paneKey` for stable targets, or `ptyId` plus registry identity for migration-unsupported targets), and an isolation request/generation token in Activity isolation result reports.
- Activity ignores isolation result reports that do not match the current descriptor's `slotId`, target identity, and request token.
- Activity must not infer reattach pending from a resolver unresolved result alone. Reattach-pending Activity state requires a current source-aware bridge/registry classification for the same target, or the previously proven migration-unsupported refresh path above.
- Use explicit isolation result states:
  - `pending`: resolver `reason: 'suspended-replay'`, a source-aware bridge/registry classification of `pending-replay-or-reattach` for the same target, or a previously proven migration-unsupported target whose owning-pane proof is still valid while refresh remains within `MIGRATION_UNSUPPORTED_REFRESH_TTL_MS`.
  - `unavailable`: resolver `reason: 'confirmed-missing'`, `reason: 'ownership-mismatch'`, or confirmed migration-unsupported with registry-backed pane proof.
  - `ready`: exact-pane isolation was applied successfully.
- Activity automatic read acknowledgements from selection or jump-to-thread run only after a `ready` isolation result that matches the current descriptor's `slotId`, target identity, and request token. `pending`, `unavailable`, rejected, or stale isolation results must not auto-ack. Explicit user mark-read commands may still mark the thread read manually without waiting for isolation readiness.
- If resolution fails:
  - restore any Activity isolation snapshots;
  - report `unavailable` for confirmed unresolved pane keys, or `pending` while replay is suspended or same-target bridge/registry classification proves reattach is still pending;
  - do not render the whole split tab.

Tests:

- Activity selected thread for a split tab isolates only the agent pane.
- Activity tab-default/no-isolation target reports ready without pane resolver lookup and is not conflated with unresolved pane isolation.
- Activity construction drops stale numeric legacy pane keys, so it never renders both panes as a fallback.
- Activity emits no migration-unsupported row or target for PTY-id-only findings while registry identity refreshes before owning-pane proof.
- Activity migration-unsupported targets require registry-backed `paneKey`/UUID `leafId` proof, report unavailable once confirmed without attempting pane-key isolation, and ignore stale results by `slotId`, target identity, and request token.
- an existing proven migration-unsupported Activity target may remain pending during registry refresh only while its prior owning-pane proof is still valid and refresh age is within `MIGRATION_UNSUPPORTED_REFRESH_TTL_MS`; proof loss or mismatch removes the target, timeout reports `unavailable` for the previously proven target, and no case creates a PTY-id-only pending target.
- migration-unsupported refresh tests use the shared TTL and diagnostic constants, not test-local magic numbers.
- migration-unsupported proof-validity tests cover same `ptyId`, registry source identity, source epoch, worktree/tab identity, and registry-backed `paneKey`/`leafId`; any mismatch removes the target instead of keeping it pending.
- stale stable pane key does not guess the active pane.
- failed isolation reports `unavailable` or `pending` and blocks terminal-ready success.
- confirmed-unresolved isolation reports `unavailable`, not indefinite `pending`.
- Activity maps resolver `reason: 'suspended-replay'` to `pending`, maps source-aware bridge/registry `pending-replay-or-reattach` for the same target to `pending`, and maps resolver `reason: 'confirmed-missing'` and `reason: 'ownership-mismatch'` to `unavailable` when no current same-target reattach classification exists.
- replay or source-proven reattach unknown isolation reports `pending` until it resolves to `ready` or `unavailable`.
- stale isolation result reports with an old `slotId`, `paneKey`, or request token are ignored.
- Activity selection or jump-to-thread auto-acks only after a matching `ready` result for the current `slotId`, target identity, and request token.
- Activity `pending`, `unavailable`, rejected, or stale isolation results do not auto-ack.
- explicit user mark-read commands still mark read manually when isolation is pending or unavailable.
- switching Activity between two descriptors in the same tab but different panes routes by `slotId`, `paneKey`, and request token, and never reuses the sibling descriptor.
- focus, auto-ack, and Activity isolation agree on resolved/unresolved results when replay generations change.
- switching selected Activity threads restores prior isolation and applies the new one.

### Follow-up: PTY Ownership & Liveness Hardening

Goal: after stable UUID leaf identity ships, harden PTY ownership and liveness without blocking the initial Activity/focus fix.

Expected changes:

- Maintain authoritative main-process `PtyPaneBinding` records keyed by PTY id. Projections such as `paneKeyPtyId`, PTY reverse binding, liveness state, ownership-token binding, and close-intent state come from this record, not separate independently-updated maps.
- Carry a monotonic `bindingEpoch` on each binding. Spawn, reattach, rebind, teardown, synthetic migration rows, and liveness snapshots must carry the same epoch so stale epochs cannot update, clear, or join against current state.
- Treat `numericPaneId` as renderer-local and valid only for the matching renderer generation. The durable join identity is the UUID layout leaf plus PTY id.
- Add a renderer-to-main resolver generation handshake after resolver map commit, layout replay, or SSH/remote reattach. Main updates binding renderer generation only after same-binding proof, then emits a fresh liveness snapshot for affected pane keys.
- Treat liveness as tri-state:
  - `live`: pane key is bound to a live local PTY or SSH relay/PTY registry entry.
  - `dead`: a previously bound PTY has confirmed teardown.
  - `unknown/pending-reattach`: startup, renderer rebuild, or SSH reattach has not yet restored authoritative binding.
- Publish renderer-visible liveness snapshots keyed by `PaneKey` with envelopes such as `{ paneKey, ptyId, bindingEpoch, rendererGeneration, state }`.
- Bound `unknown/pending-reattach` with registry-aware timeouts. Positive local PTY or SSH/relay registry evidence keeps the pane pending while mappings rebuild; confirmed teardown transitions to `dead`/`unavailable`.
- Add durable `ORCA_PANE_OWNERSHIP_TOKEN` only when request transport cannot otherwise identify the sending PTY. Managed hook scripts and SSH/remote relay envelopes echo it as `paneOwnershipToken`.
- Do not treat an echoed ownership token as identity proof by itself. Registry/relay proof must come from PTY or relay instance identity outside the hook payload.
- Mint ownership tokens freshly per PTY lifetime/ownership epoch. Reject stale or reused tokens after PTY teardown, respawn, pane-key rebind, or ownership transfer.
- For identifiable stable-key PTYs with proven binding but failed ownership validation, emit synthetic `unavailable` / `auth-failed` state at the current binding epoch and clear it on teardown, rebind, respawn, or stable ownership recovery.
- Add close-intent tombstones for user pane/tab close, such as `{ paneKey, closeIntentId, ptyId, bindingEpoch }`. Retention suppression applies only to the matching acked tombstone. Plain PTY exit, SSH detach, relay loss, or timeout must not imply user close.
- If the user closes while binding is `unknown/pending-reattach`, record a bounded pending close-intent marker and reconcile only after current-binding proof.
- Keep this compatible with SSH/remote PTY reattach. The authority is the main-process PTY registry and SSH relay registry, not renderer-only tab layout.

Tests:

- `PtyPaneBinding` updates atomically keep pane-key binding, reverse binding, liveness, ownership-token state, and close-intent state on the same epoch.
- renderer ignores liveness envelopes whose `rendererGeneration` does not match the current resolver generation, and compares `bindingEpoch` only within the matched pane/PTTY binding.
- resolver generation commit/replay/reattach handshakes update main binding generations and rebroadcast current liveness so panes converge from pending without new hook traffic.
- hook ownership checks work for local and SSH/remote PTYs, including the PTY-scoped token path if the request cannot otherwise identify the sender.
- ownership tokens survive transient restart/detach only when registry identity proves the same PTY binding, and are rejected after PTY teardown, respawn, pane-key rebind, or ownership transfer.
- identifiable stable-key PTY with proven binding but failed ownership protocol surfaces synthetic unavailable/auth-failed and clears it on ownership recovery.
- slow SSH reattach with positive registry liveness remains bounded pending instead of being marked dead by timeout alone.
- close-intent tombstone handles close racing same-pane rebind/respawn without resurrecting retained rows.
- pending close-intent during unknown/SSH reattach reconciles on proven reattach or expires conservatively.

## Rollout Notes

- Existing sessions with legacy `pane:${number}` leaf ids will mint UUID leaf ids on first launch after this change and remap leaf-keyed metadata once.
- Old numeric pane keys in persisted agent status/cache state should be treated as stale and dropped.
- Shipped hook scripts still forward `ORCA_PANE_KEY` opaquely for the initial migration. Ownership-token hook changes belong to the hardening follow-up unless explicitly promoted.
- Refresh hook endpoint files/scripts on startup and reattach so newly spawned PTYs receive UUID leaf pane keys. Surviving PTYs with numeric pane keys are restarted/respawned or handled as `migration-unsupported` only when registry/relay proof attaches them to an owning UUID leaf or `paneKey`; before proof, keep PTY-id-only findings diagnostic. Do not silently accept numeric suffixes as routable pane identity.
- User-authored hook scripts that parse the numeric suffix are not supported by this migration. Document `ORCA_PANE_KEY` as opaque.
- The SSH use case needs explicit validation because PTY identity and reattach evidence must come from the PTY/relay registry, not only from mounted renderer panes.
- Forward upgrade is fail-closed for live PTYs spawned before stable pane keys. Existing child processes keep their original `ORCA_PANE_KEY`; if it is numeric, the stable-key build must either restart/respawn that PTY or mark its agent status as migration-unsupported/unavailable with diagnostics only after registry-backed owning-pane proof. Without that proof, keep the finding in main/relay diagnostics until proof, respawn, teardown, or user restart. This must cover both local daemon and SSH reattach.
- Rollback requires clearing hook/status cache and restarting live PTYs, or a compatibility guard that treats UUID leaf pane-key rows as non-routable and fail-closed under older code. Older builds mostly treat leaf ids opaquely, but they may overwrite UUID leaf-keyed metadata on save; rollback should either keep upgraded sessions on the stable-key build, clear agent hook/status/cache and restart PTYs, or quarantine/version-guard upgraded terminal-layout metadata before running older binaries. Do not add a large downgrade transform for this migration. If the hardening follow-up has landed, also delete or version-invalidate durable `PtyPaneBinding`, binding projection, liveness, ownership-token, and close-intent persistence.
- Add non-user-facing diagnostics: rate-limited counts/logs by drop reason (`invalid shape`, `legacy numeric`, `unresolved stable key`, `unidentified PTY`). Do not add UI.

## Validation Checklist

- Unit tests for `stable-pane-id`, `PaneManager`, layout serialization/replay, focus routing, auto-ack, ingress gate, and retention cleanup.
- Renderer test for split tab with two panes:
  - agent pane + blank pane;
  - clicking blank pane does not ack agent;
  - clicking row focuses agent pane.
- Activity test for split tab:
  - selected agent thread shows one pane;
  - stale pane key fails closed.
- Manual Electron check:
  - local terminal split;
  - Codex/Claude split;
  - renderer reload;
  - app restart;
  - SSH/remote terminal reattach.
- Mixed-version validation:
  - local daemon PTY spawned with numeric `ORCA_PANE_KEY` survives into stable-key build;
  - SSH PTY spawned with numeric `ORCA_PANE_KEY` survives into stable-key build;
  - both are restarted/respawned or shown as migration-unsupported/unavailable with registry-backed owning-pane proof and diagnostics, never silently shown as stopped or routed to another pane;
  - PTY-id migration state is joined through registry-backed pane identity to the exact split pane only when proof exists and produces a synthetic unavailable row/event before the numeric payload is discarded; before proof, no Activity/sidebar/status row or target is emitted;
  - idle numeric-key PTYs with no post-upgrade hook payload are found during startup/reattach scan;
  - renderer reload/replay remints numeric pane ids while a legacy PTY survives, and stale numeric ids do not route to a sibling;
  - SSH/remote relays preserve or refresh UUID leaf pane keys on reattach;
  - hardening follow-up validation covers `paneOwnershipToken`, `PtyPaneBinding`, liveness, and close-intent behavior if that stage is promoted.

## Non-Goals

- Replacing numeric pane ids inside `PaneManager`.
- Rewriting terminal layout or split rendering.
- Preserving old numeric pane keys across upgrade.
- Guessing a pane when a UUID leaf id cannot be resolved.
