# Scryer operation and Orca command parity map

Status: draft
Date: 2026-06-23

Document boundary: this is a linked design asset for operation parity,
contracts, and implementation details. It is not the decision map, not an ADR,
and not glossary content. The compact planning authority is
[orca-scryer-decision-map.md](./orca-scryer-decision-map.md).

This asset defines the migration target for replacing Scryer's MCP tools with
Orca-native Scryer operations and CLI commands.

Upstream Scryer MCP tool names are behavior references and parity-test anchors,
not Orca product command names, TypeScript function names, or internal operation
ids.

## Hard invariants

- Behavior, state transitions, input/output shape, and file effects must match
  current upstream Scryer 0.3 unless this map records an Orca adaptation.
- Command names use Orca-native noun/verb style, for example
  `orca scryer model read` and `orca scryer plan fold`.
- Internal callers use Orca-native operation ids, for example
  `scryer.model.read` and `scryer.plan.fold`.
- The committed model is `.scryer/model.scry`; the editable draft is
  `.scryer/planned.scry`; reads default to the plan layer; plan folds commit
  implemented work.
- Write operations must use one lock-protected read-modify-write transaction
  under `.scryer/.lock`.
- Source anchors have a single home. Committed anchors live in the committed
  model; plan-only anchors live in the plan and fold later.
- CLI commands that accept nested model updates must support stdin JSON
  (`--json-input -`) and structured JSON output.

## Where upstream behavior comes from

Scryer provides the source behavior, but not the Orca command shape. The source
of truth is distributed across:

- MCP tool handlers in `crates/scryer-mcp/src/tools/*.rs`
- request structs and generated schemas in `crates/scryer-mcp/src/types.rs`
- model storage/state semantics in `crates/scryer-core/src/lib.rs`
- tool tests next to each handler
- always-loaded agent instructions in `crates/scryer-mcp/src/instructions.rs`

For latest upstream Scryer 0.3.x, migrate the current upstream `main` behavior.

## Upstream state objects that Orca must adopt

Current upstream Scryer 0.3.x model shape:

- `version`
- `nodes`
- `links`, not pre-0.3 `edges`
- `groups`
- `sourceMap`
- `boundaries`

Current upstream `.scryer` engine state:

- `.scryer/model.scry`: committed model
- `.scryer/planned.scry`: editable draft, fallback to committed when absent
- `.scryer/model.baseline.scry`: committed-model baseline snapshot
- `.scryer/.sync`: drift reconcile anchor
- `.scryer/.lock`: model write lock
- `.scryer/history.jsonl`: committed-model event log
- `.scryer/.anchors.json`: anchor fingerprint baseline
- `.scryer/.build_edges.json`: build dependency graph cache for container fill

The Native Scryer Engine and Architecture tab use upstream 0.3 `ScryModel`
semantics directly. If existing pre-0.3 data must be preserved, handle it with
an explicit import command outside normal runtime behavior.

## Upstream-first model handling decisions

| Question | Decision |
| --- | --- |
| Pre-0.3 `.scryer/model.scry` on first open | Detect and refuse when `version` is missing or not `0.3`, with a clear incompatibility error. No silent auto-migration. |
| Backup before migration | No backup in normal runtime because normal runtime does not migrate. An explicit import command may create `model.pre-0.3-backup.scry`, but that is outside steady-state operation behavior. |
| Pre-0.3 `edges` to 0.3 `links` | No on-the-fly runtime mapping. `links` are the only engine data model. Any pre-0.3 edge conversion belongs to explicit import. |
| Pre-0.3 `flows` | Do not place in `ScryModel`; upstream 0.3 has no `flows`. If Orca keeps a flow editor, store it as an Orca extension outside Scryer engine semantics. |
| Pre-0.3 `status` / `contract` / `notes` | Do not reinterpret during normal reads. Current Scryer uses responsibilities, properties, directives, vagrant/stale flags, appearance state, and node notes directly. Explicit import can perform lossy/manual mapping if required. |
| Pre-0.3 `sourceMap` | Do not reinterpret pre-0.3 node/flow source maps during normal reads. Current source maps are responsibility anchors or schema-node anchors; boundaries are node-owned source globs with committed/planned single-home routing. |
| Architecture tab model | Persist `ScryModel` as architecture truth, and consume renderer-facing `ArchitectureViewDto` from the main-process view adapter. Do not introduce a persisted shadow model. |

