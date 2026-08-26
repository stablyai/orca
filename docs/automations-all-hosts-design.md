# All-host Automations

## Status

Proposed. The protocol, identity, and fencing decisions are settled here. The product decisions listed under `Deferred / Open Questions` at the end of this document are still open and need an owner before the first release.

## Summary

The Automations page is global, but its data is currently loaded from one active authority and several code paths later infer ownership from a bare automation, run, repo, workspace, or host ID. That is unsafe once records from multiple desktop and runtime stores appear together.

This design introduces an authority-qualified automation catalog. Every row captures the exact desktop/runtime and self/SSH incarnation that produced it. Lists are cached per visible host, mutations and secondary reads are fenced against that captured incarnation, runtime version skew has an explicit fallback, and failures remain isolated to one authority.

`All hosts` is a renderer aggregation mode, not a backend-wide query. Selecting one host performs no discovery or automation query against unrelated authorities.

## Goals

- Show Orca automations stored by the desktop and every saved remote Orca runtime, including each authority's user-visible SSH targets.
- Make host scope visible and persistent without treating an unhydrated catalog as removal.
- Prevent ID collisions, runtime re-pairing, SSH remove/re-add, and late responses from crossing ownership boundaries.
- Keep useful cached results visible when one authority is slow, offline, incompatible, or stale.
- Route list, edit, delete, pause/resume, Run Now, run history, usage, navigation, and workspace actions through the captured owner.
- Avoid startup fanout, remote-manager fanout, unbounded retries, and all-run history downloads.
- Bring every dispatched run to a terminal state without a client attached, including unselected, page-closed, and headless runs.
- Remain safe when desktop clients and runtime servers update independently.

## Non-goals

- A global server-side automation index.
- Persisting automation list results across app restarts.
- Moving an automation between desktop and runtime authorities.
- Showing external automation managers owned by remote runtimes in the first release.
- Changing mobile routes, mobile RPCs, pairing, E2EE, or relay framing.
- Changing shell, path, Git, or Git-provider behavior.

## Required invariants

1. Storage authority is not inferred from `runContext.hostId`, `schedulerOwner`, the active runtime, or the selected workspace. Those fields may mark a record ambiguous; they may never assign it to a different authority.
2. An ID is unique only inside its authority. Automation, run, repo, workspace, setup, navigation, dialog, availability, and in-flight action keys are authority-qualified.
3. A stable host selection survives label and connection-state changes, but data or actions captured from an old runtime/SSH incarnation do not.
4. Missing catalog data is not evidence of removal. Removal requires a hydrated authoritative catalog or a tombstone.
5. Local selection never contacts a runtime or probes desktop SSH external managers. One runtime selection never contacts another runtime.
6. Target execution health and authority query health are separate. A disconnected SSH target does not prevent its owning, reachable authority from listing or editing stored automations.
7. A parameterless `automation.list` keeps returning the authority's complete list for old clients.

## Ownership and identity

Use separate stable and incarnation-bearing forms:

```ts
type AutomationAuthorityRef =
  | { kind: 'desktop' }
  | {
      kind: 'runtime'
      environmentId: string
      pairingRevision: number
    }

type AutomationHostSelector =
  | { kind: 'self' }
  | {
      kind: 'ssh'
      targetId: string
      targetGeneration: number
    }

type AutomationOwnerRef = {
  authority: AutomationAuthorityRef
  selector: AutomationHostSelector
}

type StableAutomationHostRef = {
  authority: { kind: 'desktop' } | { kind: 'runtime'; environmentId: string }
  selector: { kind: 'self' } | { kind: 'ssh'; targetId: string }
}

type StableAutomationCatalogRef =
  | StableAutomationHostRef
  | {
      authority: { kind: 'desktop' } | { kind: 'runtime'; environmentId: string }
      selector: { kind: 'orphan' }
    }
```

`pairingRevision` is the saved runtime environment's existing pairing revision. `targetGeneration` is a durable SSH registration incarnation, not a connection attempt counter. Add an optional generation to stored SSH targets and `SshTargetSummary`; assign one while loading legacy targets and advance it only when a target is deleted/re-created or explicitly re-adopted. Connection, reconnect, and status transitions do not advance it.

Allocate generations from a persisted monotonic counter owned by each automation authority. On load, the authority reloads that counter as a high-water mark — `max(persisted counter, highest generation on any stored target or automation) + 1` — so a counter lost to a rollback can never reissue a generation an automation already captured. The migration first scans stored automations: a referenced missing SSH target creates a bounded removal tombstone with its last known label before generations are assigned. That makes legacy ghosts discoverable from the existing mirrored `removedTargetLabels`, including on a newly paired client with no list cache. Runtime-owned migrations run on the runtime authority, not on the desktop copy of its catalog.

New and migrated automations persist the selected SSH generation as an optional owner field. A legacy automation whose target still exists adopts the target's current generation during migration. A legacy automation whose target is absent becomes an orphan and is not silently assigned to Self or to a later same-ID target.