## Operation parity map

| Area | Upstream MCP tool | Orca operation id | Orca CLI command | Upstream behavior to preserve |
| --- | --- | --- | --- | --- |
| Read | `read_model` | `scryer.model.read` | `orca scryer model read` | Reads plan by default; `layer:"committed"` reads committed and refreshes baseline; overview omits symbols; scoped subtree includes links/references/source data with large-subtree fallback. |
| Read | `search_model` | `scryer.model.search` | `orca scryer model search` | Fuzzy case-insensitive AND search over node names, descriptions, technology, responsibilities, and properties. |
| Read | `query_model` | `scryer.model.query` | `orca scryer model query` | Structural predicate query over node fields, optional subtree scope, plan layer default, capped hits. |
| Read | `get_rules` | `scryer.rules.read` | `orca scryer rules read` | Compact index with no topic; full matching rules by topic. |
| Read | `read_codebase` | `scryer.codebase.read` | `orca scryer codebase read` | Annotated project tree for modeling context. |
| Validation | `validate_model` | `scryer.model.validate` | `orca scryer model validate` | Validates 0.3 model structure, coverage, and whole-symbol anchor warnings. |
| Health | `get_health` | `scryer.model.health` | `orca scryer model health` | Deterministic report: coverage rollups, vagrant/stale flags, anchor observations, link audit. |
| Plan read | `get_pending` | `scryer.plan.pending` | `orca scryer plan pending` | Diffs committed model against planned draft; reports outstanding model-to-code work. |
| Full write | `set_model` | `scryer.model.set` | `orca scryer model set` | Generation primitive; validates version; writes plan and committed; saves baseline; warnings do not block write. |
| Node write | `update_nodes` | `scryer.node.update` | `orca scryer node update` | Patches existing nodes in planned layer only; whole-array replacement for responsibilities/properties; restores read-only directives. |
| Commit | `mark_implemented` | `scryer.plan.fold` | `orca scryer plan fold` | Folds planned node/responsibilities/deletions into committed model; updates baseline and history. |
| Structure write | `move_nodes` | `scryer.node.move` | `orca scryer node move` | Reparents subtrees in plan; validates hierarchy/external/cycles; removes moved node from groups; records move history. |
| Subtree write | `set_node` | `scryer.node.set-subtree` | `orca scryer node set-subtree` | Generation primitive; replaces descendants under one node in plan; accepts nodes and links; prunes code maps. |
| Node delete | `delete_nodes` | `scryer.node.delete` | `orca scryer node delete` | Plan-only deletion because modeled code should go away; pending until folded. |
| Model correction | `descope` | `scryer.node.descope` | `orca scryer node descope` | Model-only correction; code stays; relocates own responsibilities to parent; writes plan and committed together. |
| Responsibility write | `move_responsibilities` | `scryer.responsibility.move` | `orca scryer responsibility move` | Moves responsibility ids between nodes in plan; preserves anchors; blocks vagrant moves. |
| Links | `add_links` | `scryer.link.add` | `orca scryer link add` | Adds links to plan; validates endpoints, same-level/reference rule, self/ancestor constraints; rejects illegal batches. |
| Links | `update_links` | `scryer.link.update` | `orca scryer link update` | Patches link label/method in plan. |
| Links | `delete_links` | `scryer.link.delete` | `orca scryer link delete` | Deletes links from plan by id. |
| Source map | `update_source_map` | `scryer.source.update` | `orca scryer source update` | Updates responsibility anchors, schema node anchors, and node boundaries with committed/planned single-home routing. |
| Groups | `set_groups` | `scryer.group.set` | `orca scryer group set` | Generation primitive; bulk upserts raw 0.3 groups in plan; validates members. |
| Groups | `update_group` | `scryer.group.update` | `orca scryer group update` | Patches group name, description, members, responsibilities; validates membership. |
| Groups | `delete_group` | `scryer.group.delete` | `orca scryer group delete` | Deletes group from plan and detaches child groups. |
| Intent write | `add_person` | `scryer.person.add` | `orca scryer person add` | Adds top-level person nodes; mints node and responsibility ids; writes plan. |
| Intent write | `add_system` | `scryer.system.add` | `orca scryer system add` | Adds top-level system/external nodes; mints ids; writes plan. |
| Intent write | `add_container` | `scryer.container.add` | `orca scryer container add` | Adds containers under systems; optional boundary directory writes boundary glob. |
| Intent write | `add_component` | `scryer.component.add` | `orca scryer component add` | Adds components under containers; mints responsibility ids. |
| Intent write | `add_group` | `scryer.group.add` | `orca scryer group add` | Adds sibling groups by parent node and member ids; mints group/responsibility ids. |
| Intent write | `add_symbol` | `scryer.symbol.add` | `orca scryer symbol add` | Adds symbol under component; anchors responsibilities and data-shape schemas to source file/symbol; supports visual flag. |
| Drift read | `get_drift` | `scryer.drift.get` | `orca scryer drift get` | Reads committed model; seeds `.sync`/`.anchors.json` when absent; returns changed code scopes, not semantic verdicts. |
| Drift write | `flag_drift` | `scryer.drift.flag` | `orca scryer drift flag` | Records semantic drift into plan using vagrant/stale flags and history events. |
| Drift close | `reconcile_drift` | `scryer.drift.reconcile` | `orca scryer drift reconcile` | Advances `.sync` anchor and writes anchor fingerprint baseline after all drift scopes are reviewed. |
| Generation | `fill_container` | `scryer.container.fill` | `orca scryer container fill` | Atomic generation primitive for one empty container; mints ids; writes committed and planned; derives links from `.build_edges.json`; records born events. |

### Current implementation status

This parity map is the target behavior map, not a claim that every row is
executable today. Current code registers the 33-operation catalog contract, but
full executable parity is still split across decision map #31-#35. The current
Architecture product slice release gate was closed by #36 and is documented in
`docs/orca-scryer-architecture-slice-audit.md`.

Executable in the current Architecture product slice:

- `scryer.model.read`, `scryer.model.validate`
- `scryer.plan.pending`, `scryer.plan.fold`, `scryer.model.set`
- `scryer.node.update`, `scryer.node.delete`
- `scryer.link.add`, `scryer.link.update`, `scryer.link.delete`
- `scryer.source.update`
- `scryer.group.add`, `scryer.group.set`, `scryer.group.update`,
  `scryer.group.delete`
- `scryer.person.add`, `scryer.system.add`, `scryer.container.add`,
  `scryer.component.add`, `scryer.symbol.add`
- `scryer.drift.get`, `scryer.drift.reconcile`

Catalog-only operations still needing executors:

- #31 read surface: `scryer.model.search`, `scryer.model.query`,
  `scryer.rules.read`, `scryer.codebase.read`
- #32 structural mutation: `scryer.node.set-subtree`, `scryer.node.move`,
  `scryer.responsibility.move`, `scryer.node.descope`
- #33 health/drift record: `scryer.model.health`, `scryer.drift.flag`
- #34 generation: `scryer.container.fill`
- #35 adapter/coverage gate for every remaining exposed product path

## Engine implementation decision

The product implementation target is a native TypeScript/Node Scryer 0.3 engine
built on top of the current Orca migration code. It must not depend on a
packaged Rust Scryer sidecar in the normal runtime path.

The Rust upstream repository remains the semantic reference: when behavior is
unclear, inspect the original Rust handler, request type, storage code, and
tests. The implementation should be reimplemented in Orca-owned TypeScript/Node
modules from those semantics so the architecture tab, IPC, CLI, file watcher,
agent runtime, packaging, and tests share one native Orca substrate without
copying upstream implementation source into the product runtime.

The engine's canonical model is upstream Scryer 0.3 `ScryModel`.
Architecture tab and Orca-native Scryer operations operate on `ScryModel`
semantics directly.

## Native engine module split

ADR 0013 accepts a deep Native Scryer Engine with one external interface and
multiple internal files. ADR 0015 accepts the Operation Catalog. ADR 0016 sets
Orca-native operation and command names. ADR 0017 makes each catalog entry a
typed operation contract. ADR 0018 chooses the first operation contracts as a
minimal semantic loop. ADR 0019 requires the first seven contracts to be driven
from one contract matrix. ADR 0020 keeps upstream Scryer field semantics inside
engine contracts. ADR 0021 makes every operation return the same result/error
envelope. ADR 0022 defines explicit Orca operation context and authority rules.
ADR 0023 makes every operation run through one contract-driven execution
pipeline.