### Orphan and ambiguous records

An orphan has a known storage authority and no executable owner. An ambiguous record is a desktop-stored automation whose `schedulerOwner` or run context points at a runtime. Both are readable, and both follow the same rules:

- The owning authority refuses to dispatch them. Its scheduler and `automation.runNow` return the typed `target_removed` conflict and record a skipped-run reason. Disabling actions in the client is presentation, not enforcement.
- Migration persists `enabled: false` for every record it classifies as orphaned or ambiguous, so a classified record cannot keep firing on a guessed host before its authority is upgraded.
- Run Now, edit, and workspace navigation are disabled. Pause/resume and Delete stay enabled: both need only the storage authority, which is known.
- Re-adoption is offered only when a compatible target is present under the same authority. When none is, Delete is the only remaining repair. Cross-authority moves stay unsupported.
- Orphan reads are fenced like owned reads. List requests, `automation.show`, and cache entries carry `{ kind: 'orphan' }` as the selector, and commit compares authority, catalog, and request generations only. A record moving into or out of orphan publishes one source and one destination event, or a single unscoped authority event when the old selector cannot be recovered.

Two keys serve different purposes:

- `hostStableKey(StableAutomationCatalogRef)` excludes incarnation fields and is used by the persisted filter and display slot.
- `ownerKey(AutomationOwnerRef)` includes `pairingRevision` and `targetGeneration` and is used by fetched rows, mutations, secondary reads, and request commit checks.

Use one canonical encoder with explicit kind prefixes and encoded components; do not use display labels, bare IDs, or ad hoc `JSON.stringify` order as keys.

```ts
type AutomationListRow =
  | {
      kind: 'owned'
      key: string // ownerKey + automation.id
      owner: AutomationOwnerRef
      automation: Automation
      usageSummary: AutomationUsageSummary | null
    }
  | {
      kind: 'orphan'
      key: string // authority stable key + automation.id
      authority: AutomationAuthorityRef
      automation: Automation
      issue: string
    }
```

Every owner-qualified navigation record includes the automation ID and, when applicable, the run ID, repo ID, workspace ID, and project-host-setup ID. Existing maps keyed only by repo/workspace ID cannot be used to resolve these rows because cross-host ID collisions are legal.

Before any mutation or secondary read, resolve the current catalog entry for the stable key and compare its full owner to the captured owner. A mismatch fails closed with `This automation's host changed. Reload it before continuing.` The backend repeats this validation for capable runtimes; client-side checking alone is not sufficient.

## Automation host catalog

Create a dedicated automation host catalog. Do not overload the flat `ExecutionHostId`, because Runtime + SSH needs both a parent authority and a nested target.

```ts
type AutomationHostCatalogEntry = {
  stableRef: StableAutomationCatalogRef
  owner: AutomationOwnerRef | null
  stableKey: string
  label: string
  authorityLabel: string
  kind: 'self' | 'ssh' | 'orphan'
  catalogState: 'authoritative' | 'unhydrated' | 'removed'
  authorityHealth: AutomationAuthorityHealth
  executionHealth: AutomationExecutionHealth
  querySupport: 'scoped' | 'legacy-unscoped' | 'incompatible'
}
```

Catalog projection rules:

- Project Desktop + Self and desktop-owned saved SSH targets from the existing execution-host registry.
- Project Runtime + Self from saved runtime environments, even while a runtime is offline.
- Project Runtime + SSH from that environment's `sshStateByEnvironment` bucket. Combine parent runtime health/compatibility with nested SSH state; never copy nested targets into desktop SSH maps. That bucket gains a per-target registration-generation map alongside `targetLabels`, populated from the extended `SshTargetSummary` and cleared with the other bucket fields when the environment's SSH state goes stale. A runtime that does not advertise `automation.list-host-scope.v1` supplies no generations: its entries key on target ID alone and are view-only.
- Preserve labels from saved environments, `targetLabels`, and `removedTargetLabels` during outages.
- Hide runtime-owned ephemeral SSH targets under the existing visibility rule.
- Preserve a ghost/orphan entry when referenced by a stored automation, cached row, persisted filter, or removal/re-adoption tombstone.
- Do not initiate runtime connections, target-list calls, or SSH connections merely to render the picker. Runtime SSH discovery consumes already mirrored state and becomes authoritative only when `targetsHydrated` is true.

Catalog generation is tracked per authority and advances whenever that authority's authoritative membership or incarnation changes. The commit fence compares only the generation of the authority that owns the entry, so one host's membership change — another runtime's target bucket hydrating, a target added anywhere — cannot discard every other host's in-flight response and exhaust the retry cap. Runtime connection status and SSH connection status update health without changing catalog generation.

Deterministic order is: All hosts, Desktop + Self, desktop SSH targets by locale-aware label then target ID, the desktop orphan entry, runtime authorities by label then environment ID, and each runtime's SSH targets immediately after its Self entry by label then target ID followed by that authority's orphan entry. Omit empty orphan entries. Construct one collator and precomputed sort fields per catalog rebuild.

## Persisted filter and hydration

Persist this optional UI value:

```ts
type AutomationHostFilter =
  | { kind: 'all' }
  | { kind: 'host'; host: StableAutomationCatalogRef }
```

Only the stable form is persisted. Restore it after the relevant catalogs settle:

- Desktop + Self is immediately authoritative.
- Desktop SSH absence counts only after `sshTargetsHydrated`.
- Runtime Self absence counts only after the saved runtime catalog settles.
- Runtime SSH absence counts only after that runtime's target bucket hydrates or a removal tombstone provides positive evidence.

While relevant state is unhydrated, retain the selection and show `Loading host…`; do not fall back or write `All hosts` over the saved value. Once positive removal evidence exists, keep an orphan choice if automations/tombstones still reference it; otherwise switch to All hosts and announce the change.

A persisted orphan selection settles only after the owning authority has returned an authoritative `orphanCount` or an old-server unscoped list. If the authority is offline, retain the selection as unavailable rather than assuming the orphan was repaired.

SSH re-adoption migrates automation owner generations, repo/workspace references, removal tombstones, and this persisted filter in one persistence transaction. Same-ID runtime re-pairing retains the display selection, but evicts old authority data and requires a fresh query before rows or actions return.

## List contract and runtime compatibility

Add two string capability constants to `src/shared/protocol-version.ts`:

```ts
export const AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY =
  'automation.list-host-scope.v1' as const

export const AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY =
  'automation.owner-fencing.v1' as const
```

The first capability guarantees scoped list parameters, runtime response validation fields, bounded usage summaries, and expected SSH-generation checking for list reads. The second covers mutation and secondary-read owner preconditions.

Both constants must also be appended to the exported `RUNTIME_CAPABILITIES` array in the same file. `getStatus()` advertises only entries drawn from that array, so a declared-but-unregistered capability leaves every capable runtime looking legacy and makes the New/New matrix row unreachable.

The exact `automation.list` request is:

```ts
type AutomationListParams =
  | undefined
  | null
  | {
      selector?:
        | { kind: 'self' }
        | { kind: 'ssh'; targetId: string; expectedTargetGeneration: number }
        | { kind: 'orphan' }
    }
```

Omitted params, `null`, `{}`, or an omitted `selector` return the authority's complete automation list. This preserves old-client behavior. A supplied selector filters in the authority backend before serialization. Self means records explicitly stored with a self/local execution target; it does not mean “anything not recognized as SSH.”

The response keeps the existing `automations: Automation[]` field so an old client can consume a new server. A capable server adds projection metadata; for a scoped request, `items` is required and has a validated one-to-one match with `automations`:

```ts
type AutomationListResult = {
  automations: Automation[]
  items?: Array<{
    automationId: string
    selector:
      | { kind: 'self' }
      | { kind: 'ssh'; targetId: string; targetGeneration: number }
      | { kind: 'orphan'; issue: string }
    usageSummary?: AutomationUsageSummary | null
  }>
  orphanCount?: number
}
```

The client runtime-validates rather than casts. It rejects malformed top-level responses, drops and records malformed individual rows, requires exactly one metadata item per scoped automation ID, verifies every returned selector matches the request, and never reclassifies a mismatched row into Self. A malformed or missing metadata item drops its paired automation from the committed rows and increments the invalid-row counter; the one-to-one requirement is evaluated over the surviving pairs, not over the raw `automations` array, so one bad row neither hides a whole host nor produces an unqualified row. Old clients ignore `items` and `orphanCount`; new clients talking to old servers use the legacy partition below. Any scoped response may report `orphanCount`; a positive count adds the authority's orphan catalog entry and queues one orphan-scope request. An orphan row has known storage authority but no executable owner, so it is readable and all actions are disabled.

Routing is by authority:

- Desktop uses local IPC with the same selector semantics and owner preconditions.
- A capable runtime gets one scoped request per requested host.
- An older runtime gets at most one parameterless `automation.list` request per authority per refresh cycle. Partition that result into all requested Self/SSH cache entries; never make the same full-list request once per selector.

Legacy partitioning is explicit:

- Self requires positive evidence: `executionTargetType` is `local` **and** the owning repo resolves with no connection ID. The desktop store writes the literal `local` whenever that repo lookup misses, and for repos hosted on a runtime, so a bare `local` value is not evidence on its own.
- A valid SSH record with a non-empty target ID goes to that target's entry, creating a ghost entry if necessary. Legacy SSH rows carry no generation: key them by target ID alone and keep them view-only until the authority advertises `automation.owner-fencing.v1`.
- Unknown execution types, missing SSH IDs, contradictory target fields, records whose owning repo no longer resolves, records whose `schedulerOwner` or `runContext.hostId` points at a runtime, and other malformed legacy records go to an `Unassigned legacy automations` orphan entry.
- `runContext.hostId` and `schedulerOwner` mark a record ambiguous. They never override storage ownership, never assign a record to a different authority, and never repair a malformed selector.
- The authority's create and update paths stop re-deriving `local` from a missed repo lookup. They preserve the stored selector and fail closed instead, so a deleted project cannot silently convert an SSH automation into a local one.