```ts
interface ScryerEngine {
  executeOperation(
    id: ScryerOperationId,
    input: unknown,
    context: ScryerOperationContext,
  ): Promise<ScryerOperationResult>

  readView(
    project: ScryerProjectRef,
    options: ScryerViewOptions,
  ): Promise<ArchitectureViewModel>
}
```

This external interface is intentionally small. Product callers and tests should
cross the Native Scryer Engine seam through `executeOperation(...)` or
`readView(...)`. Model Edit Lease acquisition, completion gate execution, locks,
history, layer routing, and auxiliary file writes are implementation behavior
behind the engine seam, not extra product-caller methods.

`ScryerOperationContext` is Orca runtime context, not Scryer model data. It
borrows upstream Scryer's project and layer semantics but makes caller authority
explicit for Orca:

```ts
type ScryerOperationContext = {
  requestId: string
  transport: "cli" | "ipc" | "ui" | "agent" | "test" | "system"
  caller: "human" | "agent" | "system" | "test"
  cwd: string
  projectRoot?: string
  workspaceRoot?: string
  sessionId?: string
  agentRunId?: string
  leaseToken?: string
  output?: {
    json?: boolean
    verbose?: boolean
  }
}
```

Context conventions:

- Resolve the effective project from `input.project`, then
  `context.projectRoot`, then `context.cwd`.
- If `context.workspaceRoot` is present, the effective project must stay inside
  it.
- Preserve upstream request fields such as `project`, `layer`, `node_id`, and
  `src`/`dst` in operation input schemas.
- `requestId` is generated by the transport or dispatcher and echoed in the
  shared result envelope.
- Reads never require a lease.
- Writes acquire the model file lock inside the engine.
- Draft edits require a matching `leaseToken` only while an agent run owns the
  Model Edit Lease.
- `plan.fold` requires either no active lease, or the matching lease/completion
  gate when an agent owns the edit session.
- `leaseToken` is trusted runtime context. It may be set by main-process
  edit-session code or another trusted adapter, but renderer/preload DTOs,
  ordinary CLI flags, DOM state, logs, prompts, and renderer
  `executeOperation(...)` input must not expose or accept it.

## Deep module interfaces

The Native Scryer Engine is a deep module. Its interface should give callers a
small surface with high leverage while hiding the state rules that currently risk
spreading across CLI, IPC, UI, sync, drift, and tests.

| Module | Interface seam | What the implementation hides | Dependency category and test strategy |
| --- | --- | --- | --- |
| Native Scryer Engine | `executeOperation(...)`, `readView(...)` | Operation catalog lookup, operation pipeline, state store, validation, locks, leases, history, anchors, result envelopes, and view selection | In-process plus local-substitutable filesystem; test through engine with temp project directories |
| Scryer Operation Pipeline | Internal engine seam driven by `ScryerOperationContract` | Context validation, input validation, project resolution, authority, lock/lease checks, declared reads/writes, side effects, and envelope validation | In-process; tested through engine contract tests, not through transport tests |
| Scryer State Store | Internal store seam used only by the pipeline | `.scryer` path calculation, planned fallback, committed writes, atomic IO, baseline/history/anchor/build-edge file effects, and lock ownership | Local-substitutable filesystem; test with temp directories and real files |
| Scryer Validator | Internal validation seam used by pipeline stages | Parse/version incompatibility, blocking structural errors, non-blocking warnings, anchor warnings, and post-fold committed validation | In-process; pure tests for taxonomy plus engine tests for observable behavior |
| `ScryerEditSessionController` | Orca application-service seam for model-edit sessions | Model Edit Lease lifecycle, completion gate, cancellation/crash cleanup, and visible handoff mapping; Orca still owns agent process launch and terminal/runtime state | In-process workflow over Orca runtime; production uses an Orca runtime adapter, tests use an in-memory runtime adapter |
| Architecture View Adapter | Renderer-facing view seam through `readView(...)` and operation intents | `ScryModel` to canvas view derivation, render cache separation, UI mutation-to-operation mapping, and structured error rendering | In-process; renderer tests verify mapping and rendering, while engine tests own Scryer semantics |

The deletion test for these modules is strict: deleting the Native Scryer Engine
would force planned/committed semantics, lock/lease policy, validation, history,
anchors, and error envelopes back into many callers. Deleting transport adapters
should not remove Scryer semantics; it should only remove one way to call them.

### Internal store interface

The state store is an internal seam, not a product interface. It exists so the
operation pipeline can express declared state effects without exposing `.scryer`
file mechanics to operation implementations or transports.

```ts
interface ScryerStateStore {
  loadState(
    project: ResolvedScryerProject,
    transaction: ScryerOperationTransaction,
  ): Promise<ScryerLoadedState>

  commitState(
    project: ResolvedScryerProject,
    transaction: ScryerOperationTransaction,
    changes: ScryerStateChanges,
  ): Promise<ScryerStateCommitResult>
}
```

`ScryerStateStore` owns path layout, atomic writes, planned fallback, lock
coordination, and auxiliary files. Operation implementations must not write
`.scryer/*` directly or infer whether a field belongs in planned or committed
state.

### Validation taxonomy

Validation is another internal seam. Operation implementations ask for declared
validation; they do not decide how a warning differs from a blocking error.

| Validation result | Meaning | Typical result envelope |
| --- | --- | --- |
| Incompatible model | File cannot enter the 0.3 runtime path | `ok: false`, `incompatible_model` |
| Invalid input | Caller input does not match the operation contract | `ok: false`, `invalid_input` with `fieldErrors` |
| Blocking structural error | Operation would create an illegal model state | `ok: false`, `validation_failed` |
| Non-blocking warning | Model is valid enough to write but needs attention | `ok: true` with `warnings` |
| Post-fold committed failure | Fold would make committed state invalid | `ok: false`, `validation_failed`, no partial write |

### Agent edit session interface

`ScryerEditSessionController` owns the Model Edit Lease lifecycle and completion
gate. UI, CLI, and IPC callers do not acquire leases directly; they pass
context, and the engine enforces authority.

Renderer-facing edit-session calls return token-free identity/status only:
active, owner, agent run id, and timestamps where useful. Agent completion and
optional fold use `completeAgentEditSession(...)`, where the controller resolves
the matching token internally before calling the Native Scryer Engine.

```ts
interface ScryerEditSessionController {
  beginAgentEditSession(
    project: ScryerProjectRef,
    owner: ScryerLeaseOwner,
    context: ScryerOperationContext,
  ): Promise<ModelEditSession>

  completeAgentEditSession(
    session: ModelEditSessionRef,
    outcome: ScryerAgentRunOutcome,
  ): Promise<ScryerCompletionGateResult>

  cancelAgentEditSession(
    session: ModelEditSessionRef,
    reason: string,
  ): Promise<ScryerOperationResult>
}
```

The controller keeps Orca terminal/runtime state out of the Native Scryer Engine
operation interface. Completion is product state: a finished process still needs
pending-work and validation checks before the model edit session is considered
closed.

Each operation catalog entry is the typed contract for one semantic operation.
It declares operation id, input schema, success payload schema, allowed error
codes/detail schemas, capability class, transaction reads/writes, lock/lease
requirement, side effects, upstream parity anchors, transport metadata, and
execute implementation.

Transport metadata is adapter metadata: command names, argument aliases, stdin
JSON support, and renderer action names. It cannot define planned/committed
behavior, state effects, validation rules, or error semantics.

```ts
type ScryerOperationContract = {
  id: ScryerOperationId
  inputSchema: ZodSchema
  successSchema: ZodSchema
  errorCodes: ScryerOperationErrorCode[]
  errorDetailSchemas: Partial<Record<ScryerOperationErrorCode, ZodSchema>>
  capability: ScryerOperationCapability
  transaction: ScryerOperationTransaction
  sideEffects: ScryerOperationSideEffects
  upstreamParity: ScryerOperationParity
  transports: ScryerOperationTransports
  execute(
    input: unknown,
    context: ScryerOperationContext,
  ): Promise<ScryerOperationResult>
}
```

## Operation result envelope

All operations return the same envelope. The contract's `successSchema`
validates only the `result` payload, not the whole envelope. `errorCodes` and
`errorDetailSchemas` define the allowed structured errors for `ok: false`.

```ts
type ScryerOperationResult<T = unknown> =
  | {
      ok: true
      operationId: ScryerOperationId
      requestId: string
      result: T
      meta?: ScryerOperationMeta
    }
  | {
      ok: false
      operationId: ScryerOperationId
      requestId: string
      error: ScryerOperationError
      meta?: ScryerOperationMeta
    }

type ScryerOperationError = {
  code: ScryerOperationErrorCode
  message: string
  details?: Record<string, unknown>
  fieldErrors?: Array<{ path: string; message: string }>
  retryable: boolean
}
```