The legacy response has no bounded usage projection. Do not compensate by downloading all run histories. Render neutral `Usage unavailable` copy until the selected automation's lazy history is loaded.

If a runtime lacks owner fencing, all of its rows stay readable and none are mutable. Runtime + Self and Runtime + SSH are both view-only until the server advertises `automation.owner-fencing.v1`; show an Update server action rather than performing an unfenced Run Now, edit, or delete. Pairing-revision freshness authenticates the connection, not the record's selector, so it is not a substitute — a record whose target changed server-side since the last refresh would still run on a host the user never saw. This mirrors the fail-closed capability assertion the codebase already applies to remote file mutations.

### Owner-fenced operation contract

For capable runtimes, add this optional precondition to `automation.show`, `automation.runs`, `automation.update`, `automation.delete`, and `automation.runNow`; add `destination` to create and to updates that may move selectors:

```ts
type AutomationOwnerPrecondition = {
  selector:
    | { kind: 'self' }
    | { kind: 'ssh'; targetId: string; targetGeneration: number }
}

type AutomationOwnedIdParams = {
  id: string
  expectedOwner?: AutomationOwnerPrecondition
}

type AutomationCreateDestination = {
  destination?: AutomationOwnerPrecondition
}
```

Concretely, show/delete/runNow use `{ id, expectedOwner? }`; runs uses `{ automationId?, expectedOwner? }`; update uses `{ id, updates, expectedOwner?, destination? }`; and create appends `destination?` to its existing fields. Pause and resume are `automation.update` payloads and carry the same `expectedOwner` precondition; if they ever land as dedicated RPCs they take it too, so scheduler state cannot be changed for the wrong incarnation while every neighbouring action is fenced. A capable new client always supplies the applicable fields. Parameterless old-client shapes remain valid.

The authority is implicit in the local IPC endpoint or runtime RPC connection; it is never supplied as a caller-chosen environment ID inside the payload. Runtime calls also pass the captured `pairingRevision` to the existing renderer/main runtime-environment revision guard before transport dispatch and again before accepting the response. The runtime backend compares the expected selector with the stored automation's selector and current SSH registration generation in the same synchronous persistence operation that reads or mutates the record. Create validates the destination immediately before insert. Update validates both the stored source and requested destination before replacement. Validation resolves `destination.selector` against the authority's current saved target registry inside that same operation: Self is allowed, SSH requires a present target ID whose current registration generation matches, and orphan or unknown selectors are rejected with a structured error and no write. A destination is never accepted as a free-form value, so an automation cannot be attached to a ghost or future same-ID target and become runnable on the wrong host once a later registration satisfies the fence.

The preconditions are optional on the wire so old clients can call new servers, but optional is not unenforced. A capable server rejects any mutation or execution request that omits `expectedOwner` when the stored automation carries an SSH selector with a generation, returning a typed upgrade-required conflict with no side effects. The precondition stays genuinely optional only for Self records and for legacy SSH rows that still have no generation, so unfenced mutation never becomes permanent server behavior for a caller that skips the field. A new client sends the fields whenever `automation.owner-fencing.v1` is advertised. A mismatch returns a typed conflict and performs no mutation or execution. Validation, not Zod stripping of unknown fields, defines this behavior.

## Cache and request lifecycle

Keep an in-memory entry per catalog stable key:

```ts
type CacheEntry = {
  data: AutomationListRow[]
  fetchedAt: number | null
  attempt: number
  requestGeneration: number
  catalogGeneration: number
  request: Promise<void> | null
  error: AutomationHostQueryError | null
}
```

Errors use a typed code rather than copy matching:

```ts
type AutomationHostQueryError = {
  code:
    | 'authority_unavailable'
    | 'timeout'
    | 'permission_denied'
    | 'incompatible'
    | 'invalid_response'
    | 'owner_changed'
    | 'target_removed'
    | 'unknown'
  message: string
  retryable: boolean
  retryAt: number | null
}
```

Policy:

- TTL is 30 seconds. Fresh data is returned without a request; stale data remains visible during revalidation.
- A request captures stable key, full owner, request generation, the owning authority's catalog generation, and the authority connection generation. The authority connection generation is the saved runtime environment's current `pairingRevision` — the same value the existing renderer/main revision guard compares — and a fixed constant for the desktop authority. It is not a third counter.
- Refresh, mutation invalidation, authority re-pair, SSH re-adoption/removal, and entry eviction advance `requestGeneration` before starting replacement work.
- A response commits only when every captured generation still matches and no removal tombstone supersedes it. Otherwise it is discarded.
- Concurrent callers for the same owner share `request`. One authority-level legacy fallback request may fulfill several entries.
- A failed refresh retains successful data and records the error separately. Success clears `attempt` and `error`.
- Automatic transient retry uses full jitter with a 1-second base and 30-second cap, at most three attempts while the page remains visible. Permanent validation, permission, and incompatibility failures do not retry. Manual Retry bypasses cooldown and starts one new attempt.
- Authority calls use a four-request global pool. The selected host and Desktop + Self have priority. Obsolete queued work is cancelled when the filter/catalog changes; already-sent transport work may finish but must pass the commit fence.
- An All-hosts refresh never initiates an authority connection. It queries only authorities with an established connection; a saved-but-disconnected authority renders a compact status row with a Reconnect action and is fetched only after the user reconnects or selects that host directly. Reconnect triggers one prioritized refresh for stale entries owned by that authority. Nested SSH disconnection does not block a list query when its authority is reachable.
- Manual All-host refresh bypasses TTL for reachable authorities only. Unreachable authorities retain stale data and expose Reconnect; the refresh does not enqueue requests already known to fail.
- Focus/visibility refreshes only stale entries and is coalesced. No fixed polling interval is added.
- Removed non-visible entries are evicted after request invalidation. Retired cache entries are LRU-capped at 256; visible catalog entries and active requests are not retained in that retired pool.

Mutation invalidation happens before the request is sent, so an older in-flight list cannot overwrite the mutation result. Create/update/delete/pause/resume/Run Now invalidate only affected entries. An update may move an automation between Self and SSH selectors inside one authority: remove it optimistically from the source, invalidate both source and destination, and reconcile both responses. Cross-authority movement is rejected.

## Editing, creation, and actions

Edit hydration, conflict checks, save, delete, pause/resume, Run Now, and lazy history all receive the selected row's `AutomationOwnerRef`. They must not call the desktop store or active runtime as a fallback.

The editor resolves project, repo, workspace, folder-workspace, and project-host-setup options within the captured authority. Those option identities are authority-qualified before entering maps. Selecting another project may move between Self and SSH selectors owned by the same authority; the save request includes both expected source owner and destination owner. It cannot move between desktop and runtime authorities.

Creation rules:

- A single concrete host filter preselects and constrains the destination. Orphan entries cannot create.
- Under All hosts, default from the active workspace's qualified owner only when it resolves to a catalog entry with a non-null executable owner, and show that owner explicitly before submit. When that owner is missing, unhydrated, orphaned, or not uniquely resolvable, require an explicit host choice before submit; never fall back to the active runtime or to a bare workspace or repo ID.
- The create request captures and validates the destination incarnation immediately before submit.
- If a concurrent catalog change makes the destination stale, fail closed and preserve the form.
- After success, select the created row. If it is unexpectedly outside the current filter, intentionally switch the filter to its destination and announce that change; never let a successful creation silently disappear.

Dialogs keep their captured owner for their entire lifetime. An authority/target incarnation change disables submit and presents Reload; it never silently retargets an open form.

## Run history, usage, and completion

Run history stays lazy and authority-qualified: fetch only the selected automation's runs, page/cap them under the existing retention rules, and key selection/navigation by owner + automation ID + run ID.

The list must not fetch all runs to build usage. Capable list projections include the existing aggregate fields (`knownRuns`, `unavailableRuns`, token totals, and estimated cost) computed by the authority while it already owns bounded retained runs. Legacy rows show neutral unavailable usage until their selected history is present.

Move dispatched-run completion and usage reconciliation out of `AutomationsPage` rendering into the authority-owned automation service/dispatcher. The desktop service and each runtime service observe their own dispatched sessions, persist terminal status exactly once, and publish change events whether or not any client has the Automations page open. On authority startup, reconcile retained non-terminal runs against owned execution/session state. This prevents unselected or headless runs remaining stuck in `dispatched` and avoids client fanout.

## External automation managers

The first release includes external managers only for Desktop + Self and desktop-owned SSH hosts. Runtime + Self and Runtime + SSH show Orca automations only. This is an explicit scope boundary, not an unknown-source fallback. On a runtime-owned host, both the empty and the populated state say so: the absence of manager rows there is a stated scope boundary and is never presented as "none configured".

Replace the broad desktop `listExternalAutomationManagers()` page call with scoped IPC operations that accept the captured desktop `AutomationOwnerRef` and provider. Every scoped call — list, runs, create, update, and action — re-applies the two checks the broad call enforced, before contacting a relay or launching a provider command: the runtime-owned-target exclusion that keeps hidden targets out of user-facing surfaces, and the same saved-owner comparison used for Orca mutations, including `targetGeneration` against the current SSH registration. A mismatch fails closed with the host-changed conflict and performs no probe. Selecting Local probes only local managers. Selecting one desktop SSH host probes only that target. All hosts schedules `{host, provider}` calls through the same bounded pool at lower priority than Orca automation list and mutation traffic for the selected host and Desktop + Self, cancels them when the filter leaves desktop scope, and does not eagerly probe every SSH target from a Local view. Manager work counts toward the release profiling in-flight assertion.