Envelope rules:

- `engine.executeOperation(...)` returns the envelope for success and expected
  runtime failures; transport callers do not receive raw payloads.
- CLI `--json` prints the envelope unchanged; non-JSON CLI output may render a
  concise human message but exits non-zero when `ok: false`.
- IPC forwards the envelope unchanged.
- UI renders by `error.code`, `details`, and `fieldErrors`; it does not parse
  `message` for behavior.
- Upstream MCP `CallToolResult` text is a semantic reference, not the Orca result
  shape. Native operations convert upstream behavior into typed payloads and
  structured errors.

## First contract matrix

This matrix is the source for the first operation-contract tests, CLI mapping,
IPC mapping, UI actions, and implementation order.

| Operation id | CLI command | Input schema | Success payload schema | Error codes | Reads | Writes | Lock | Lease | Validation | Side effects | Upstream anchors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `scryer.model.read` | `orca scryer model read` | `{ project?: string; node?: string; layer?: "plan" \| "committed" }` | `{ layer; model?; overview?; subtree?; referencesForChildren?; sourceMap?; boundaries?; truncated?: boolean }` | `incompatible_model`, `invalid_input`, `not_found`, `io_error` | `planned` by default; `committed` when requested | none | no | no | parse/version only | refresh baseline when reading `committed` | `read_model`; `ReadModelRequest`; `read_model_*` tests |
| `scryer.model.validate` | `orca scryer model validate` | `{ project?: string; layer?: "plan" \| "committed" }` | `{ layer; warnings: ValidationWarning[] }` | `incompatible_model`, `invalid_input`, `io_error`, `validation_failed` | `planned` by default; `committed` when requested | none | no | no | structural + coverage + anchor warnings | none | `validate_model`; `ValidateModelRequest`; validate tests |
| `scryer.node.update` | `orca scryer node update` | `{ project?: string; nodes: UpdateNodeItem[] }` | `{ updated: number; warnings: ValidationWarning[]; pendingSummary }` | `incompatible_model`, `invalid_input`, `not_found`, `lock_busy`, `lease_required`, `validation_failed`, `io_error` | `planned` | `planned` | yes | write lease required when an agent run owns editing | run after write; warnings do not block valid writes | none | `update_nodes`; `UpdateNodeRequest`; node write tests |
| `scryer.link.add` | `orca scryer link add` | `{ project?: string; links: AddLinkItem[] }` where each item uses `src`, `dst`, `label`, `method?` | `{ added: string[]; warnings: ValidationWarning[]; pendingSummary }` | `incompatible_model`, `invalid_input`, `not_found`, `illegal_link`, `lock_busy`, `lease_required`, `validation_failed`, `io_error` | `planned` | `planned` | yes | write lease required when an agent run owns editing | endpoint + same-level/reference rule before write; structural warnings after write | none | `add_links`; `AddLinkRequest`; link validation tests |
| `scryer.link.delete` | `orca scryer link delete` | `{ project?: string; link_ids: string[] }` | `{ deleted: number; missing: string[]; pendingSummary }` | `incompatible_model`, `invalid_input`, `lock_busy`, `lease_required`, `io_error` | `planned` | `planned` | yes | write lease required when an agent run owns editing | optional structural validation after write | none | `delete_links`; `DeleteLinkRequest`; link delete tests |
| `scryer.plan.pending` | `orca scryer plan pending` | `{ project?: string }` | `{ changes: PendingChange[]; summary }` | `incompatible_model`, `invalid_input`, `io_error` | `committed` + `planned` | none | no | no | none | none | `get_pending`; `GetPendingRequest`; `get_pending_reports_the_plan_diff` |
| `scryer.plan.fold` | `orca scryer plan fold` | `{ project?: string; node_id: string; responsibility_ids?: string[]; property_labels?: string[]; link_ids?: string[]; all?: boolean }` | `{ folded: FoldedItem[]; remaining: PendingChange[]; warnings: ValidationWarning[] }` | `incompatible_model`, `invalid_input`, `not_found`, `lock_busy`, `lease_required`, `validation_failed`, `io_error` | `committed` + `planned` | `committed`, `planned`, `history`, `baseline` | yes | lease token or completion gate required for agent-owned folds | validate committed result after fold | append history event; refresh baseline; clear folded planned diff | `mark_implemented`; `MarkImplementedRequest`; fold/commit tests |