Manager, job, run, dialog, and action keys include owner + provider + provider ID. Cache and error state are per `{owner, provider}`, separate from Orca automation storage health. An external-manager failure cannot mark the host's Orca store unavailable.

Adding runtime-owned external managers later requires dedicated runtime list/runs/create/update/action RPCs, authority-qualified target types, capabilities, validation, and old-server UX. It must not be implemented by tunneling a desktop-only target or treating unknown authority as Local.

## Security and trust boundaries

Runtime authentication and authorization remain those of the existing paired RPC connection. The server derives authority from that connection, validates selectors against its saved target registry, and treats target IDs only as identifiers; no selector is interpolated into a path or shell command. Owner conflicts, permission errors, and invalid schemas return structured errors without record or prompt contents. Response validation and telemetry never log prompts, precheck commands, run output, credentials, or external-manager payloads.

The renderer cannot bypass fencing by supplying a different authority or generation. Local IPC performs the same saved-owner comparison, and runtime RPC handlers compare against server-owned state. External-manager scoped IPC verifies the requested desktop target and provider allowlist before contacting a relay or launching a provider command.

## Change events and invalidation

Add an `automationsChanged` event to the existing local event channel and runtime client event stream:

```ts
type AutomationsChangedEvent = {
  type: 'automationsChanged'
  selector?: { kind: 'self' } | { kind: 'ssh'; targetId: string } | { kind: 'orphan' }
  reason?: 'definition' | 'run' | 'usage'
}
```

CRUD, scheduler transitions, run creation/status changes, and usage updates publish after persistence succeeds. Runtime authority is derived from the subscription environment and its current pairing revision; it is never accepted from the event body.

A scoped event invalidates its one stable entry. An older or unscoped event invalidates all entries for that one authority only. Coalesce event bursts in one microtask and share any legacy authority request. Reconnect, focus, and TTL revalidation remain fallback paths for older servers that publish no event.

An update that moves selectors publishes one event for the source and one for the destination; if the old selector cannot be recovered, publish one unscoped authority event. Subscribers treat duplicate events as harmless invalidations.

The event is additive. Old clients must continue to ignore the unknown event type. Do not introduce a new stream opcode; if transport framing ever requires one, capability-negotiate it because old decoders may silently drop unknown opcodes.

## User experience

The host picker and search field remain visible in loading, empty, no-match, and failure states. Use the existing Select primitive for eight or fewer entries and the existing searchable Command/Popover for nine or more. Both expose the label `Filter by host`; the searchable variant focuses search on open, Enter selects, and Esc closes without changing selection.

Every row shows a host badge rendered with the existing `RepoBadgeLabel` component already used for host and repo labels elsewhere in the automations UI. The pill `Badge` component has no `muted` variant, and this design does not add one. Badge truncation retains the full accessible name and tooltip. Search runs after host selection and matches name, project, workspace, agent, host label, and at most the first 2,048 prompt characters. Build the normalized search index once per changed row set, not during each render or comparator call.

Keep these states distinct:

- Authority query: loading, fresh, refreshing, stale-error, unavailable, incompatible.
- Execution target: connected, connecting, disconnected, unavailable, unknown.

Under All hosts, rows are grouped by host in the same deterministic catalog order the picker uses, with each host's compact host-level status row anchored at the top of its group, so incomplete authorities do not reflow the list as responses arrive. Healthy and stale rows render inside their group as they arrive. A stale row remains readable. Each persistent failure supplies the relevant Retry, Reconnect, or Update server action; do not rely on a toast for recoverable errors. Run Now is disabled when execution health is insufficient, with a concrete reason, while storage-only actions follow authority and fencing availability.

Use a polite, deduplicated `aria-live` summary for partial failures, worded `<N> of <M> hosts could not be loaded`. Re-announce only when the failed-host count changes, not on every retry attempt. Do not move focus when status rows appear. If filtering or refresh removes the focused row, move focus to the next row, then previous row, then the picker; changing selection must not open a detail or fetch history until the replacement row is rendered.

Empty copy distinguishes `No automations on <host>`, `No automations across loaded hosts`, `No automations match your search`, and `Automations could not be loaded from <host>`. Copy never claims a disconnected or unhydrated host is empty. On a runtime-owned host it also states that external automation managers are not listed for that host in this release, so a scope-limited host is never presented as clean.

## Performance and resource budgets