Matrix conventions:

- `planned` means `.scryer/planned.scry`, falling back to committed when absent.
- `committed` means `.scryer/model.scry`.
- The success payload schema is the `result` field inside `ok: true`, not a
  transport-specific response body.
- Error codes are allowed operation-level `error.code` values inside `ok: false`;
  engine dispatch can also return `invalid_context`, `operation_not_found`, and
  `internal_error`.
- Write operations run in one lock-protected read-modify-write transaction.
- Transport callers only map arguments and render results.
- `ValidationWarning` is structured data, not transport text.
- Engine contracts keep upstream Scryer 0.3 field names. CLI adapters may accept
  aliases such as `--source`/`--target`, but must normalize to `src`/`dst`
  before calling `engine.executeOperation(...)`.

Target shape:

```text
src/main/scryer/engine/
  index.ts              # external interface: executeOperation/readView/lease/gate
  operations.ts         # Orca-native operation catalog
  pipeline.ts           # contract-driven execution pipeline
  paths.ts              # .scryer/model.scry/planned.scry/.lock/history/anchors/build_edges
  store.ts              # parse/serialize/atomic file IO
  lock.ts               # withModelLock(...)
  leases.ts             # Model Edit Lease checks
  layers.ts             # committed/planned read and write rules
  completion-gate.ts    # pending/validation checks after agent runs
  history.ts            # history.jsonl append/read helpers
  anchors.ts            # .anchors.json and source-anchor routing
  build-edges.ts        # .build_edges.json cache for container fill
  validators.ts         # Scryer 0.3 validation
  drift.ts              # drift/reconcile/health internals
  view-selectors.ts     # pure ScryModel -> render helpers
  extension-state.ts    # Orca-owned flow/layout extension access
  operations/
    model-read.ts
    node-update.ts
    plan-fold.ts
    link-add.ts
    container-fill.ts
    ...
  import/
    pre-0.3-c4.ts       # optional one-off import, not normal runtime
```

Rules:

- CLI handlers call `engine.executeOperation(...)`; they do not own Scryer state
  semantics.
- IPC handlers and UI controllers call operations or `readView(...)`; they do
  not write `.scryer/*` directly.
- Product callers do not acquire leases, run completion gates, or call the state
  store directly. Those are internal engine or agent-run-bridge seams.
- CLI, IPC, UI, and agent runtime are transport callers over the same operation
  contracts; they cannot add planned/committed, lock/lease, history, anchor, or
  result/error envelope policy.
- `mcp-tools.ts` is not a semantic owner; use it only as refactor scaffolding
  during module split.
- `C4ModelData` conversion must not exist on the normal read/write path.
- Tests target the engine interface first. CLI and IPC tests verify transport,
  not duplicate Scryer semantics.

## Operation execution pipeline

Every call to `engine.executeOperation(id, input, context)` follows the same
dispatcher sequence:

1. Load the operation contract.
2. Validate `ScryerOperationContext`.
3. Validate input with the contract schema.
4. Resolve the effective project.
5. Check operation authority and active Model Edit Lease.
6. Acquire `.scryer/.lock` when the contract requires it.
7. Read the layers and auxiliary files declared by the contract.
8. Run the operation-specific Scryer semantics.
9. Run declared validation.
10. Apply declared writes and side effects.
11. Validate the success payload.
12. Return the shared result envelope.

Stage execution is conditional on the contract:

| Operation class | Active pipeline stages |
| --- | --- |
| Read | context/input/project/layer read/result envelope; no lock or lease. |
| Draft edit | context/input/project/lease/lock/planned read/mutate/validate/write planned/result envelope. |
| Pending diff | context/input/project/read committed+planned/diff/result envelope. |
| Fold | context/input/project/lease or completion gate/lock/read planned+committed/fold/write committed+planned/baseline/history/result envelope. |
| Code extraction/build | context/input/project/system or agent authority/build edges/extract/validate or repair/write committed+planned/baseline/sync/anchors/result envelope. |
| Drift | observation reads declared files; verdicts use authority/lock and declared planned/history/sync/anchor writes. |