- No automation or external-manager network work is added to app startup or picker render.
- Selected-host first usable rows require at most one authority request; old-server All hosts requires at most one unscoped list request per authority.
- Concurrency is four remote requests, retries are capped, event bursts are coalesced, and timers/listeners are disposed when the page/controller closes.
- Prompt indexing is bounded per row. Retired cache history is capped. Tombstone history is capped per authority, but a tombstone still referenced by a stored automation, cached row, or persisted filter is retained past the cap: a tombstone becomes evictable only after its owning authority has returned an authoritative catalog with no remaining reference to that target. Positive removal evidence is never discarded while something still depends on it. Run lists continue to use existing retention/pagination caps.
- Cache instrumentation records request counts by authority/stable key, in-flight dedupe hits, discarded stale responses, result row counts/bytes, and refresh duration. It does not log prompts or run output.
- Release profiling covers 1,000 automations across 50 hosts, one offline authority, one old runtime, rapid filter changes, and an event burst. Acceptance: no more than four remote calls in flight, one legacy call per authority per cycle, no stale commit, and no synchronous long task over 50 ms attributable to filter/search on release hardware.

## Migration and mixed-version behavior

Persisted additions are optional so rollback builds ignore them:

- SSH target registration generation.
- Automation SSH owner generation.
- Persisted stable automation host filter.

Migration is idempotent and preserves unknown fields. It assigns generations only with positive current-target evidence, preserves missing references as ghosts, and never rewrites an orphan to Self.

Supported rollback fixtures must prove the previous desktop/runtime builds preserve the optional generation fields on read/write. If a rollback-era state has lost those fields and a same-ID SSH replacement cannot be distinguished from the prior target, re-upgrade classifies the automation as ambiguous and requires explicit re-adoption; it does not guess and run on the replacement host.

Existing desktop-stored records whose `schedulerOwner` or run context points at a runtime need explicit classification. Physical storage remains the authority unless a separate verified migration proves the runtime holds the canonical record. The first release does not delete or automatically transfer such records. Ambiguous records appear in the legacy/orphan entry with actions disabled and recovery guidance, preventing duplicate scheduling or destructive guessing.

Desktop/runtime version matrix:


| Desktop                          | Runtime | Behavior                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old                              | New     | Parameterless list still returns the complete authority list; new optional fields/events are ignored.                                                                                                                                                                                                |
| New                              | Old     | One unscoped list per authority, defensive partition, neutral usage, all runtime rows view-only without owner fencing. Runs dispatched by that server are reconciled only by it, so they stay `dispatched` until it updates; the row surfaces Update server rather than hanging with no explanation. |
| New                              | New     | Scoped lists, bounded usage summaries, owner-fenced actions, scoped invalidation.                                                                                                                                                                                                                    |
| New before/after same-ID re-pair | Any     | Old cache/actions are evicted by pairing revision; stable display selection may remain.                                                                                                                                                                                                              |


No mobile-facing route, schema, RPC, handshake, protocol minimum, recommended app version, pairing file, E2EE, or relay surface changes. Automation RPC/event additions remain runtime-scoped, additive, and optional. No platform-specific path, shell, keyboard, native-module, filesystem, or Git behavior is introduced; the design applies equally on macOS, Windows, Linux, WSL, SSH, relay, git worktrees, and folder workspaces.

## Implementation sequence

1. Add canonical stable/owner refs, SSH registration generation persistence/migration, qualified row/run/navigation keys, and owner comparison helpers.
2. Build the dedicated catalog and persisted-filter hydration/re-adoption behavior.
3. Add local scoped IPC, runtime list capability/schema/validation, legacy authority partitioning, and owner-fenced mutation/secondary-read contracts.
4. Add the generation-fenced cache, bounded scheduler, invalidation events, retry policy, and instrumentation.
5. Move run completion/usage reconciliation into authority-owned services and add list usage projections. This step fixes a defect every user hits today — runs stuck in `dispatched` whenever the page is closed — and depends on nothing in steps 1-4, so it can land on its own schedule rather than waiting on the multi-host work.
6. Convert edit/create/actions/dialogs/project/workspace resolution to captured owners.
7. Add picker, badges, search index, partial states, recovery actions, focus, and announcements using the style guide and existing primitives/tokens.
8. Replace broad external-manager discovery with desktop-only scoped provider calls.
9. Remove the active-runtime inference and broad all-run fetch paths only after the new tests pass.

Each step lands with its compatibility tests; do not ship a UI that merges authorities before mutation and navigation identity are converted.

## Test plan

### Identity, catalog, and persistence

- Equal automation/run/repo/workspace IDs under two authorities remain distinct through selection, edit, navigation, and React keys.
- Equal SSH target IDs under Desktop and a runtime do not collide.
- Same-ID runtime re-pair and SSH remove/re-add discard stale rows, requests, dialogs, and actions.
- Unhydrated absence retains the persisted selection; authoritative removal falls back or preserves a ghost as specified.
- Rename preserves stable selection and cache slot; re-adoption migrates automations and filter atomically.
- Ephemeral runtime SSH targets stay hidden; parent outage preserves nested labels without claiming removal.

### Query, cache, and performance