Operation implementation files only implement domain semantics. They receive a
validated input, resolved project, loaded state, and transaction helpers from
the pipeline. They cannot resolve projects, acquire locks, inspect the lease
registry, run completion gates, write `.scryer/*` directly, or add side effects
outside the contract.

## Migration path

1. Convert the existing Orca Scryer store into the 0.3 native engine.
   - Add committed/planned/baseline/sync/history/anchors/build-edges paths.
   - Add write lock and atomic write helpers.
   - Reject missing or non-`0.3` `version` exactly like upstream Scryer.
   - Establish `engine.executeOperation(...)` as the only Scryer state interface
     for product callers.
   - Define `ScryerOperationContract` and make operation-contract tests the
     primary behavior tests.
   - Add the shared operation execution pipeline before adding broad operation
     coverage.

2. Land the first operation-contract slice as a minimal semantic loop.
   - `scryer.model.read`
   - `scryer.model.validate`
   - `scryer.node.update`
   - `scryer.link.add`
   - `scryer.link.delete`
   - `scryer.plan.pending`
   - `scryer.plan.fold`
   - Prove `ScryModel` 0.3 read/write, planned/committed layers, draft edit,
     pending diff, fold commit, validation, lock/lease, result/error envelope,
     and transport forwarding through contract tests.
   - Prove every operation returns the shared `ScryerOperationResult<T>`
     envelope, with operation-specific success payload validation and structured
     error detail validation.
   - Encode the first slice as the first contract matrix before writing operation
     implementations.

3. Add the Orca-native CLI shell.
   - Register `src/cli/specs/scryer.ts`.
   - Register `src/cli/handlers/scryer.ts`.
   - Map commands such as `orca scryer model read` and
     `orca scryer plan fold` to operation ids.
   - Return machine-readable JSON for `--json`; accept stdin JSON for complex
     writes.

4. Rework the Architecture tab to read and write `ScryModel`.
   - Replace persisted `C4ModelData` state with upstream 0.3 fields.
   - Keep render helper data derived and outside `ScryModel`.
   - Route product write actions through `engine.executeOperation(...)`; use
     `engine.readView(...)` for render data.

5. Implement remaining read/query operations.
   - `scryer.model.search`, `scryer.model.query`, `scryer.rules.read`,
     `scryer.codebase.read`.

6. Implement remaining core write operations.
   - `scryer.model.set`, `scryer.node.set-subtree`, `scryer.node.delete`,
     `scryer.node.move`.

7. Implement links, groups, and source ownership.
   - `scryer.link.update`.
   - `scryer.group.set/update/delete`.
   - `scryer.source.update`.

8. Implement intent writers.
   - `scryer.person.add`, `scryer.system.add`, `scryer.container.add`,
     `scryer.component.add`, `scryer.group.add`, `scryer.symbol.add`.

9. Implement planning close and drift.
   - `scryer.drift.get`, `scryer.drift.flag`, `scryer.drift.reconcile`,
     `scryer.model.health`.
   - Add completion gate checks after Orca agent runs.

10. Implement atomic generation.
   - `scryer.container.fill`.
   - Port `.build_edges.json` behavior or define the Orca extractor that writes
     equivalent data.

11. Decide explicit pre-0.3 import, if product still needs it.
   - Normal open/read of pre-0.3 `.scryer/model.scry` reports incompatibility.
   - Optional `orca scryer import pre-0.3-model` may read a pre-0.3 file, write a
     backup, map best-effort fields into a new `ScryModel`, and report losses.

12. Update prompts and agent guidance.
   - New build/fill/drift prompts should use Orca-native commands.
   - Existing prompts should be updated from pre-0.3 model/edge/flow language to
     read/link/sourceMap/boundary language.

13. Document Orca-native agent invocation.
   - Document Codex/Claude Code invocation as Orca-native CLI calls.
   - Keep Scryer-specific agent setup out of the target runtime contract.

14. Verification gate.
   - For each upstream behavior, build native TypeScript temp-project tests from
     the original Rust handler tests and descriptions.
   - Assert request JSON, shared result envelope shape, state files touched,
     lock behavior, and error categories.
   - Add end-to-end tests where Orca background Codex/Claude runs call
     Orca-native Scryer CLI commands and the Architecture tab reloads correctly.