- Local selection makes zero runtime and SSH-manager calls.
- Runtime selection contacts only that runtime; nested SSH disconnection does not block authority listing.
- Capable All hosts makes scoped calls with at most four remote requests in flight.
- Old-server All hosts makes exactly one unscoped request per authority and partitions Self, SSH, and orphan records correctly.
- Fresh/stale/error behavior, in-flight dedupe, capped retry, reconnect refresh, queue cancellation, and LRU eviction are deterministic with fake time.
- Late responses after refresh, mutation, removal, re-adoption, re-pair, and catalog replacement cannot commit.
- Search indexing is bounded and the 1,000-row/50-host profiling fixture meets the stated budgets.

### Actions, create, and edit

- Show, edit hydration/conflict/save, delete, pause/resume, Run Now, runs, usage, and open-workspace route through captured owners.
- Incarnation changes while a dialog is open fail closed and preserve input.
- In-authority selector movement invalidates/removes source and destination correctly; cross-authority movement is rejected.
- Single-host create is constrained; All hosts defaults visibly from the active qualified workspace; post-create selection never disappears silently.
- Folder workspaces and git worktrees both resolve inside the captured authority.
- An enabled automation whose SSH target was deleted produces no run on any host: its authority refuses the dispatch, records a skipped-run reason, and the migration left the record disabled.
- An automation whose owning repo was deleted, and a desktop-stored record scheduled against a runtime, both land in the orphan entry rather than under Desktop + Self.
- Delete and pause remain available on orphan and ambiguous rows; Run Now, edit, and workspace navigation do not.

### Runs and events

- List rendering fetches no broad run history.
- Selected history is lazy and authority-qualified; legacy usage copy is neutral.
- Unselected, page-closed, remote, restarted, and headless dispatched runs reach a terminal state through authority-owned reconciliation on capable authorities. Against an older runtime the run stays `dispatched` and surfaces Update server instead of hanging with no explanation.
- CRUD/scheduler/run/usage events invalidate one selector; old unscoped events invalidate one authority; bursts coalesce.
- Old clients ignore the new event and still use parameterless list behavior.

### Failures, accessibility, and compatibility

- One timeout, malformed response, permission error, offline authority, or incompatible runtime does not hide other hosts.
- Stale data remains readable and persistent errors expose working Retry/Reconnect/Update actions.
- Picker/search remain present in every empty/error state; full badge labels, keyboard behavior, focus recovery, and deduplicated `aria-live` output pass accessibility tests.
- New/old desktop-runtime matrix tests cover omitted/null/empty/scoped list params and unknown optional fields.
- Persisted migration/rollback fixtures cover missing generations, orphan targets, same-ID replacement, and ambiguous desktop-stored remote-scheduled records.
- No mobile legacy fixture, protocol minimum, or mobile package changes; Windows/Linux/macOS static review finds no new platform-specific behavior.

## Release gates

- All unit, integration, and RPC compatibility tests above pass.
- Real desktop + current runtime, desktop + previous runtime, SSH, runtime-owned SSH, runtime re-pair, SSH re-adoption, folder workspace, and offline/reconnect smoke tests pass.
- The request-count and stale-response assertions pass under rapid interaction and network failure.
- There is no unresolved path that infers authority from a bare ID, active runtime, `runContext.hostId`, or `schedulerOwner`.
- External managers remain desktop-scoped unless their full runtime RPC design lands separately.

## Existing code that must change

- `src/main/runtime/rpc/methods/automations.ts`: `automation.list` is currently parameterless.
- `src/renderer/src/components/automations/automation-host-client.ts`: ownership currently collapses to local vs environment and can fall back from `runContext.hostId`.
- `src/renderer/src/components/automations/AutomationsPage.tsx`: refresh currently fetches broad runs, completion reconciliation is page-owned, and edit/refresh paths use the wrong ambient target.
- `src/main/persistence.ts`: update can change execution target and SSH re-adoption does not migrate automations/filter state. Create and update also derive `executionTargetType` from the owning repo, writing the literal `local` whenever that lookup misses.
- `src/main/ipc/automations.ts`: `automations:list` takes no selector, and `automations:markDispatchResult` is driven by the renderer.
- `src/main/automations/service.ts`: only the headless dispatch path reconciles completion; renderer-dispatched runs depend on the page being open.
- `src/renderer/src/store/worktree-repo-index.ts`: bare-ID maps cannot resolve cross-authority collisions.
- `src/renderer/src/store/slices/runtime-environment-ssh.ts`: runtime SSH state is correctly separate and supplies the basis for nested catalog projection, but connection generation is not the durable target registration generation required here.
- `src/main/automations/external-manager.ts`: manager listing currently probes all desktop SSH targets.
- `src/shared/automations-types.ts`: external targets and existing automation owner data lack authority/incarnation qualification.
- `src/shared/runtime-client-events.ts`: no automation invalidation event exists.
- `src/shared/protocol-version.ts`: runtime capabilities are string constants and need the new additive entries.
