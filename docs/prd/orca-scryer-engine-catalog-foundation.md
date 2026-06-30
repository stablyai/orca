# PRD: Orca Scryer Engine Catalog Foundation

Status: implemented via operation migration; retained as historical specification
Date: 2026-06-24

## Source

- Decision map ticket: `docs/orca-scryer-decision-map.md` #15
- Operation parity map: `docs/scryer-cli-tool-parity.md`
- First slice PRD: `docs/prd/orca-scryer-native-engine-first-slice.md`
- Upstream behavior anchors:
  - `scryer/crates/scryer-mcp/src/tools/read.rs`
  - `scryer/crates/scryer-mcp/src/tools/nodes.rs`
  - `scryer/crates/scryer-mcp/src/tools/links.rs`
  - `scryer/crates/scryer-mcp/src/tools/misc.rs`
  - `scryer/crates/scryer-mcp/src/tools/intent.rs`
  - `scryer/crates/scryer-mcp/src/tools/generation.rs`
  - `scryer/crates/scryer-mcp/src/types.rs`
  - `scryer/crates/scryer-core/src/lib.rs`
  - `scryer/crates/scryer-core/src/diff.rs`
  - `scryer/crates/scryer-core/src/validate.rs`
  - `scryer/crates/scryer-core/src/drift.rs`
  - `scryer/crates/scryer-core/src/health.rs`
  - `scryer/crates/scryer-core/src/build_edges.rs`
  - `scryer/crates/scryer-core/src/history.rs`

## Problem Statement

Implementation status: this foundation has since landed as part of the completed
#41-#49 operation migration. The catalog, pipeline, state-store, schemas, error
mapping, parity fixtures, and read/write operation families now sit behind the
Native Scryer Engine seam. This PRD remains useful as historical specification,
not as a fresh backlog of unchecked operation work.

At the time this PRD was written, PRD #22 had proved the first Native Scryer
Engine loop with seven operations, while the engine still had first-slice
scaffolding. The purpose of this PRD was to prevent later operations from
pushing planned/committed semantics, lock/lease behavior, anchor routing,
history, baseline refresh, drift sync, build-edge reads, and result-envelope
validation back into individual operation implementations.

## Decision

Add a runtime-enforced `ScryerOperationCatalog` as the only registration and
contract source for Native Scryer Engine operations.

Upstream Scryer does not provide a unified operation catalog for risk or
authorization. Upstream relies on MCP tool descriptions, manual handler-level
write locks, agent launch gates, semantic `history.jsonl` events, and caller
discipline. Orca adds catalog-enforced risk and authorization because Orca has
multiple product entry points (`cli`, `ipc`, `ui`, `agent`, `system`) that must
share one runtime policy. These fields are Orca product hardening, not upstream
model fields.

Each operation contract declares:

- operation id
- semantic capability
- `zod` input schema
- `zod` success payload schema
- allowed error codes and `zod` detail schemas
- transaction policy
- lock and lease policy
- validation policy
- side effects
- upstream parity anchors
- transport metadata

The operation pipeline executes only catalog-registered operations. Transport
adapters, operation files, and UI handlers must not bypass the catalog or write
`.scryer/*` directly.

Product UX principle: give callers broad authority to modify the Scryer model
through catalog-registered engine operations, while keeping interaction
low-friction. Runtime policy is a guardrail, not a prompt generator. Routine
modeling, planned authoring, and ordinary fold flows should not be slowed by
repeated dialogs. High-risk work is controlled primarily through explicit
operation policy, exclusive locks, model edit leases, semantic history where
upstream declares it, and completion gates, not through human-in-the-loop
prompts.

Valid Scryer contexts may invoke high-risk Scryer write operations when the
operation's explicit policy allows that transport and project scope, including
`scryer.model.set`, `scryer.container.fill`, `scryer.node.descope`, and
`scryer.drift.reconcile`. Do not block progress with approval dialogs. The
required controls are runtime controls: high-risk writes must satisfy workspace
containment, exclusive lock, active lease or completion-gate requirements, and
model validation as declared by policy. The caller remains responsible for any
broader save workflow.

Transport policy is an adapter-contract check, not a user identity model. It
declares which Orca entry points may call an operation directly so UI, CLI, IPC,
agent bridge, and system workflows do not bypass the seam that owns their
required context. The catalog does not maintain a separate human/agent/system
principal allow-list.

`test` remains a transport kind for engine harnesses and test-only catalogs.
Production operation contracts should not include `test` by default. Tests that
exercise production operations should normally use one of the production
transports declared by that operation; tests that need a synthetic entry point
may register test-only operations in a test catalog.

## Upstream Alignment Rules

The operation migration inventory is anchored to upstream Scryer MCP tools, not
to Orca's policy or adapter additions. The current upstream public operation
surface is:

```text
read_model, search_model, query_model, get_drift, get_pending, get_rules,
read_codebase, validate_model, get_health,
set_model, update_nodes, mark_implemented, move_nodes, set_node, delete_nodes,
descope, move_responsibilities,
update_source_map, set_groups, update_group, delete_group,
add_links, update_links, delete_links,
add_person, add_system, add_container, add_component, add_group, add_symbol,
flag_drift, reconcile_drift,
fill_container
```

The migration matrix in this PRD must account for each of those upstream tools.
If Orca adds an operation that has no upstream tool equivalent, mark it
explicitly as Orca-only instead of blending it into upstream parity. If Orca
chooses not to migrate an upstream tool, record the exclusion and reason.

Orca operation ids and CLI commands may use Orca-native naming, but the
semantic fields and behavior stay aligned with upstream: examples include
`src`, `dst`, `node_id`, `responsibility_ids`, `link_ids`, `sourceMap`, and
`boundaries`.

The catalog, result envelope, `zod` schemas, transport allow-lists, lock/lease
policy, completion-gate policy, agent-run adapter context, and validation
semantic paths are Orca-native contract hardening. They wrap upstream behavior;
they do not define new upstream model semantics by themselves.

Upstream `validate_model` returns human-readable warnings. Orca enriches
validation output as `ScryerValidationFinding` for structured consumers, but
the parity default is to map upstream validator warnings to
`severity: 'warning'`. Use `severity: 'error'` for engine-level parse/schema
failures, incompatible models, and operation-specific structural blockers that
upstream write tools already reject, such as illegal link writes. Any additional
hard-error classification needs an explicit parity note and focused tests.

Input schemas preserve upstream semantic field names where the PRD already
requires them, including `node_id`, `responsibility_ids`, `link_ids`, `src`,
`dst`, `sourceMap`, and `boundaries`. Engine success payloads use Orca-native
camelCase machine-readable fields. Do not make human-readable `message` the
primary success contract; adapters can render messages from structured payloads.
Common result field names are `addedIds`, `addedItems`, `updatedCount`,
`deletedCount`, `writtenCount`, `movedCount`, `removedCount`, `missingIds`, `findings`,
`pendingSummary`, `folded`, and `remaining`.
`projectRoot` belongs in envelope `meta`, not in operation `result`.

Engine input schemas may be more type-friendly than upstream MCP JSON while
preserving upstream semantics. For example, upstream generation primitives that
accept `data: string` may accept parsed objects at the engine seam, while CLI
adapters can still accept JSON strings. This must not change operation meaning:
`delete_nodes` remains planned code-removal intent, `descope` remains model-only
correction with code untouched, `get_drift` reports changed scopes rather than
semantic verdicts, and `flag_drift` records semantic drift verdicts.

Do not preserve upstream MCP `Content::text(...)` success messages as engine
result contracts. Engine results are structured and machine-readable. CLI, IPC,
or future compatibility adapters may render human text from those results, but
operation tests should assert structured fields rather than full English
sentences.
`ScryerOperationError.message` and `ScryerValidationFinding.message` remain as
short human-facing copy for logs and adapters. Machine behavior must depend on
`code`, `details`, `fieldErrors`, `path`, and `jsonPointer`, not on parsing
message text.

## Upstream Implementation Lessons For Orca

The upstream implementation does not expose a unified runtime catalog. Its MCP
handlers call core state, diff, validation, drift, health, ownership, and build
edge helpers directly. Orca should not copy that structure because Orca has more
product entry points, but the following upstream seams are behavior anchors for
the Native Scryer Engine foundation.

| Upstream seam | Upstream anchor | Orca rule to borrow |
| --- | --- | --- |
| Project-local model reference | `scryer-core/src/lib.rs::ModelRef` | `state-store` owns project path resolution and all `.scryer/*` paths. Operation executors never construct model file paths. |
| Tool result/error split | MCP handlers return `Result<CallToolResult, McpError>` and use `CallToolResult::error(...)` for domain failures | Expected operation failures stay inside the operation result envelope. Unexpected exceptions are mapped by the pipeline/error-mapper to `internal_error`. |
| Exclusive write lock | `scryer-core/src/lib.rs::lock_model` and MCP `lock_or_err` | The state-store lock covers the whole read-modify-write cycle for write operations, not just the final file write. |
| Planned fallback | `read_planned_at`, `ensure_planned_at` | Absence of `planned.scry` means planned equals committed. When a planned file is seeded, committed `sourceMap` and `boundaries` are not copied into planned. |
| Version rejection | `check_version`, `is_legacy_model` | Normal engine reads reject missing, invalid, or non-0.3 model files with structured `incompatible_model`. |
| Element diff | `diff.rs::diff` | One shared diff module owns node, link, responsibility, property, and group changes. Properties are identified by `(owner node id, label)`. |
| Fold behavior | `lib.rs::commit_element`, `nodes.rs::mark_implemented` | One fold module handles add, update, move, reword, and deletion by applying selected planned elements into committed state. |
| Single-home anchors | `update_source_map`, `commit_element`, `effectiveSourceMap` | `sourceMap` and `boundaries` are routed by target element ownership. Committed elements keep anchors in committed state; planned-only elements keep anchors in planned state until folded. |
| Link legality | `validate.rs::link_violation` | Link validation uses the same-level and reference-propagation rule. `link.add` rejects the whole batch if any requested link is illegal. |
| Boundary ownership | `ownership.rs::BoundaryOwnership` | Most-specific boundary glob wins when multiple nodes match a file. Drift, health, and build-edge fallback must use the same ownership rule. |
| Drift scoping | `drift.rs::drifted_scopes` | Drift detection reports changed boundary scopes only. Semantic verdicts are written separately by `drift.flag`. |
| Health reporting | `health.rs::compute_health` | Health is derived observability, not model intent. It may maintain sync or anchor state only when declared as maintenance policy. |
| Build-edge graph | `build_edges.rs` and `generation.rs::fill_container` | Cached build edges are evidence used to derive links during generation. They are not a second model link store. |
| ID minting | `intent.rs::RespMinter`, `generation.rs::IdMinter` | ID minting scans committed state, planned state, and current batch reservations. Link ids remain endpoint-deterministic where upstream uses `link-${src}-${dst}`. |
| Read view compaction | `read.rs::overview_payload`, `subtree_payload`, `DETAIL_LIMIT` | Engine read views should return agent-usable overview/subtree shapes instead of dumping the entire model by default. |
| History and baseline | `history.rs`, `save_baseline_at`, `record_event` | History and baseline are maintenance writes. Best-effort failures do not fail the semantic operation. |
| Read-only directives | `helpers.rs::enforce_readonly_directives` | Agent-facing writes must preserve user-authored directive fields when those fields are not part of the operation input contract. |

Do not borrow upstream MCP `active_model` ambient session state into the Native
Scryer Engine. Orca project resolution is explicit through
`ScryerOperationContext`, operation input, and catalog authorization policy.
Transport adapters may keep their own convenience state, but the engine must
not depend on it.

## Engine Foundation Interface Contract

This contract turns the upstream lessons above into Orca module seams. It is
the implementation boundary for decision map #15.

### Module Public Interfaces

| Module | Public interface | Owns | Must not own |
| --- | --- | --- | --- |
| `index.ts` | `createScryerEngine(...)`, `executeOperation(...)`, `readView(...)` | The product-facing Native Scryer Engine seam. | Operation policy, direct file IO, legacy mapping logic. |
| `catalog.ts` | `registerOperation(...)`, `getOperationContract(...)`, `listOperationContracts(...)`, `validateCatalog(...)` | Operation registration, schema names, policy, capability, risk, errors, upstream anchors. | Runtime project resolution, locks, file writes, operation behavior. |
| `pipeline.ts` | `executeCatalogOperation(operationId, rawInput, context)` | Input normalization, schema validation, authorization, lock/lease checks, executor invocation, result validation, commit authorization, error envelope mapping. | Operation-specific domain mutation code. |
| `error-mapper.ts` | `mapExecutorFailure(...)`, `mapPipelineFailure(...)`, `mapStateStoreFailure(...)`, `mapUnexpectedException(...)`, `toOperationResult(...)` | Conversion from structured failures or unexpected exceptions into `ScryerOperationError` and the shared result envelope. | Domain validation, state mutation, transport formatting. |
| `state-store.ts` | `resolveProject(...)`, `load(project, policy)`, `commit(plan)` | `.scryer/*` paths, planned fallback, compatible model checks, exclusive lock, primary commits, best-effort maintenance warnings. | Operation-specific mutations, transport formatting, schema aliases. |
| `operations/*` | `execute(input, loaded, services)` | Domain mutation for one operation using canonical input and loaded model state. | Path resolution, lock handling, file IO, result envelope creation, transport output, direct legacy C4 handling. |
| `validators.ts` | `validateModel(...)`, `validateWriteGuards(...)`, `linkViolation(...)` | Structural findings, blocking-vs-warning validators, link legality, semantic paths. | Transport messages, file writes, policy decisions. |
| `diff.ts` / `fold.ts` | `diffModels(...)`, `foldTargets(...)` | Element identity, pending changes, fold application, sourceMap/boundary cleanup, stale/vagrant marker resolution. | Operation dispatch, locks, project paths. |
| `id-minter.ts` | `createScryerIdMinter(universe)` | Node, responsibility, group, and link id allocation from committed, planned, and batch reservations. | Operation-specific validation, file reads. |
| `source-router.ts` | `routeSourceEntry(...)`, `routeBoundaryEntry(...)`, `clearSourceTarget(...)`, `applySourceRoutes(...)` | Single-home routing for `sourceMap` and `boundaries` across committed and planned layers. | State-store commits, path resolution, transport formatting. |
| `adapters/*` | `toOperationInput(...)`, `fromOperationResult(...)` | CLI/IPC/UI/legacy field mapping and presentation formatting. | Scryer state semantics, direct `.scryer/*` writes, validation policy. |

Operation executors use the single `ScryerOperationExecutor<TInput, TResult>`
shape defined in [Contract Shape](#contract-shape). They receive a loaded-state
snapshot and a narrow service object, not the state store:

```ts
type ScryerOperationServices = {
  ids: ScryerIdMinter
  validators: ScryerValidatorSet
  diff: ScryerDiffService
  fold: ScryerFoldService
  sourceRouter: ScryerSourceRouter
  clock: ScryerClock
}
```

The executor returns the semantic result plus requested state changes. The
pipeline validates those state changes against the catalog policy before asking
`state-store` to commit them.

`ScryerSourceRouter` interface:

```ts
type ScryerSourceRouter = {
  routeSourceEntry(args: {
    target: ScryerSourceTarget
    entry: ScryerSourceMapEntry
    committed: ScryModel
    planned: ScryModel
  }): ScryerSourceRouteDecision

  routeBoundaryEntry(args: {
    nodeId: string
    entry: ScryBoundaryEntry
    committed: ScryModel
    planned: ScryModel
  }): ScryerSourceRouteDecision

  clearSourceTarget(args: {
    target: ScryerSourceTarget
    committed: ScryModel
    planned: ScryModel
  }): ScryerSourceRouteDecision

  applySourceRoutes(args: {
    committed: ScryModel
    planned: ScryModel
    decisions: ScryerSourceRouteDecision[]
  }): { committed: ScryModel; planned: ScryModel; routed: ScryerSourceRouteDecision[] }
}

type ScryerSourceTarget =
  | { kind: 'responsibility'; responsibilityId: string }
  | { kind: 'node'; nodeId: string }
  | { kind: 'raw'; key: string }

type ScryerSourceRouteDecision = {
  targetKind: 'sourceMap' | 'boundary'
  key: string
  targetLayer: 'committed' | 'planned'
  clearOtherLayer: boolean
  reason: 'target_in_committed' | 'target_only_in_planned' | 'clear_requested'
}
```

The router returns routing decisions; it does not write files. `applySourceRoutes`
returns complete committed/planned snapshots so the first implementation can keep
layer-level replacement while still centralizing single-home source routing.

### Dependency Direction

Allowed direction:

```text
CLI / IPC / UI / agent adapters
  -> engine/index.ts
  -> pipeline.ts
  -> catalog.ts
  -> operations/*
  -> validators.ts / diff.ts / fold.ts / id-minter.ts
  -> state-store.ts
```

Dependency rules:

- Product callers import only `engine/index.ts` or a narrow adapter wrapper.
- `pipeline.ts` may call `catalog`, `state-store`, validators, diff/fold,
  id-minter, and operation executors.
- `catalog.ts` may import operation contracts and schema modules. It must not
  import `state-store.ts`.
- Operation files may import model types and pure helper types, but they must
  use the supplied services for id minting, fold, source routing, and shared
  validation.
- `state-store.ts` must not import `operations/*`, adapters, renderer code, or
  CLI code.
- Renderer and IPC modules must not import engine internal modules such as
  `state-store`, `fold`, or individual operation files.
- Tests should include dependency-ownership checks so forbidden imports fail
  before behavior tests hide the seam violation.

### Legacy Adapter Field Mapping

Legacy Orca shape can coexist with `ScryModel`, but mapping is explicit and
adapter-owned.

| Legacy Orca field | Native Scryer field | Rule |
| --- | --- | --- |
| `C4ModelData.nodes` | `ScryModel.nodes` | Map through a typed adapter. Do not pass legacy nodes into engine modules. |
| `C4Node.data.name` | `ScryNode.name` | Direct semantic mapping. |
| `C4Node.data.description` | `ScryNode.description` | Direct semantic mapping. |
| `C4Node.data.kind` | `ScryNode.kind` | Validate against Scryer 0.3 kind set. |
| `C4Node.data.technology` | `ScryNode.technology` | Direct semantic mapping. |
| `C4Node.data.external` | `ScryNode.external` | Direct semantic mapping. |
| `C4Node.parentId` | `ScryNode.parentId` | Direct semantic mapping after hierarchy validation. |
| `C4ModelData.edges` | `ScryModel.links` | Rename collection and map every edge explicitly. |
| `C4Edge.source` | `ScryLink.src` | Direct endpoint mapping. |
| `C4Edge.target` | `ScryLink.dst` | Direct endpoint mapping. |
| `C4Edge.data.label` | `ScryLink.label` | Use empty string only when legacy data is absent and the adapter explicitly allows it. |
| `C4Edge.data.method` | `ScryLink.method` | Direct semantic mapping. |
| `Group.memberIds` | `ScryGroup.memberIds` | Direct semantic mapping after group integrity validation. |
| `C4ModelData.sourceMap` | `ScryModel.sourceMap` | Only through source routing policy. Do not treat it as view metadata. |

Legacy-only fields remain outside `ScryModel`:

- `position`, `selected`, `measured`, and `refPositions` stay in renderer view
  state or render cache.
- `flows` stays in Orca extension state unless a future ADR defines a Scryer
  model equivalent.
- `validationWarnings` stays adapter output or view state. Engine validation
  returns `ScryerValidationFinding[]`.
- `_reference`, `_relationships`, `_operations`, `_needsLayout`, and edge route
  hints stay derived renderer data.

Cross-boundary object spread is forbidden. Adapters must construct target
objects field by field and have focused mapping tests.

### Upstream Parity Fixture Production Workflow

Parity fixtures are produced from a fixed upstream checkout and then normalized
into Orca structured expectations.

1. Record the upstream Scryer checkout commit in `case.json`.
2. Create the smallest project fixture that exercises the behavior, including
   `.scryer/model.scry`, optional `.scryer/planned.scry`, sync, anchor, history,
   or build-edge files when the operation uses them.
3. Run or inspect the upstream behavior anchor for that case. Anchors can be
   core functions such as `diff.rs::diff`, `lib.rs::commit_element`,
   `validate.rs::link_violation`, or MCP handlers such as
   `nodes.rs::mark_implemented`, `misc.rs::update_source_map`, and
   `generation.rs::fill_container`.
4. Convert upstream output to Orca's structured result by preserving semantics
   and replacing MCP text with `ScryerOperationResult`, structured findings, and
   structured error details.
5. Scrub request ids, absolute paths, timestamps, temp paths, and environment
   details. Preserve ids, element order, sourceMap keys, boundaries, stale
   flags, vagrant flags, and final model files.
6. Store accepted Orca differences in `case.json` under
   `orcaDifferenceReason`. A missing reason fails the parity test.

Minimal `case.json` shape:

```json
{
  "operationId": "scryer.link.add",
  "upstreamCommit": "<sha>",
  "upstreamAnchors": ["links.rs::add_links", "validate.rs::link_violation"],
  "input": {},
  "context": {},
  "expected": "success",
  "orcaDifferenceReason": "structured envelope replaces MCP Content::text output"
}
```

Allowed Orca differences:

- `ScryerOperationResult` envelope instead of MCP `Content::text(...)`.
- Structured `code`, `details`, `fieldErrors`, `path`, and `jsonPointer`
  instead of English error parsing.
- Scrubbed request ids, timestamps, absolute paths, and temp paths.

Forbidden differences without a new decision:

- Scryer 0.3 persisted field meaning.
- Planned and committed layer writes.
- SourceMap and boundary routing.
- Link legality.
- ID generation.
- Diff and fold element identity.
- Drift marker semantics.

### Current Code Migration Boundary

| Current Orca area | Migration role |
| --- | --- |
| `src/main/scryer/engine/**` | New semantic owner for Native Scryer Engine operations. |
| `src/main/scryer/mcp-tools.ts` | Compatibility scaffolding only. Do not add new 33-operation semantics here. |
| `src/main/scryer/model-store.ts` and `model-store-core.ts` | Legacy storage path for existing UI flows until adapters migrate. New engine operations do not depend on these files for state semantics. |
| `src/shared/scryer/model-types.ts` | Legacy C4 and renderer types. Do not use as the engine model. |
| `src/main/ipc/architecture.ts` | Adapter role. It may call `executeOperation(...)` or `readView(...)`, but must not own Scryer state semantics. |
| `src/renderer/src/components/architecture/**` | View/render state owner. It may render mapped engine views, but must not write `.scryer/*` or own model validation/fold logic. |

Test migration rules:

- New Scryer behavior tests are engine seam tests.
- Existing legacy tests remain compatibility regression tests until their
  product callers migrate.
- Do not expand `mcp-tools.test.ts` as the semantic test home for new migrated
  operations.
- IPC, CLI, and renderer tests verify mapping and ownership only. They do not
  duplicate engine operation behavior.

## Runtime Schema Rules

Use the existing `zod` dependency for runtime schema validation.

Runtime rules:

- `inputSchema` validates raw caller input before operation execution.
- `inputSchema` failures return `ok:false` with `invalid_input` and structured
  `fieldErrors`.
- `successSchema` validates only the `result` payload inside an `ok:true`
  envelope.
- A `successSchema` failure is an engine contract violation and returns
  `internal_error`.
- Error detail schemas validate `error.details` for each declared error code.
- If an operation returns a declared error code with malformed details, the
  pipeline returns `internal_error`.
- If an operation tries to return an undeclared operation-level error code, the
  pipeline returns `internal_error`.
- `meta.warnings` validates against one shared `ScryerOperationWarning` zod
  schema whenever warnings are present.
- First implementation does not define per-warning-code `details` schemas; it
  validates the common warning envelope shape only.
- First implementation accepts only warning code `maintenance_write_failed`;
  use warning `target` to identify which maintenance write failed.
- Dispatch-level and policy-level errors such as `operation_not_found`,
  `invalid_context`, `agent_run_required`, and uncaught exceptions remain
  pipeline-owned and are not operation-specific business errors.

Use common error sets plus operation-specific errors instead of repeating every
global error on every contract card.

Common engine errors:

```text
invalid_input, invalid_context, incompatible_model, io_error, lock_busy,
lease_required, operation_not_found, internal_error
```

Operation-specific errors include domain failures such as `not_found`,
`illegal_link`, `validation_failed`, and `agent_run_required` for mixed-mode
agent-completion policy. Catalog entries may compose shared read/write error
sets with a small operation-specific set.

Zod input and success schemas may share domain helpers such as
`findingSchema`, `pendingSummarySchema`, `sourceLocationSchema`,
`sourceSchema`, `foldedItemSchema`, and operation count/result fragments. Add a
schema helper only when a structure is reused by three or more operations or
when a single domain concept needs one authoritative runtime shape. Avoid
generic schema-factory layers whose names describe TypeScript mechanics rather
than Scryer domain concepts.

This keeps caller errors distinct from engine bugs. Invalid caller input is
recoverable by changing the request. Malformed success payloads or malformed
error details mean the operation violated its own catalog contract.

## Structured Error Taxonomy

Every engine error code has one stable detail schema. Operation contracts list
only operation-specific domain errors; the pipeline owns common dispatch,
context, schema, IO, lock, lease, and contract errors.

Target TypeScript shape:

```ts
type ScryerOperationErrorCode =
  | 'invalid_input'
  | 'invalid_context'
  | 'incompatible_model'
  | 'io_error'
  | 'lock_busy'
  | 'lease_required'
  | 'operation_not_found'
  | 'internal_error'
  | 'not_found'
  | 'illegal_link'
  | 'validation_failed'
  | 'agent_run_required'

type ScryerOperationEntity =
  | 'project'
  | 'node'
  | 'link'
  | 'group'
  | 'responsibility'
  | 'property'
  | 'source_entry'
  | 'boundary'
  | 'rule_topic'
  | 'agent_run'

type ScryerErrorDetailSchemaRegistry =
  Record<ScryerOperationErrorCode, z.ZodType<Record<string, unknown> | undefined>>
```

Detail schema table:

| Error code | Owner | Detail schema | Mapping rule |
| --- | --- | --- | --- |
| `invalid_input` | Pipeline | `undefined`; `error.fieldErrors` carries zod field errors. | Raw caller input failed `inputSchema` before execution. |
| `invalid_context` | Pipeline | `{ reason: 'missing_workspace_root' \| 'project_outside_workspace' \| 'unsupported_transport' \| 'missing_agent_run_id'; field?: string }` | Caller context is not sufficient to resolve or authorize the operation. |
| `incompatible_model` | State store | `{ path: string; expectedVersion: '0.3'; actualVersion?: string; reason: 'missing_version' \| 'unsupported_version' \| 'invalid_json' }` | A model file cannot be treated as upstream Scryer 0.3 state. |
| `io_error` | State store | `{ target: ScryerIoTarget; operation: 'read' \| 'write' \| 'rename' \| 'mkdir' \| 'append' \| 'lock'; path?: string; cause?: string }` | File-system access failed outside best-effort maintenance warning handling. |
| `lock_busy` | Pipeline/state store | `{ lockPath?: string; owner?: string; retryAfterMs?: number }` | The state lock could not be acquired. |
| `lease_required` | Pipeline | `{ policy: 'write_if_active' \| 'completion_gate'; activeLease?: true; activeOwner?: ScryerTransport }` | A write is blocked by an active model edit lease or completion-gated lease policy. Do not include the raw lease token in renderer-visible error details. |
| `operation_not_found` | Pipeline | `{ operationId: string }` | The requested operation id is not registered in the catalog. |
| `internal_error` | Pipeline | `{ reason: 'success_schema_failed' \| 'error_details_schema_failed' \| 'undeclared_error_code' \| 'policy_violation' \| 'malformed_warning' \| 'unknown_warning_code' \| 'unexpected_exception'; contractOperationId?: string }` | The engine or operation violated its own contract. Do not use for normal user-fixable input. |
| `not_found` | Operation | `{ entity: ScryerOperationEntity; id: string; field?: string }` | A referenced Scryer model element, project object, rule topic, or agent run does not exist. |
| `illegal_link` | Operation | `{ reason: 'self_link' \| 'ancestor_descendant' \| 'same_level_reference' \| 'duplicate_link'; src: string; dst: string; linkId?: string }` | Link endpoints exist, but the link violates Scryer structural rules. Missing endpoints use `not_found`. |
| `validation_failed` | Operation/validator | `{ findings: ScryerValidationFinding[] }` | The request is syntactically valid but would leave the Scryer model structurally invalid. |
| `agent_run_required` | Pipeline/operation | `{ mode: 'agent_completion'; reason: 'missing_context' \| 'inactive_run' \| 'lease_mismatch' \| 'run_not_complete'; agentRunId?: string; activeLease?: true }` | An operation mode requires trusted Orca agent-run context and it is missing or not satisfied. Do not include the raw lease token in renderer-visible error details. |

```ts
type ScryerIoTarget =
  | 'model'
  | 'planned'
  | 'history'
  | 'baseline'
  | 'sync'
  | 'anchor_baseline'
  | 'build_edges'
  | 'rules'
  | 'project_tree'
  | 'lock'
```

Error mapping rules:

- Input shape problems map to `invalid_input`, not `validation_failed`.
- Missing referenced ids map to `not_found`, even when upstream text mentions a
  failed operation such as "cannot move missing node".
- Existing link endpoints with illegal structure map to `illegal_link`.
- Model-level structural blockers map to `validation_failed` with findings.
- Upstream human-readable errors are behavior references only; Orca code must
  construct structured `code` and `details` without parsing English message text
  in callers.
- Any undeclared error code, malformed details object, malformed warning, or
  success-schema mismatch maps to `internal_error`.

Catalog tests must assert every error code used by an operation is present in
this taxonomy and has a zod detail schema. Pipeline tests must inject malformed
details for every operation-specific error family at least once and assert that
the result becomes `internal_error`.

## Capability Design

Capabilities are semantic families derived from upstream Scryer behavior. They
are not CRUD labels and do not replace the explicit transaction policy.

```ts
export type ScryerOperationCapability =
  | 'read'
  | 'validate'
  | 'plan_diff'
  | 'plan_author'
  | 'source_author'
  | 'plan_fold'
  | 'model_generate'
  | 'model_correct'
  | 'drift_detect'
  | 'drift_record'
  | 'drift_reconcile'
```

Capability meanings:

| Capability | Meaning | Default policy shape |
| --- | --- | --- |
| `read` | Read model or project context without changing model intent. | No lock for pure reads; `commit_if_writing` when the read may perform a declared maintenance write. |
| `validate` | Analyze committed model validity and return warnings/errors. | No lock, no lease, read committed, no writes. |
| `plan_diff` | Compare committed model and planned draft. | No lock, no lease, read committed + planned. |
| `plan_author` | Author intended future work in the planned layer. | Exclusive lock, active edit lease required when present, write planned. |
| `source_author` | Update code-side `sourceMap` or `boundaries` entries with layer routing derived from the target model element. | Exclusive lock, active edit lease required when present, conditionally write planned and committed. |
| `plan_fold` | Fold implemented planned work into committed state. | Exclusive lock, completion/lease policy, write committed + planned, best-effort baseline/history maintenance. |
| `model_generate` | Write codebase-derived model truth, usually with no pending work. | Exclusive lock, declared context policy, write committed + planned, refresh baseline/history/anchors as declared. |
| `model_correct` | Correct model scope while code remains untouched. | Exclusive lock, active edit lease required when present, write committed + planned, no pending work. |
| `drift_detect` | Detect changed code scopes since reconcile; no semantic verdict. | Read committed + sync/anchors/project files; `commit_if_writing` because it may seed sync/anchor baseline when absent. |
| `drift_record` | Record semantic drift verdicts into planned state. | Exclusive lock, write planned and history. |
| `drift_reconcile` | Advance drift baseline after review. | Write sync state and anchor fingerprint baseline. |

The catalog may derive defaults from capability, but every operation still
declares its full policy. Defaults are guardrails, not hidden behavior.

Policy execution rules:

- The pipeline executes each operation by its explicit `policy`, not by
  capability inference.
- `capability` is used for defaults, consistency checks, test grouping, and
  documentation.
- Policy declares possible reads, writes, and side effects. The executor returns
  the actual changes for the current request.
- Any returned write or side-effect payload outside the declared policy is an
  engine contract violation and returns `internal_error`.
- Semantic writes and `required` maintenance writes require
  `lock: 'exclusive'`. Read operations that may perform only `best_effort`
  maintenance writes use `lock: 'commit_if_writing'`; the executor can read
  without holding the state lock, and the state store acquires the lock only for
  the maintenance commit.
- Ordinary `read` operations have no side effects. Explicit operation families
  such as `drift_detect` may declare conditional writes because upstream Scryer
  seeds `.sync` and anchor baselines on first drift check.
- Operation risk is declared explicitly. The pipeline does not infer risk from
  capability.
- Catalog consistency tests enforce the relationship between risk and policy:
  `risk: 'high'` operations that write `.scryer` state require
  `lock: 'exclusive'` plus the applicable lease or completion-gate policy.
- Risk does not imply audit, undo/redo, save, recovery, or a default UI prompt.
  It supports policy consistency checks, authorization tests, operation grouping,
  and cautious UI/CLI copy where an adapter chooses to show it.

## Contract Shape

Target TypeScript shape:

```ts
type ScryerOperationContract<TInput, TResult> = {
  id: ScryerOperationId
  capability: ScryerOperationCapability
  risk: ScryerOperationRisk
  inputSchema: z.ZodType<TInput>
  successSchema: z.ZodType<TResult>
  errors: Partial<Record<ScryerOperationErrorCode, z.ZodType<Record<string, unknown> | undefined>>>
  policy: ScryerOperationPolicy
  upstream: ScryerUpstreamAnchor[]
  transports: ScryerTransportMetadata
  execute: ScryerOperationExecutor<TInput, TResult>
}

type ScryerEngine = {
  executeOperation<TResult = unknown>(
    operationId: ScryerOperationId,
    rawInput: unknown,
    context: ScryerOperationContext,
  ): Promise<ScryerOperationResult<TResult>>

  readView(
    input: ScryerReadViewInput,
    context: ScryerOperationContext,
  ): Promise<ScryerOperationResult<ScryerReadView>>
}

type CreateScryerEngineOptions = {
  catalog?: ScryerOperationCatalog
  stateStore?: ScryerStateStore
  errorMapper?: ScryerErrorMapper
  clock?: ScryerClock
  requestIds?: ScryerRequestIdFactory
  test?: {
    allowTestTransport?: boolean
  }
}

type ScryerOperationCatalog = {
  registerOperation<TInput, TResult>(
    contract: ScryerOperationContract<TInput, TResult>,
  ): void
  getOperationContract(operationId: ScryerOperationId): ScryerOperationContract<unknown, unknown> | undefined
  listOperationContracts(): ScryerOperationContract<unknown, unknown>[]
  validateCatalog(): ScryerCatalogValidationResult
}

type ScryerCatalogValidationResult = {
  ok: boolean
  errors: ScryerCatalogValidationError[]
}

type ScryerCatalogValidationError = {
  operationId?: ScryerOperationId
  code:
    | 'duplicate_operation_id'
    | 'missing_schema'
    | 'missing_error_schema'
    | 'invalid_policy'
    | 'invalid_policy_branch'
    | 'invalid_transport_metadata'
    | 'missing_upstream_anchor'
    | 'test_transport_not_allowed'
  message: string
}

type ScryerReadViewInput = {
  project?: string
  node?: string
  layer?: ScryerLayer
}

type ScryerOperationResult<TResult> =
  | {
      ok: true
      operationId: ScryerOperationId
      requestId: string
      result: TResult
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
  fieldErrors?: ScryerFieldError[]
  path?: string
  jsonPointer?: string
}

type ScryerFieldError = {
  path: string
  message: string
  code?: string
}

type ScryerTransportMetadata = {
  cli?: {
    command: string
    acceptsJson: boolean
    aliases?: string[]
  }
  ipc?: {
    channel: string
    mode: 'invoke' | 'send'
  }
  ui?: {
    intent: string
    surface?: 'architecture' | 'agent_run'
  }
  agent?: {
    operationName: string
  }
  system?: {
    operationName: string
  }
  test?: {
    enabled: boolean
  }
}

type ScryerValidationFindingSchemaRegistry =
  Partial<Record<string, z.ZodType<Record<string, unknown>>>>

type ScryerOperationPolicy =
  | ScryerFlatOperationPolicy
  | ScryerBranchedOperationPolicy

type ScryerFlatOperationPolicy = {
  authorization: ScryerOperationAuthorizationPolicy
  lock: ScryerOperationLockPolicy
  lease: 'none' | 'write_if_active' | 'completion_gate'
  reads: ScryerStateRead[]
  semanticWrites: ScryerSemanticWrite[]
  maintenanceWrites: ScryerMaintenanceWrite[]
  validation: ScryerValidationPolicy[]
  sideEffects: ScryerSideEffect[]
}

type ScryerBranchedOperationPolicy = {
  discriminator: {
    inputField: string
    allowedValues: NonEmptyArray<string>
  }
  branches: NonEmptyArray<ScryerOperationPolicyBranch>
}

type ScryerOperationPolicyBranch = {
  when: {
    inputField: string
    equals: string
  }
  policy: ScryerFlatOperationPolicy
}

type ScryerOperationAuthorizationPolicy = {
  // Adapter entry points allowed to call this operation directly.
  transports: NonEmptyArray<ScryerTransport>
  project: {
    containment: 'workspace_required' | 'resolved_project_only'
    allowProjectOverride: boolean
  }
  // Required only when operation semantics depend on an active Orca agent run
  // already tracked by Orca's native agent/session/status systems. This is a
  // context binding, not an identity permission check.
  agentRun: {
    required: boolean
    bindToContext: 'none' | 'agent_run_id_required'
  }
}

type NonEmptyArray<T> = [T, ...T[]]
type ScryerTransport = 'cli' | 'ipc' | 'ui' | 'agent' | 'system' | 'test'
type ScryerOperationRisk = 'normal' | 'destructive' | 'high'
type ScryerOperationLockPolicy = 'none' | 'exclusive' | 'commit_if_writing'

type ScryerStateRead =
  | 'planned'
  | 'committed'
  | 'rules'
  | 'project_tree'
  | 'sync'
  | 'anchors'
  | 'build_edges'
  | 'history'

type ScryerSemanticWrite =
  | 'planned'
  | 'committed'

type ScryerMaintenanceWriteTarget =
  | 'sync'
  | 'anchor_baseline'
  | 'committed_source_map_reanchor'
  | 'history'
  | 'baseline'

type ScryerMaintenanceWriteMode = 'required' | 'best_effort'

type ScryerMaintenanceWrite = {
  target: ScryerMaintenanceWriteTarget
  mode: ScryerMaintenanceWriteMode
}

type ScryerSideEffect =
  | 'baseline_refresh'
  | 'history_append'
  | 'sync_state_write'
  | 'anchor_baseline_refresh'
  | 'seed_sync_if_absent'
  | 'write_anchor_baseline_if_absent'
  | 'silent_reanchor_committed_source_map'
  | 'build_edges_read'
  | 'completion_gate'

type ScryerStateChanges = {
  planned?: ScryModel
  committed?: ScryModel
  historyEvents?: ScryerHistoryEvent[]
  syncState?: ScryerSyncState
  baseline?: 'refresh' | 'none'
  anchorBaseline?: 'refresh' | 'none'
  committedSourceMapReanchor?: 'refresh' | 'none'
}

type ScryerClock = {
  nowIso(): string
}

type ScryerRequestIdFactory = {
  next(): string
}

type ScryerValidationFinding = {
  code: ScryerValidationFindingCode
  severity: 'warning' | 'error'
  message: string
  path?: string
  jsonPointer?: string
  details?: Record<string, unknown>
}

type ScryerValidationPolicy =
  | 'structural_warnings'
  | 'coverage_warnings'
  | 'anchor_warnings'
  | 'write_guards'
  | 'link_legality'
  | 'hierarchy_integrity'
  | 'group_integrity'
  | 'source_mapping_integrity'
  | 'fold_postconditions'
  | 'generation_postconditions'

type ScryerValidationFindingCode =
  | 'duplicate_id'
  | 'missing_reference'
  | 'invalid_hierarchy'
  | 'invalid_external'
  | 'empty_responsibility'
  | 'description_too_long'
  | 'invalid_symbol_name'
  | 'empty_symbol'
  | 'illegal_link'
  | 'invalid_group'
  | 'unknown_source_map_target'
  | 'unknown_boundary_target'
  | 'disconnected_node'
  | 'coverage_gap'
  | 'coverage_overlap'
  | 'anchor_range_warning'
  | 'invalid_drift_marker_transition'

type ScryerOperationWarning = {
  code: ScryerOperationWarningCode
  message: string
  target?: ScryerMaintenanceWriteTarget
  details?: Record<string, unknown>
}

type ScryerOperationWarningCode =
  | 'maintenance_write_failed'

const ScryerOperationWarningSchema: z.ZodType<ScryerOperationWarning>

type ScryerOperationMeta = {
  warnings?: ScryerOperationWarning[]
  completionGate?: {
    complete: boolean
    pendingCount: number
    validationWarningCount: number
    validationErrorCount: number
  }
}

type ScryerOperationExecutor<TInput, TResult> = (args: {
  input: TInput
  context: ScryerOperationContext
  project: ResolvedScryerProject
  state: ScryerLoadedState
  services: ScryerOperationServices
}) => Promise<ScryerExecutorResult<TResult>> | ScryerExecutorResult<TResult>

type ScryerExecutorResult<TResult> =
  | { ok: true; outcome: ScryerOperationOutcome<TResult> }
  | { ok: false; failure: ScryerExecutorFailure }

type ScryerOperationOutcome<TResult> = {
  result: TResult
  changes?: ScryerStateChanges
  findings?: ScryerValidationFinding[]
}

type ScryerExecutorFailure = {
  code: ScryerOperationErrorCode
  message: string
  details?: Record<string, unknown>
  fieldErrors?: ScryerFieldError[]
  path?: string
  jsonPointer?: string
}

type ScryerErrorMapper = {
  mapExecutorFailure(args: {
    contract: ScryerOperationContract<unknown, unknown>
    failure: ScryerExecutorFailure
  }): ScryerOperationError

  mapPipelineFailure(args: {
    code: ScryerOperationErrorCode
    message: string
    details?: Record<string, unknown>
    fieldErrors?: ScryerFieldError[]
  }): ScryerOperationError

  mapStateStoreFailure(args: {
    code: ScryerOperationErrorCode
    message: string
    details?: Record<string, unknown>
  }): ScryerOperationError

  mapUnexpectedException(args: {
    error: unknown
    contractOperationId?: string
  }): ScryerOperationError

  toOperationResult<TResult>(args:
    | {
        ok: true
        operationId: ScryerOperationId
        requestId: string
        result: TResult
        meta?: ScryerOperationMeta
      }
    | {
        ok: false
        operationId: ScryerOperationId
        requestId: string
        error: ScryerOperationError
        meta?: ScryerOperationMeta
      }
  ): ScryerOperationResult<TResult>
}
```

`completionGate.complete` is true when `pendingCount === 0` and
`validationErrorCount === 0`. `validationWarningCount` does not block
completion; adapters may display "complete with warnings" without keeping the
workflow open.

The engine does not define CLI exit codes for validation. It returns structured
`ScryerValidationFinding[]`. CLI adapters should treat validation errors as a
non-zero command result and warning-only findings as a successful command with
warnings displayed.

CLI exit codes follow the operation envelope `ok` field. `ok:true` returns exit
code `0`, even when `meta.warnings` is present. `ok:false` returns non-zero.
Adapters may print `meta.warnings` to stderr or include them in structured JSON
output, but warnings do not change the exit code.

Operation executors receive validated input and loaded state. They return
`ScryerExecutorResult<TResult>`. Expected domain failures such as `not_found`,
`illegal_link`, and `validation_failed` return `{ ok: false, failure }`.
Unexpected thrown exceptions are caught by the pipeline and mapped through
`error-mapper` to `internal_error`. Executors do not resolve projects, inspect
leases, acquire locks, write `.scryer/*`, append history, create envelopes, or
format transport output.

Deterministic runtime services:

- `createScryerEngine(...)` accepts an optional `clock` and
  `requestIds` implementation. Production adapters use the real clock and
  request-id factory; tests inject fixed implementations.
- `createScryerEngine(...)` also accepts optional `catalog`, `stateStore`, and
  `errorMapper` adapters. Omitted adapters use production implementations.
  Tests may inject in-memory state stores, test catalogs, deterministic clocks,
  deterministic request ids, and failure-injecting state-store adapters.
- The pipeline assigns `requestId` before invoking the executor. Operation
  files must not create request ids.
- Persistent timestamps for history events, baseline metadata, health reports,
  drift reconciliation, and generated result fields must come from
  `services.clock.nowIso()`. Operation files and state-store internals must not
  call `Date.now()`, `new Date()`, or random id generation directly.
- Parity and golden tests may scrub request ids and timestamps, but unit tests
  should still inject deterministic services so failures are reproducible.
- Production engine construction fails catalog validation when a contract
  exposes `test` transport metadata without
  `CreateScryerEngineOptions.test.allowTestTransport`.

Shared success result types:

```ts
type ScryerLayer = 'plan' | 'committed'
type ScryKind = 'person' | 'system' | 'container' | 'component' | 'symbol'

type ScryerReadView = {
  layer: ScryerLayer
  model: ScryModel
  view: ScryerReadOverview | ScryerReadSubtree
  truncated?: boolean
  baselineRefreshed?: boolean
}

type ScryerReadOverview = {
  kind: 'overview'
  roots: ScryerReadNodeSummary[]
  links: ScryerReadLinkSummary[]
  groups: ScryerReadGroupSummary[]
}

type ScryerReadSubtree = {
  kind: 'subtree'
  node: ScryerReadNode
  descendants: ScryerReadNode[]
  links: ScryerReadLinkSummary[]
  references: ScryerReadReference[]
  sourceMap: ScryModel['sourceMap']
  boundaries: ScryModel['boundaries']
}

type ScryerReadNodeSummary = {
  id: string
  kind: ScryKind
  name: string
  path: string
  responsibilityCount: number
  propertyCount: number
  childCount: number
}

type ScryerReadNode = ScryNode & {
  path: string
}

type ScryerReadLinkSummary = {
  id: string
  src: string
  dst: string
  label: string
  method?: string
}

type ScryerReadGroupSummary = {
  id: string
  name: string
  memberIds: string[]
}

type ScryerReadReference = {
  nodeId: string
  referencedByLinkId: string
  surfaceNodeId?: string
}

type ScryerValidationResult = {
  findings: ScryerValidationFinding[]
  validationWarningCount: number
  validationErrorCount: number
}

type ScryerAddedItemsResult = {
  addedItems: ScryerAddedItem[]
}

type ScryerAddedItem = {
  kind: 'node' | 'group'
  nodeId?: string
  groupId?: string
  responsibilityIds: string[]
  propertyLabels?: string[]
  boundaryKeys?: string[]
  sourceMapKeys?: string[]
}

type ScryerPendingResult = {
  clean: boolean
  summary: ScryerPendingSummary
  changes: ScryerPendingChange[]
}

type ScryerPendingSummary = {
  total: number
  byKind: Partial<Record<ScryerPendingElementKind, number>>
  byChange: Partial<Record<ScryerPendingChangeKind, number>>
}

type ScryerPendingElementKind =
  | 'node'
  | 'responsibility'
  | 'property'
  | 'link'
  | 'group'

type ScryerPendingChangeKind =
  | 'added'
  | 'reworded'
  | 'moved'
  | 'repointed'
  | 'deleted'

type ScryerPendingChange = {
  kind: ScryerPendingElementKind
  change: ScryerPendingChangeKind
  id: string
  ownerId?: string
  path: string
  before?: unknown
  after?: unknown
  sourceMap?: SourceLocation[]
  stale?: boolean
  vagrant?: boolean
}

type ScryerPlanFoldResult = {
  folded: ScryerFoldedItem[]
  remaining: ScryerPendingChange[]
  findings?: ScryerValidationFinding[]
}

type ScryerFoldedItem = {
  kind: ScryerPendingElementKind
  id: string
  change: ScryerPendingChangeKind
}

type ScryerHealthReport = {
  scope: 'model' | 'node'
  nodeId?: string
  totals: Record<string, number>
  roots?: ScryerHealthNodeRollup[]
  children?: ScryerHealthNodeRollup[]
  anchors: ScryerAnchorObservation[]
  linkAudit?: ScryerLinkAudit
  coverage: ScryerCoverageReport
  stale: ScryerDriftMarkerSummary
  vagrant: ScryerDriftMarkerSummary
}

type ScryerHealthNodeRollup = {
  nodeId: string
  name: string
  kind: ScryKind
  totals: Record<string, number>
  anchorCount: number
  staleCount: number
  vagrantCount: number
}

type ScryerAnchorObservation = {
  targetId: string
  status: 'mapped' | 'unmapped' | 'changed' | 'broken' | 'fileMissing'
  locations?: SourceLocation[]
}

type ScryerLinkAudit = {
  declared: number
  extracted: number
  unmodeled: ScryerReadLinkSummary[]
  dark: ScryerReadLinkSummary[]
}

type ScryerCoverageReport = {
  mapped: number
  unmapped: number
  gaps: string[]
  overlaps: string[]
}

type ScryerDriftMarkerSummary = {
  count: number
  items: Array<{
    kind: ScryerPendingElementKind
    id: string
    ownerId?: string
  }>
}

type ScryerDriftScopeResult = {
  clean: boolean
  seeded?: boolean
  scopes: ScryerDriftScope[]
  guidance: string[]
}

type ScryerDriftScope = {
  nodeId: string
  nodeName: string
  path: string
  changedFiles: string[]
}

type ScryerGenerationResult = {
  containerId: string
  componentIds: string[]
  symbolIds: string[]
  groupIds: string[]
  droppedLinks?: ScryerDroppedLink[]
  findings?: ScryerValidationFinding[]
}

type ScryerDroppedLink = {
  src: string
  dst: string
  label: string
  method?: string
  reason: string
}
```

These are shared result contracts for complex operation families. Simple
operation results must still use the common field vocabulary: counts use
`updatedCount`, `deletedCount`, `writtenCount`, `movedCount`, or `removedCount`;
generated id lists use `addedIds`; tolerated missing requested ids use
`missingIds`. Shared result types must have zod schemas and focused schema tests
once, then operation success schemas should compose them instead of redefining
nested shapes.

Executors receive `ScryerLoadedState`, not `ScryerStateStore`. This keeps
operation files from bypassing catalog policy by reading or writing `.scryer`
files directly.

The first implementation should use layer-level replacement in
`ScryerStateChanges`: an executor returns the next complete `planned` and/or
`committed` model snapshot for the layers it changes. Do not start with a
fine-grained patch protocol. The pipeline enforces safety by rejecting any
returned layer or side-effect payload that the catalog policy did not declare.

`policy.semanticWrites` and `policy.maintenanceWrites` must stay separate.
Semantic writes change the Scryer model intent, such as planned node/link edits
or committed fold results. Maintenance writes update supporting engine state,
such as `.sync`, anchor baseline data, history, baseline snapshots, or committed
sourceMap line-number re-anchoring. Each maintenance write declares its failure
mode. `required` means the operation fails if that maintenance write fails.
`best_effort` means the maintenance write may fail without failing the main
operation, matching upstream history and baseline refresh behavior in several
tools. Orca records best-effort maintenance failures in
`ScryerOperationResult.meta.warnings` as structured warnings while keeping the
operation result `ok: true`. For example, `scryer.model.health` declares
`capability: 'read'`, `semanticWrites: []`, and:

```ts
maintenanceWrites: [
  { target: 'sync', mode: 'best_effort' },
  { target: 'anchor_baseline', mode: 'best_effort' },
  { target: 'committed_source_map_reanchor', mode: 'best_effort' },
]
```

`scryer.node.update` declares `semanticWrites: ['planned']` and
`maintenanceWrites: []`. `scryer.drift.reconcile` declares required maintenance
writes for `sync` and `anchor_baseline`, because upstream returns an error when
those writes fail.

`policy.sideEffects` is a strongly typed allow-list. It states which auxiliary
effects are allowed to happen, not what content should be written. The executor
returns structured content such as `historyEvents` or `syncState`; the pipeline
validates that the policy permits it and the state store performs the atomic
write. Unknown `sideEffects` enum values are catalog contract errors and must
fail runtime contract validation.

Keep `sideEffects` even though `maintenanceWrites` exists. `maintenanceWrites`
controls which supporting state targets may be written. `sideEffects` controls
which behavior the operation is allowed to request against those targets. For
example, writing `history` with side effect `history_append` is different from a
future history compaction behavior, even though both touch the same file.

Catalog validation must enforce the minimal relationship between side effects
and policy resources:

| Side effect | Required policy declaration |
| --- | --- |
| `history_append` | `maintenanceWrites` includes target `history` |
| `baseline_refresh` | `maintenanceWrites` includes target `baseline` |
| `sync_state_write` | `maintenanceWrites` includes target `sync` |
| `anchor_baseline_refresh` | `maintenanceWrites` includes target `anchor_baseline` |
| `silent_reanchor_committed_source_map` | `maintenanceWrites` includes target `committed_source_map_reanchor` |
| `build_edges_read` | `reads` includes `build_edges` |
| `completion_gate` | `lease: 'completion_gate'` or `capability: 'plan_fold'` |

If an operation declares a side effect without the required policy resource, the
catalog fails validation before operation execution.

For `ScryerBranchedOperationPolicy`, catalog validation applies the same checks
to every branch policy. The branch discriminator must reference a field declared
by the input schema, and every allowed discriminator value must have exactly one
branch.

Transport metadata is adapter mapping, not authority. The resolved flat
`policy.authorization.transports` allow-list decides whether a caller transport
may invoke the operation. `ScryerTransportMetadata` only records how an exposed
adapter maps to that operation. Catalog validation enforces:

- Every metadata key must be present in `policy.authorization.transports`.
- Missing metadata for an allowed transport means that adapter is not exposed in
  the current implementation batch; it does not remove the transport from the
  allow-list.
- Production catalogs must not include `test` metadata unless
  `CreateScryerEngineOptions.test.allowTestTransport` is true.
- Adapter tests assert mapping only. They do not re-test operation semantics.

Terminology:

- Authorization controls whether this caller is allowed to invoke the
  operation.
- Lease controls whether an active model-edit session currently blocks writes
  from non-owners.
- Risk classifies the operation's review posture. `normal` covers
  low-risk reads and planned authoring; `destructive` marks operations that
  remove or overwrite significant model state; `high` requires stricter lock,
  lease, or completion-gate controls when the operation writes state.
- Risk does not infer side effects and never creates storage on its own.

`transport`, agent-run identity, and lease token belong to trusted
`ScryerOperationContext` created by main-process Orca adapters or a thin
Scryer agent-run adapter over Orca's native agent runtime. That adapter must
not launch agents, track generic Codex/Claude sessions, infer task completion,
or own status UI; those remain in Orca's existing
hook/session/completion/orchestration modules. It only translates trusted Orca
run facts into Scryer context and coordinates Scryer-only semantics: model edit
lease token binding, completion-gated folds, cancellation cleanup of Scryer
leases, and post-run pending/validation handoff. Operation input is untrusted
caller data and must not be allowed to set or override authorization facts. If
a caller passes `caller`, `transport`, or similar fields inside operation
input, the engine ignores them for authorization.

The raw lease token must not cross into renderer-facing interfaces. Preload
types, renderer DTOs, DOM state, logs, prompts, and renderer-originated
`executeOperation(...)` input cannot expose or accept `leaseToken`. If an
active lease blocks a write, the engine may report that a lease is active, its
owner, and the bound agent run id where useful, but renderer-visible error
details must not echo the token itself. Agent completion goes through
`ScryerEditSessionController`, which resolves the token internally and attaches
it to trusted context before calling the engine.

`agentRun.required` is a context dependency, not an identity permission system.
Use it only for operations whose semantics depend on an active Orca agent run:
for example completion-gated folds, agent-owned model edit leases, cancellation
cleanup, and post-run validation handoff. A human-triggered UI flow may still
satisfy this requirement if it invokes the operation through the Scryer
agent-run adapter and supplies the active Orca run context.

Do not mark a mixed-mode operation as `agentRun.required: true` just because
one caller path needs agent-run context. For example, a human-triggered
`scryer.plan.fold` can be valid without an active agent run, while an
agent-completion fold must prove the active Orca run and matching Scryer lease.
Represent that difference with an explicit operation mode or a narrower
operation, then let the catalog/pipeline enforce the mode-specific policy.

For mixed-mode operations, model the mode in the operation input schema as a
validated discriminator. The input may express intent, but authorization facts
still come from `ScryerOperationContext`. If input claims an `agentRunId`,
`leaseToken`, `transport`, or caller identity that the trusted context does not
also supply and authorize for that mode, the pipeline must reject the request
instead of upgrading privileges from input.

An operation mode selects a policy branch; it does not grant permission. For
example, `{ mode: 'agent_completion' }` only requests the agent-completion
branch. If the trusted context lacks the required active Orca agent run and
matching Scryer lease facts, the pipeline returns `agent_run_required`. If the
active run exists but the Scryer lease is missing or mismatched, the pipeline
returns `lease_required`.
`agent_run_required` is not retryable by default because repeating the same
request cannot create trusted run context. Adapters that are waiting for a newly
started run to become visible should wait before calling the engine rather than
retrying a rejected operation.
Agent-completion mode must not require `transport: 'agent'` specifically. UI,
system, and agent adapters may all invoke it when they provide trusted active
run and matching lease context. A bare CLI/UI call without that context still
fails with `agent_run_required`.
Agent-completion fold does not add an engine-level confirmation policy or
confirmation token. UI adapters may show the pending diff and validation state,
but the engine safety model remains trusted run context, matching lease,
catalog policy, and validation checks rather than a modal prompt.

Catalog policy branches are explicit data, not hidden operation code. A
mixed-mode operation uses `ScryerBranchedOperationPolicy`; the pipeline validates
the discriminator value, selects exactly one `ScryerFlatOperationPolicy`, and
then runs the normal authorization, lease, read/write, validation, and side
effect checks against that resolved policy. Operation executors may read the
mode only as domain input; they must not decide whether agent-run context,
completion-gate lease, or maintenance writes are required.

`scryer.plan.fold` first-version policy is represented as two full branches:

- `mode: 'manual'`: no agent-run requirement, `lease: 'write_if_active'`,
  committed+planned reads, committed+planned semantic writes, best-effort
  baseline/history maintenance, and fold validators.
- `mode: 'agent_completion'`: active Orca agent-run context required,
  `lease: 'completion_gate'`, the same domain reads/writes and maintenance
  writes as manual mode, plus the `completion_gate` side effect.

Validation returns `ScryerValidationFinding[]` with exactly two first-version
severities: `warning` and `error`. Validation warnings do not block fold. Fold
operations fail only on `severity: 'error'` findings or illegal structural
states such as incompatible model version, malformed model data, missing link
endpoints, or illegal links. A successful fold may still return warning and
error counts in `meta.completionGate` for UI/CLI display and follow-up work.
Finding `path` uses Scryer semantic paths such as `node:api.name` or
`link:api-to-db.dst` because semantic ids remain stable across array ordering.
`jsonPointer` is optional and points to the raw model location, such as
`/nodes/0/name`, when low-level debugging needs it.

First-version semantic path grammar:

```text
model
model.<field>

node:<node_id>
node:<node_id>.<field>
node:<node_id>.responsibility:<responsibility_id>
node:<node_id>.responsibility:<responsibility_id>.<field>
node:<node_id>.property:<property_label>
node:<node_id>.property:<property_label>.<field>

link:<link_id>
link:<link_id>.<field>

group:<group_id>
group:<group_id>.<field>
group:<group_id>.responsibility:<responsibility_id>
group:<group_id>.responsibility:<responsibility_id>.<field>

sourceMap:responsibility:<responsibility_id>
sourceMap:node:<node_id>
sourceMap:<raw_anchor_key>

boundary:node:<node_id>
```

Encode semantic ids with URI encoding when they contain `.`, `:`, `/`, spaces,
or other path separators. For example, node id `api gateway` becomes
`node:api%20gateway.name`.
For source maps, validators should prefer typed paths
`sourceMap:responsibility:<responsibility_id>` and `sourceMap:node:<node_id>`.
Use `sourceMap:<raw_anchor_key>` only when the anchor key cannot be classified.
Raw anchor keys must be URI-encoded, and adapters should treat them as display
locations rather than guaranteed UI highlight targets.

Implement semantic validation paths through a small engine-internal
formatter/parser module, not ad hoc string concatenation in validators. The
module should provide formatter helpers for model, node, node responsibility,
node property, link, group, group responsibility, sourceMap responsibility,
sourceMap node, sourceMap raw key, and boundary node paths. It may provide a
minimal parser sufficient for UI, CLI, tests, and agents to identify target
kind/id/field. Do not expose this as an operation or expand it into a general
selector/query language in the first catalog implementation.

Finding `message` is short human-facing copy. Machine-usable facts belong in
`code`, `path`, `jsonPointer`, and `details`. Tests and agent repair flows
should rely on those structured fields instead of parsing English message text.
Only finding codes declared as machine-actionable require `details` schema
validation. Ordinary upstream validator warnings may remain structured as
`severity: 'warning'` with `message` and optional path data while Orca builds
out richer finding codes incrementally.

## Validator Matrix

Upstream behavior anchors are `scryer-core/src/validate.rs`,
`scryer-mcp/src/tools/read.rs::validate_model`, write guards in `nodes.rs`,
`links.rs`, `misc.rs`, `intent.rs`, and the anchor warnings used by
`validate_model`. Orca should preserve the distinction between validation
warnings and write blockers:

- `scryer.model.validate` reads committed state and returns findings. It does
  not fail just because findings exist.
- Operation write guards reject requests that would create illegal structural
  state. These failures return `not_found`, `illegal_link`, or
  `validation_failed`.
- Post-write validators run before state-store commit for committed-changing and
  high-risk operations. `severity: 'error'` blocks commit; `warning` does not.
- Validation code lives in shared validators, not operation files. Operation
  files call validators and translate the result through the shared error
  taxonomy.

Validation rule matrix:

| Validator | Finding code | Default severity in `model.validate` | Blocking contexts | Path target | Details |
| --- | --- | --- | --- | --- | --- |
| Duplicate node/link/group/responsibility ids | `duplicate_id` | `warning` | Raw set operations, generation postconditions, fold postconditions | Element path or `model` | `{ entity; id }` |
| Missing node parent, group parent, link endpoint, group member, source target, or boundary target | `missing_reference` | `warning` | Write guards for referenced inputs; postconditions for fold/generation | Referencing field path | `{ entity; id; field; targetEntity? }` |
| Invalid node parent kind, top-level non-person/system, child under external node, move cycle | `invalid_hierarchy` | `warning` | `node.move`, `node.set-subtree`, intent add operations, generation postconditions | `node:<id>.parentId` | `{ nodeId; parentId?; reason }` |
| `external=true` on unsupported node kind | `invalid_external` | `warning` | Intent add/update guards when caller sets external | `node:<id>.external` | `{ nodeId; kind }` |
| Blank responsibility statement | `empty_responsibility` | `warning` | Raw set and update guards when supplied item is blank after trim | Responsibility path | `{ responsibilityId; ownerId }` |
| Description above `DESCRIPTION_MAX_CHARS` | `description_too_long` | `warning` | Never blocking in first implementation | Element `.description` path | `{ entity; id; max; actual }` |
| Symbol name is not identifier-shaped | `invalid_symbol_name` | `warning` | `symbol.add`, `container.fill`, and raw generation postconditions | `node:<id>.name` | `{ nodeId; name }` |
| Empty symbol with no responsibility, property, or appearance | `empty_symbol` | `warning` | `container.fill` may allow thin symbols; other generation postconditions return warning only | `node:<id>` | `{ nodeId }` |
| Self-link, containment link, same-level different-parent link, unauthorized cross-level link, duplicate endpoint pair | `illegal_link` | `warning` for existing model state | `link.add`, `container.fill` required links, fold postconditions | `link:<id>` or requested endpoint path | `{ reason; src; dst; linkId? }` |
| Group with no members, missing parent, member outside parent node, mixed member kinds, duplicate group id | `invalid_group` | `warning` | `group.add`, `group.set`, `group.update`, fold/generation postconditions | `group:<id>` or group field path | `{ groupId; reason; memberId? }` |
| sourceMap key does not refer to a responsibility id or property-bearing node id | `unknown_source_map_target` | `warning` | `source.update`, fold/generation postconditions | `sourceMap:*` | `{ key; expected: 'responsibility_or_property_node' }` |
| boundary key does not refer to a node id | `unknown_boundary_target` | `warning` | `source.update`, intent boundary write, fold/generation postconditions | `boundary:node:<id>` | `{ nodeId }` |
| Node appears disconnected on its own C4 view | `disconnected_node` | `warning` | Never blocking in first implementation | `node:<id>` | `{ nodeId; view }` |
| Manifest directory has no source coverage | `coverage_gap` | `warning` | Never blocking in first implementation | `model` or boundary/source path | `{ directory; manifest }` |
| Source directory is mapped to multiple containers | `coverage_overlap` | `warning` | Never blocking in first implementation | `model` or boundary/source path | `{ directory; containerIds }` |
| Source range covers the whole symbol where a narrower responsibility anchor was expected | `anchor_range_warning` | `warning` | Never blocking in first implementation | `sourceMap:responsibility:<id>` | `{ responsibilityId; pattern; symbol? }` |
| Illegal stale/vagrant transition, such as moving a vagrant responsibility or folding stale marker without a selected verdict | `invalid_drift_marker_transition` | Not emitted by committed `model.validate` unless marker state is structurally inconsistent | `responsibility.move`, `plan.fold`, `drift.flag` guards | Element path | `{ entity; id; reason }` |

Operation validation policy matrix:

| Operation family | Required validation policy | Blocking behavior |
| --- | --- | --- |
| `scryer.model.validate` | `structural_warnings`, `coverage_warnings`, `anchor_warnings` | Never fails for warnings; returns all findings from committed state. |
| Read/query operations | None beyond model compatibility and requested id lookup. | Unknown requested node/topic returns `not_found`; model findings are not computed. |
| Planned node writes | `write_guards`, `hierarchy_integrity` when parent/kind/external changes are present. | Missing nodes or illegal hierarchy return `not_found`/`validation_failed`; warnings from full model validation may be included but do not block unless the write created a structural error. |
| Link add/update/delete | `link_legality`, `write_guards`. | Missing endpoints return `not_found`; self-link, containment, same-level/reference-rule failure, or duplicate endpoint pair return `illegal_link`; no partial batch write. |
| Group set/update/add/delete | `group_integrity`, `write_guards`. | Missing group/member/parent or illegal membership returns `not_found`/`validation_failed`; child group cleanup after delete is shared validator/fold behavior. |
| Source update | `source_mapping_integrity`, `write_guards`. | Unknown responsibility, schema node, or boundary node returns `not_found`/`validation_failed`; layer routing remains `source_author` policy behavior. |
| Intent add operations | `hierarchy_integrity`, `group_integrity`, `source_mapping_integrity` as applicable. | Parent kind, group membership, source anchor, or duplicate request-local key failures reject before write. |
| `scryer.plan.fold` | `fold_postconditions`, `link_legality`, `group_integrity`, `source_mapping_integrity`. | Selected target not pending, missing committed host, illegal post-fold link, or orphaned source/group state returns `validation_failed`; warning-only findings do not block. |
| `scryer.model.set` and raw subtree/group set | `structural_warnings`, `write_guards`. | Invalid JSON, non-0.3, duplicate ids, malformed hierarchy, or raw duplicate ids reject; non-blocking structural warnings are returned after write where upstream allows commit-with-warnings. |
| `scryer.container.fill` | `generation_postconditions`, `link_legality`, `group_integrity`, `source_mapping_integrity`. | Missing container, non-empty target container, duplicate local keys, missing symbols for code-bearing components, required proposal errors, or invalid generated state reject. Optional illegal links are dropped and reported, matching upstream. |
| Drift operations | `source_mapping_integrity`, `hierarchy_integrity`, drift marker transition guards. | `drift.get` does not create semantic findings; `drift.flag` rejects unknown targets or invalid request-local parent chains; `drift.reconcile` validates required maintenance writes through state-store policy. |

Finding detail schemas:

- `duplicate_id`: `{ entity: ScryerOperationEntity; id: string }`
- `missing_reference`: `{ entity: ScryerOperationEntity; id: string; field: string; targetEntity?: ScryerOperationEntity }`
- `invalid_hierarchy`: `{ nodeId: string; parentId?: string; reason: 'missing_parent' | 'invalid_parent_kind' | 'top_level_kind' | 'external_parent' | 'cycle' }`
- `invalid_external`: `{ nodeId: string; kind: ScryKind }`
- `empty_responsibility`: `{ responsibilityId: string; ownerId: string }`
- `description_too_long`: `{ entity: ScryerOperationEntity; id: string; max: number; actual: number }`
- `invalid_symbol_name`: `{ nodeId: string; name: string }`
- `empty_symbol`: `{ nodeId: string }`
- `illegal_link`: `{ reason: 'self_link' | 'ancestor_descendant' | 'same_level_reference' | 'duplicate_link'; src: string; dst: string; linkId?: string }`
- `invalid_group`: `{ groupId: string; reason: 'empty_members' | 'missing_parent' | 'missing_member' | 'member_outside_parent' | 'mixed_member_kinds' | 'duplicate_group_id'; memberId?: string }`
- `unknown_source_map_target`: `{ key: string; expected: 'responsibility_or_property_node' }`
- `unknown_boundary_target`: `{ nodeId: string }`
- `disconnected_node`: `{ nodeId: string; view: string }`
- `coverage_gap`: `{ directory: string; manifest: string }`
- `coverage_overlap`: `{ directory: string; containerIds: string[] }`
- `anchor_range_warning`: `{ responsibilityId: string; pattern: string; symbol?: string }`
- `invalid_drift_marker_transition`: `{ entity: ScryerOperationEntity; id: string; reason: 'vagrant_move' | 'missing_verdict' | 'stale_fold_without_target' }`

Validator implementation rules:

- Shared validators return `ScryerValidationFinding[]`; operation files do not
  construct English validation text.
- Upstream string warnings are reference material. Orca tests assert structured
  codes, paths, and details.
- A validator may be used in warning mode or blocking mode. Blocking mode returns
  `validation_failed` with the same findings.
- `illegal_link` remains a first-class operation error for interactive link
  writes because callers can fix it by changing `src`/`dst`; model validation may
  still surface existing illegal links as findings.
- Validators must use the semantic path formatter/parser described above.
- Validator tests should cover each finding code once at the validator seam and
  representative operation guards at the operation seam.

Do not split `scryer.plan.fold` into separate manual and agent-completion
operation IDs in the first catalog implementation. The domain behavior is the
same: fold selected planned changes into committed state. Use
`mode: 'manual' | 'agent_completion'` to select the policy branch. Split a
separate operation only if later product behavior diverges in inputs, outputs,
history semantics, or UI workflow.

The engine/catalog layer requires mixed-mode discriminators to be explicit.
For `scryer.plan.fold`, `mode` is required. Transport adapters may provide
friendly defaults, such as translating `orca scryer plan fold --node api` into
`{ mode: 'manual', node_id: 'api' }`, but the pipeline must receive and
validate an explicit mode.

Do not include `agentRunId` or `leaseToken` in operation input schemas. They
are runtime authorization, attribution, and concurrency-control facts, not
domain input. Trusted adapters place them on `ScryerOperationContext`;
executors receive only the selected model changes to fold, update, generate,
or reconcile. Renderer-facing adapters should expose sanitized session status,
not raw context fields.

Write operations default to
`project: { containment: 'workspace_required', allowProjectOverride: true }`.
If `context.workspaceRoot` is present, the resolved project must be inside it.
Read operations may use `resolved_project_only` when the operation explicitly
needs to inspect an arbitrary project path, but writes to `.scryer` state should
not default to cross-workspace access.
Preserve upstream `project?: string` in input schemas where upstream exposes it,
but project resolution and containment are pipeline responsibilities. Executors
receive `ResolvedScryerProject` and must not read or reinterpret
`input.project` directly.
`layer?: 'plan' | 'committed'` belongs only on read-like operations that
upstream already layers (`scryer.model.read`, `scryer.model.search`,
`scryer.model.query`). Do not add `layer` to `scryer.model.validate` in the
first catalog implementation; upstream validates committed model state, and
planned draft problems are handled by operation-local guards, `plan.pending`,
and fold-after-commit validation. Do not add `layer` to write operation inputs;
write targets are determined by operation semantics and catalog policy.

For ordinary CLI calls where no `context.workspaceRoot` exists, the CLI adapter
sets `workspaceRoot` to `cwd` for Scryer write operations. Cross-workspace
writes require a separately trusted system or agent context; they are not the
default behavior of `orca scryer ...` from a shell.

Saving and investigation are outside the Native Scryer Engine foundation. Do
not add `.scryer/audit.jsonl`, `.scryer/undo/`, redo stacks, or Orca-native
audit/undo/redo operations. The engine's job is to make each operation
deterministic, validated, locked, and atomically written. If a human wants a
durable saved state before or after a broad Scryer change, they can ask Codex
to perform that ordinary workspace workflow explicitly; it is not part of the
engine contract or operation catalog.

Because the engine does not provide recovery storage, primary write
transactions must be strict: an operation either commits the whole primary
commit group or leaves the prior state visible through the engine. The primary
commit group contains semantic writes plus `required` maintenance writes.
`best_effort` maintenance writes run only after the primary commit group has
succeeded; their failures become structured warnings and do not roll back the
primary commit. The pipeline must finish input validation, authority checks,
lock/lease checks, executor result validation, post-write model validation, and
side-effect authorization before committing. Operation files must never write
files directly. The state store owns atomic persistence for declared writes such
as `planned.scry`, `model.scry`, baseline refresh, history events, sync state,
anchor baselines, and committed sourceMap re-anchoring.

This is an operation-caller-visible guarantee, not a claim of database-grade
crash consistency across multiple files. The first implementation should use
temp-file plus rename for individual file writes, commit declared files in a
controlled order, and recover old content on ordinary IO failures when possible.
It does not need a transaction journal for process crashes, OS crashes, or
power loss. Tests should inject normal write failures and assert that subsequent
engine reads do not observe a mixed planned/committed state.

Existing Orca legacy Scryer code, including `src/main/scryer/mcp-tools.ts`, may
be used as reference material or refactor scaffolding only. New 33-operation
semantics must live under the Native Scryer Engine catalog, pipeline, state
store, validators, and `operations/*` modules. Engine operations must not call
`mcp-tools.ts` as their semantic implementation. Keep `mcp-tools.ts` only as
compatibility scaffolding until product callers migrate across the engine seam.

## Operation Migration Matrix

This matrix is the upstream-derived migration list used to validate the
capability enum. "Migrate" means implement as an Orca-native engine operation.
Layer and write-target policy is not an Orca invention; derive it from upstream
tool implementation calls:

- `read_model`, `search_model`, and `query_model` call an explicit `read_layer`
  helper where `plan` is the default and `committed` is opt-in.
- `validate_model`, `get_health`, and `get_drift` read committed model state;
  drift/health may maintain sync or anchor baselines as side effects.
- Interactive authoring tools read and write planned draft state only:
  `update_nodes`, `move_nodes`, `set_node`, `delete_nodes`,
  `move_responsibilities`, link writes, group writes, and `add_*` intent tools.
- Generation/correction tools intentionally write both layers:
  `set_model`, `fill_container`, and `descope`.
- `mark_implemented` is the fold boundary: it copies selected planned elements
  into committed state, preserves the plan where the diff naturally clears, and
  moves plan-owned anchors into committed state.
- `update_source_map` is the special source mapping router: `sourceMap` and
  `boundaries` entries for model elements present in committed state are written
  to committed state and removed from planned state; entries for model elements
  present only in planned state are written to planned state.

| Upstream tool | Orca operation id | Migrate? | Capability | Reads | Writes | Key side effects and notes |
| --- | --- | --- | --- | --- | --- | --- |
| `read_model` | `scryer.model.read` | Yes, first slice landed | `read` | planned by default or committed | best-effort baseline on committed read | Overview/subtree behavior follows upstream. |
| `search_model` | `scryer.model.search` | Yes | `read` | planned by default or committed | none | Fuzzy case-insensitive AND search. |
| `query_model` | `scryer.model.query` | Yes | `read` | planned by default or committed | none | Structural predicate query with optional subtree scope. |
| `get_rules` | `scryer.rules.read` | Yes | `read` | rules asset | none | Orca-native docs/rules source, no Scryer MCP product path. |
| `read_codebase` | `scryer.codebase.read` | Yes | `read` | project tree | none | Annotated project tree for modeling context. |
| `validate_model` | `scryer.model.validate` | Yes, first slice landed | `validate` | committed | none | Structural, coverage, and anchor warnings; no planned-layer validation in first catalog implementation. |
| `get_health` | `scryer.model.health` | Yes | `read` | committed + sync + anchors + project files | declared maintenance side effects only | Deterministic health lens; no semantic drift verdict. |
| `get_pending` | `scryer.plan.pending` | Yes, first slice landed | `plan_diff` | committed + planned | none | Plan diff work queue; filters vagrant drift adoptions. |
| `update_nodes` | `scryer.node.update` | Yes, first slice landed | `plan_author` | planned | planned | Patch existing nodes; preserve read-only directives. |
| `add_links` | `scryer.link.add` | Yes, first slice landed | `plan_author` | planned | planned | Validate endpoints, self-link, ancestor/descendant, same-level/reference rule. |
| `update_links` | `scryer.link.update` | Yes | `plan_author` | planned | planned | Patch label/method. |
| `delete_links` | `scryer.link.delete` | Yes, first slice landed | `plan_author` | planned | planned | Delete by `link_ids`. |
| `set_node` | `scryer.node.set-subtree` | Yes | `plan_author` | planned | planned | Raw generation primitive but plan-only upstream; prunes descendants and code maps. |
| `delete_nodes` | `scryer.node.delete` | Yes | `plan_author` | planned | planned | Stages code removal; pending until folded. |
| `move_nodes` | `scryer.node.move` | Yes | `plan_author` | planned | planned | Reparent subtree; remove moved node from old groups; append move history as declared. |
| `move_responsibilities` | `scryer.responsibility.move` | Yes | `plan_author` | planned | planned | Preserve responsibility id and anchors; reject vagrant moves; append move history. |
| `set_groups` | `scryer.group.set` | Yes | `plan_author` | planned | planned | Raw generation primitive but plan-only upstream; validates member levels. |
| `update_group` | `scryer.group.update` | Yes | `plan_author` | planned | planned | Patch group fields and validate membership. |
| `delete_group` | `scryer.group.delete` | Yes | `plan_author` | planned | planned | Delete group and detach child groups. |
| `add_person` | `scryer.person.add` | Yes | `plan_author` | planned | planned | Intent writer; mints ids and responsibilities. |
| `add_system` | `scryer.system.add` | Yes | `plan_author` | planned | planned | Intent writer for top-level systems and externals. |
| `add_container` | `scryer.container.add` | Yes | `plan_author` | planned | planned | Intent writer; optional boundary directory. |
| `add_component` | `scryer.component.add` | Yes | `plan_author` | planned | planned | Intent writer under container. |
| `add_group` | `scryer.group.add` | Yes | `plan_author` | planned | planned | Intent writer; mints group responsibilities. |
| `add_symbol` | `scryer.symbol.add` | Yes | `plan_author` | planned | planned | Intent writer; writes source anchors for responsibilities and data shapes. |
| `update_source_map` | `scryer.source.update` | Yes | `source_author` | planned + committed | planned and/or committed | SourceMap/boundary routing: committed elements write committed entries; planned-only elements write planned entries. |
| `mark_implemented` | `scryer.plan.fold` | Yes, first slice landed | `plan_fold` | committed + planned | committed + planned; best-effort baseline/history | Fold node/responsibility/deletion and append implementation history when available. |
| `set_model` | `scryer.model.set` | Yes | `model_generate` | optional committed prior | committed + planned | Full generation seed; validate version; save baseline; warnings do not block. |
| `fill_container` | `scryer.container.fill` | Yes | `model_generate` | committed + planned + build edges | committed + planned | Atomic empty-container fill; derive links from `.build_edges.json`; append born history. |
| `descope` | `scryer.node.descope` | Yes | `model_correct` | committed + planned | committed + planned; best-effort baseline | Code untouched; relocate responsibilities; no pending work. |
| `get_drift` | `scryer.drift.get` | Yes | `drift_detect` | committed + sync + anchors + project files | sync/anchors only when absent | Deterministic scope detector; changed files are not semantic verdicts. |
| `flag_drift` | `scryer.drift.flag` | Yes | `drift_record` | planned | planned + history | Records vagrant/stale responsibilities, properties, and nodes. |
| `reconcile_drift` | `scryer.drift.reconcile` | Yes | `drift_reconcile` | project state | sync + anchor fingerprint baseline | Advances review anchor after every drift scope is examined. |

## Catalog Contract Matrix

The catalog implementation should start from the following rows. The operation
cards below remain the behavior briefs; this matrix is the implementation shape
for `catalog.ts`.

Notation:

- `TProduct` means `['cli', 'ipc', 'ui', 'agent', 'system']`. The first
  adapter batch may expose only a subset, but production contracts must not
  include `test`.
- `-` means an empty array or no operation-specific errors.
- Common pipeline/engine errors apply to all operations and are not repeated:
  `invalid_input`, `invalid_context`, `incompatible_model`, `io_error`,
  `lock_busy`, `lease_required`, and `internal_error`.
- `commit_if_writing` means the operation can read without the state lock, but
  the state store must acquire the lock before committing declared maintenance
  writes.

### Catalog Policy Matrix

| Operation id | Capability | Risk | Lock | Lease | Transports | Reads | Semantic writes | Maintenance writes | Side effects |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `scryer.model.read` | `read` | `normal` | `commit_if_writing` | `none` | `TProduct` | `planned`, `committed` | - | `baseline:best_effort` | `baseline_refresh` |
| `scryer.model.search` | `read` | `normal` | `none` | `none` | `TProduct` | `planned`, `committed` | - | - | - |
| `scryer.model.query` | `read` | `normal` | `none` | `none` | `TProduct` | `planned`, `committed` | - | - | - |
| `scryer.rules.read` | `read` | `normal` | `none` | `none` | `TProduct` | `rules` | - | - | - |
| `scryer.codebase.read` | `read` | `normal` | `none` | `none` | `TProduct` | `project_tree` | - | - | - |
| `scryer.model.validate` | `validate` | `normal` | `none` | `none` | `TProduct` | `committed` | - | - | - |
| `scryer.model.health` | `read` | `normal` | `commit_if_writing` | `none` | `TProduct` | `committed`, `sync`, `anchors`, `project_tree`, `build_edges` | - | `sync:best_effort`, `anchor_baseline:best_effort`, `committed_source_map_reanchor:best_effort` | `seed_sync_if_absent`, `write_anchor_baseline_if_absent`, `silent_reanchor_committed_source_map`, `build_edges_read` |
| `scryer.plan.pending` | `plan_diff` | `normal` | `none` | `none` | `TProduct` | `committed`, `planned` | - | - | - |
| `scryer.node.update` | `plan_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.link.add` | `plan_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.link.update` | `plan_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.link.delete` | `plan_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.node.set-subtree` | `plan_author` | `high` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.node.delete` | `plan_author` | `destructive` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.node.move` | `plan_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | `history:best_effort` | `history_append` |
| `scryer.responsibility.move` | `plan_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | `history:best_effort` | `history_append` |
| `scryer.group.set` | `plan_author` | `high` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.group.update` | `plan_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.group.delete` | `plan_author` | `destructive` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.person.add` | `plan_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.system.add` | `plan_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.container.add` | `plan_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.component.add` | `plan_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.group.add` | `plan_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.symbol.add` | `plan_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | - | - |
| `scryer.source.update` | `source_author` | `normal` | `exclusive` | `write_if_active` | `TProduct` | `planned`, `committed` | `planned`, `committed` | - | - |
| `scryer.plan.fold` | `plan_fold` | `high` | `exclusive` | `completion_gate` | `TProduct` | `committed`, `planned` | `committed`, `planned` | `baseline:best_effort`, `history:best_effort` | `baseline_refresh`, `history_append`, `completion_gate` |
| `scryer.model.set` | `model_generate` | `high` | `exclusive` | `none` | `TProduct` | `committed` | `committed`, `planned` | `baseline:best_effort` | `baseline_refresh` |
| `scryer.container.fill` | `model_generate` | `high` | `exclusive` | `none` | `TProduct` | `committed`, `planned`, `build_edges` | `committed`, `planned` | `history:best_effort` | `build_edges_read`, `history_append` |
| `scryer.node.descope` | `model_correct` | `high` | `exclusive` | `write_if_active` | `TProduct` | `committed`, `planned` | `committed`, `planned` | `baseline:best_effort` | `baseline_refresh` |
| `scryer.drift.get` | `drift_detect` | `normal` | `commit_if_writing` | `none` | `TProduct` | `committed`, `sync`, `anchors`, `project_tree` | - | `sync:best_effort`, `anchor_baseline:best_effort` | `seed_sync_if_absent`, `write_anchor_baseline_if_absent` |
| `scryer.drift.flag` | `drift_record` | `high` | `exclusive` | `write_if_active` | `TProduct` | `planned` | `planned` | `history:best_effort` | `history_append` |
| `scryer.drift.reconcile` | `drift_reconcile` | `high` | `exclusive` | `none` | `TProduct` | `committed`, `sync`, `anchors`, `project_tree` | - | `sync:required`, `anchor_baseline:required` | `sync_state_write`, `anchor_baseline_refresh` |

### Schema, Error, And Upstream Anchor Matrix

| Operation id | Input schema | Success schema | Operation-specific errors | Upstream anchor |
| --- | --- | --- | --- | --- |
| `scryer.model.read` | `modelReadInputSchema` | `modelReadSuccessSchema` | `not_found` | `read.rs::read_model`, `ReadModelRequest` |
| `scryer.model.search` | `modelSearchInputSchema` | `modelSearchSuccessSchema` | - | `read.rs::search_model`, `SearchModelRequest` |
| `scryer.model.query` | `modelQueryInputSchema` | `modelQuerySuccessSchema` | `not_found` | `read.rs::query_model`, `QueryModelRequest` |
| `scryer.rules.read` | `rulesReadInputSchema` | `rulesReadSuccessSchema` | - | `read.rs::get_rules`, `GetRulesRequest` |
| `scryer.codebase.read` | `codebaseReadInputSchema` | `codebaseReadSuccessSchema` | - | `read.rs::read_codebase`, `ReadCodebaseRequest` |
| `scryer.model.validate` | `modelValidateInputSchema` | `modelValidateSuccessSchema` | - | `read.rs::validate_model`, `ValidateModelRequest`, `validate.rs` |
| `scryer.model.health` | `modelHealthInputSchema` | `modelHealthSuccessSchema` | `not_found` | `read.rs::get_health`, `GetHealthRequest`, `health.rs`, `build_edges.rs` |
| `scryer.plan.pending` | `planPendingInputSchema` | `planPendingSuccessSchema` | - | `read.rs::get_pending`, `GetPendingRequest`, `diff.rs` |
| `scryer.node.update` | `nodeUpdateInputSchema` | `nodeUpdateSuccessSchema` | `not_found`, `validation_failed` | `nodes.rs::update_nodes`, `UpdateNodeRequest` |
| `scryer.link.add` | `linkAddInputSchema` | `linkAddSuccessSchema` | `not_found`, `illegal_link`, `validation_failed` | `links.rs::add_links`, `AddLinkRequest` |
| `scryer.link.update` | `linkUpdateInputSchema` | `linkUpdateSuccessSchema` | `not_found` | `links.rs::update_links`, `UpdateLinkRequest` |
| `scryer.link.delete` | `linkDeleteInputSchema` | `linkDeleteSuccessSchema` | - | `links.rs::delete_links`, `DeleteLinkRequest` |
| `scryer.node.set-subtree` | `nodeSetSubtreeInputSchema` | `nodeSetSubtreeSuccessSchema` | `not_found`, `validation_failed` | `nodes.rs::set_node`, `SetNodeRequest` |
| `scryer.node.delete` | `nodeDeleteInputSchema` | `nodeDeleteSuccessSchema` | `not_found`, `validation_failed` | `nodes.rs::delete_nodes`, `DeleteNodeRequest` |
| `scryer.node.move` | `nodeMoveInputSchema` | `nodeMoveSuccessSchema` | `not_found`, `validation_failed` | `nodes.rs::move_nodes`, `MoveNodesRequest` |
| `scryer.responsibility.move` | `responsibilityMoveInputSchema` | `responsibilityMoveSuccessSchema` | `not_found`, `validation_failed` | `nodes.rs::move_responsibilities`, `MoveResponsibilitiesRequest` |
| `scryer.group.set` | `groupSetInputSchema` | `groupSetSuccessSchema` | `not_found`, `validation_failed` | `misc.rs::set_groups`, `SetGroupsRequest` |
| `scryer.group.update` | `groupUpdateInputSchema` | `groupUpdateSuccessSchema` | `not_found`, `validation_failed` | `misc.rs::update_group`, `UpdateGroupRequest` |
| `scryer.group.delete` | `groupDeleteInputSchema` | `groupDeleteSuccessSchema` | `not_found` | `misc.rs::delete_group`, `DeleteGroupRequest` |
| `scryer.person.add` | `personAddInputSchema` | `personAddSuccessSchema` | `validation_failed` | `intent.rs::add_person`, `AddPersonRequest` |
| `scryer.system.add` | `systemAddInputSchema` | `systemAddSuccessSchema` | `validation_failed` | `intent.rs::add_system`, `AddSystemRequest` |
| `scryer.container.add` | `containerAddInputSchema` | `containerAddSuccessSchema` | `not_found`, `validation_failed` | `intent.rs::add_container`, `AddContainerRequest` |
| `scryer.component.add` | `componentAddInputSchema` | `componentAddSuccessSchema` | `not_found`, `validation_failed` | `intent.rs::add_component`, `AddComponentRequest` |
| `scryer.group.add` | `groupAddInputSchema` | `groupAddSuccessSchema` | `not_found`, `validation_failed` | `intent.rs::add_group`, `AddGroupRequest` |
| `scryer.symbol.add` | `symbolAddInputSchema` | `symbolAddSuccessSchema` | `not_found`, `validation_failed` | `intent.rs::add_symbol`, `AddSymbolRequest` |
| `scryer.source.update` | `sourceUpdateInputSchema` | `sourceUpdateSuccessSchema` | `not_found`, `validation_failed` | `misc.rs::update_source_map`, `UpdateSourceMapRequest` |
| `scryer.plan.fold` | `planFoldInputSchema` | `planFoldSuccessSchema` | `not_found`, `validation_failed`, `agent_run_required` | `nodes.rs::mark_implemented`, `MarkImplementedRequest`, `diff.rs`, `history.rs` |
| `scryer.model.set` | `modelSetInputSchema` | `modelSetSuccessSchema` | `validation_failed` | `nodes.rs::set_model`, `SetModelRequest` |
| `scryer.container.fill` | `containerFillInputSchema` | `containerFillSuccessSchema` | `not_found`, `validation_failed`, `illegal_link` | `generation.rs::fill_container`, `CommitContainerModelRequest`, `build_edges.rs` |
| `scryer.node.descope` | `nodeDescopeInputSchema` | `nodeDescopeSuccessSchema` | `not_found`, `validation_failed` | `nodes.rs::descope`, `DescopeRequest` |
| `scryer.drift.get` | `driftGetInputSchema` | `driftGetSuccessSchema` | - | `read.rs::get_drift`, `GetDriftRequest`, `drift.rs` |
| `scryer.drift.flag` | `driftFlagInputSchema` | `driftFlagSuccessSchema` | `not_found`, `validation_failed` | `intent.rs::flag_drift`, `FlagDriftRequest`, `drift.rs` |
| `scryer.drift.reconcile` | `driftReconcileInputSchema` | `driftReconcileSuccessSchema` | - | `intent.rs::reconcile_drift`, `ReconcileDriftRequest`, `drift.rs` |

### Schema Field Matrix

This matrix is the field-level implementation source for zod input and success
schemas. The field names listed here are the only canonical engine field names.
Adapters may expose friendlier flags or legacy JSON aliases, and catalog input
schemas may accept upstream serde aliases for compatibility, but the pipeline
must normalize them before operation executors run. Operation executors,
validators, state-store, diff/fold, and id-minter must never branch on alias
names.

Canonical model boundary rule:

- The Native Scryer Engine internal model is `ScryModel` 0.3. Engine modules
  must not accept legacy `C4ModelData`, renderer node data, CLI flag objects, or
  upstream alias-shaped request objects as domain input.
- Field names do not need to be globally unique across Orca. Common names such
  as `nodes`, `groups`, `sourceMap`, `parentId`, `memberIds`, `line`, and
  `endLine` are safe only when contained by their owning type. The boundary
  problem is semantic mixing, not string collision.
- Legacy-to-native mapping belongs only in adapters. Examples: `edges` maps to
  `links`, `edge.source` maps to `link.src`, `edge.target` maps to `link.dst`,
  and `node.data.*` maps to direct `ScryNode` fields.
- Cross-boundary object spread is forbidden because it can silently carry
  legacy fields into engine state. Adapters must construct explicit target
  objects and have focused tests for the mapping.
- `sourceMap` and `boundaries` require extra care: they are canonical Scryer
  0.3 state with source-routing policy, not generic UI metadata.

Shared input conventions:

- `project?: string` appears only where upstream request structs expose it.
- `layer?: ScryerLayer` defaults to `plan` on upstream read/query operations
  that expose `Layer`.
- Empty arrays are rejected when the upstream operation requires at least one
  item; arrays with `default []` match upstream serde defaults.
- `data` fields on raw generation operations may accept parsed objects at the
  engine seam, but CLI adapters may still accept JSON strings.
- Where upstream documented serde aliases, such as `endLine`, `newNodes`,
  `undescribedProperties`, `staleProperties`, `staleNodes`, `nodeId`,
  `nodeKey`, `parentId`, and `parentKey`, catalog input schemas may accept
  those spellings only at the input boundary. The pipeline must normalize them
  to the canonical snake_case fields below and reject ambiguous payloads that
  provide both the alias and canonical field with different values.
- Do not introduce Orca-only aliases in engine schemas. New aliases belong in
  CLI/UI adapters and must normalize before `executeOperation(...)`.
- `scryer.plan.fold` extends upstream `MarkImplementedRequest` with explicit
  `mode` and non-node fold selectors so the shared fold module can handle every
  diff element through one operation id.

Shared helper input types:

- `QueryCondition`: `{ field: string; op: string; value?: string | number | boolean | null }`
- `UpdateNodeItem`: `{ node_id: string; kind?: ScryKind; name?: string; description?: string; technology?: string; external?: boolean; responsibilities?: ScryResponsibility[]; properties?: ScryProperty[]; visual?: boolean; parent_id?: string | null }`
- `SourceMapEntry`: `{ responsibility_id: string; locations: SourceLocation[] }`
- `SchemaSourceEntry`: `{ node_id: string; locations: SourceLocation[] }`
- `BoundaryEntry`: `{ node_id: string; sources: Source[] }`
- `ResponsibilityInput`: `string` or `{ statement: string; line?: number; end_line?: number }`
- `PropertyInput`: `{ label: string; description?: string }`
- `SymbolItem`: `{ parent_id: string; name: string; source_file: string; line?: number; end_line?: number; responsibilities?: ResponsibilityInput[]; properties?: PropertyInput[]; visual?: boolean }`
- `ProposedComponent`: `{ key: string; name: string; description?: string; responsibilities?: string[]; symbols: ProposedSymbol[] }`
- `ProposedSymbol`: `{ key: string; name: string; source_file: string; line?: number; end_line?: number; responsibilities?: ResponsibilityInput[]; properties?: PropertyInput[]; visual?: boolean }`
- `ProposedLink`: `{ src: string; dst: string; label: string; method?: string }`
- `ProposedGroup`: `{ name: string; description?: string; member_keys: string[]; responsibilities?: string[] }`
- `UndescribedItem`: `{ statement: string; source_file: string; symbol?: string; line?: number; end_line?: number; node_id?: string; node_key?: string }`
- `UndescribedProperty`: `{ label: string; description?: string; source_file: string; symbol?: string; node_id?: string; node_key?: string }`
- `NewNode`: `{ key: string; kind: ScryKind; name: string; parent_id?: string; parent_key?: string; description?: string; technology?: string }`
- `StaleResponsibility`: `{ responsibility_id: string; reason: string; proposed_statement?: string }`
- `StaleProperty`: `{ node_id: string; label: string; reason: string }`
- `StaleNode`: `{ node_id: string; reason: string }`

| Operation id | Input fields | Defaults and validation notes | Success fields |
| --- | --- | --- | --- |
| `scryer.model.read` | `project?`, `node?`, `layer?` | `layer` defaults to `plan`; unknown `node` returns `not_found`; committed reads may refresh baseline. | `ScryerReadView`. |
| `scryer.model.search` | `project?`, `query`, `kind?`, `layer?` | `query` must be non-empty after trim; `kind` must be a known Scry kind; `layer` defaults to `plan`. | `{ query; hits; truncated; results }` with id, kind, path, score, exact fields, and fuzzy fields. |
| `scryer.model.query` | `project?`, `where`, `under?`, `layer?` | `where` is non-empty `QueryCondition[]`; `conditions` may be accepted by adapters but engine schema uses `where`; `layer` defaults to `plan`. | `{ hits; truncated; results }` with id, kind, name, path, counts, and empty-symbol flag. |
| `scryer.rules.read` | `topic?` | No `project`; topic is free text matched against rules title/tags. | `{ topic?; index?; rules }` where topic-less reads return compact index. |
| `scryer.codebase.read` | `path` | `path` is required project directory path. | `{ root; tree; manifests; infrastructure; environmentFiles; truncated? }`. |
| `scryer.model.validate` | `project?` | Always reads committed state; no `layer` input in first catalog implementation. | `ScryerValidationResult`. |
| `scryer.model.health` | `project?`, `node_id?` | `node_id` scopes to one subtree; missing node returns `not_found`; maintenance writes are declared policy, not semantic edits. | `ScryerHealthReport`. |
| `scryer.plan.pending` | `project?` | Reads committed plus planned; no filters in first catalog implementation. | `ScryerPendingResult`. |
| `scryer.node.update` | `project?`, `nodes` | `nodes` is non-empty `UpdateNodeItem[]`; each `node_id` must exist in planned; whole-array responsibility/property replacement when present. | `{ updatedCount; findings?; pendingSummary?: ScryerPendingSummary }`. |
| `scryer.link.add` | `project?`, `links` | `links` is non-empty `{ src; dst; label; method? }[]`; validates endpoints, self-link, ancestor/descendant, reference rule, and duplicate endpoint pairs before writing. | `{ addedIds }` where `addedIds` is deterministic link id array. |
| `scryer.link.update` | `project?`, `links` | `links` is non-empty `{ link_id; label?; method? }[]`; endpoints are immutable; missing link returns `not_found`. | `{ updatedCount }`. |
| `scryer.link.delete` | `project?`, `link_ids` | `link_ids` is non-empty string array; deletion is by id. | `{ deletedCount; missingIds? }`. |
| `scryer.node.set-subtree` | `project?`, `node_id`, `data` | `data` is `{ nodes: ScryNode[]; links?: ScryLink[] }` or JSON string; descendants must remain under `node_id`; root node itself is not replaced. | `{ replacedRoot; removedDescendantCount; addedNodeCount; findings }`. |
| `scryer.node.delete` | `project?`, `node_ids` | `node_ids` is non-empty string array; removes descendants, connected links, source entries, boundaries, and group membership from planned. | `{ deletedCount; missingIds? }`. |
| `scryer.node.move` | `project?`, `moves` | `moves` is non-empty `{ node_id; new_parent_id? }[]`; validates hierarchy, external parent, cycles, and top-level kind rules. | `{ movedCount; findings }`. |
| `scryer.responsibility.move` | `project?`, `moves` | `moves` is non-empty `{ responsibility_id; from_node_id; to_node_id }[]`; rejects missing source/destination/responsibility and vagrant responsibility moves. | `{ movedCount }`. |
| `scryer.group.set` | `project?`, `data` | `data` is `ScryGroup`, `ScryGroup[]`, or JSON string; validates non-empty groups, members, parent node, same-level membership, and duplicate ids. | `{ writtenCount }`. |
| `scryer.group.update` | `project?`, `items` | `items` is non-empty `{ group_id; name?; description?; member_ids?; responsibilities? }[]`; replacement `member_ids` must have at least two valid same-level members. | `{ updatedCount }`. |
| `scryer.group.delete` | `project?`, `group_id` | `group_id` must exist; child groups are detached by clearing parent group reference. | `{ deletedGroupId }`. |
| `scryer.person.add` | `project?`, `items` | `items` is non-empty `{ name; description?; responsibilities? }[]`; responsibilities default to empty array; blank statements are skipped. | `ScryerAddedItemsResult` with node items. |
| `scryer.system.add` | `project?`, `items` | `items` is non-empty `{ name; description?; technology?; external?; responsibilities? }[]`; `external` defaults false. | `ScryerAddedItemsResult` with node items. |
| `scryer.container.add` | `project?`, `items` | `items` is non-empty `{ parent_id; name; technology?; description?; external?; responsibilities?; boundary_dir? }[]`; parent must be system; `external` defaults false. | `ScryerAddedItemsResult` with boundary keys when present. |
| `scryer.component.add` | `project?`, `items` | `items` is non-empty `{ parent_id; name; description?; responsibilities? }[]`; parent must be container. | `ScryerAddedItemsResult` with node items. |
| `scryer.group.add` | `project?`, `items` | `items` is non-empty `{ parent_id; name; description?; member_ids?; responsibilities? }[]`; `member_ids` defaults empty but valid authored groups require at least two same-level members. | `ScryerAddedItemsResult` with group items. |
| `scryer.symbol.add` | `project?`, `items` | `items` is non-empty `SymbolItem[]`; parent must be component; `source_file` required; responsibilities/properties default empty; `visual` defaults false. | `ScryerAddedItemsResult` with property labels and sourceMap keys. |
| `scryer.source.update` | `project?`, `entries?`, `schemas?`, `boundaries?` | Missing arrays default empty; at least one entry/schema/boundary is required; validates responsibility ids, schema node properties, and boundary node ids; whole-symbol ranges normalize to symbol-only anchors. | `{ updatedCount; normalizedWholeSymbolRanges }`. |
| `scryer.plan.fold` | `project?`, `mode`, `node_id?`, `responsibility_ids?`, `link_ids?`, `group_ids?`, `properties?`, `include_descendants?` | `mode` is `manual` or `agent_completion`; at least one fold selector is required; `agent_completion` requires trusted active run context. | `ScryerPlanFoldResult` plus `meta.completionGate`. |
| `scryer.model.set` | `project?`, `data` | `data` is Scryer 0.3 model object or JSON string; rejects invalid JSON, missing version, non-0.3, and blocking structural errors. | `{ nodeCount; linkCount; groupCount; findings }`. |
| `scryer.container.fill` | `project?`, `container_id`, `components`, `links?`, `groups?` | `components` is non-empty `ProposedComponent[]`; `links` and `groups` default empty; validates unique local keys, non-empty symbols for code-bearing components, and group member keys. | `ScryerGenerationResult`. |
| `scryer.node.descope` | `project?`, `node_ids` | `node_ids` is non-empty string array; each node must exist; code remains untouched; writes committed and planned together. | `{ removed; relocatedResponsibilities; droppedResponsibilities }`. |
| `scryer.drift.get` | `project?` | Reads deterministic drift scope from sync/anchors/project files; may seed sync/anchor state as declared maintenance. | `ScryerDriftScopeResult`. |
| `scryer.drift.flag` | `project?`, `node_id`, `undescribed?`, `new_nodes?`, `undescribed_properties?`, `stale?`, `stale_properties?`, `stale_nodes?` | Drift arrays default empty; `new_nodes` keys are request-local and must be unique; `parent_id` and `parent_key` are mutually exclusive. Upstream camelCase aliases are accepted only at the input boundary and normalized before execution. | `{ flagged; mintedNodes; vagrantResponsibilities; staleResponsibilities; staleProperties; staleNodes }`. |
| `scryer.drift.reconcile` | `project?` | Advances sync and anchor fingerprint baseline as required maintenance writes. | `{ reconciledAt; commit? }`. |

## Diff And Fold Semantics

Upstream behavior anchors are `scryer-core/src/diff.rs`,
`scryer-core/src/lib.rs::commit_element`, and
`scryer-mcp/src/tools/nodes.rs::mark_implemented`. Orca should reimplement the
same behavior behind a deeper `diff/fold` module instead of scattering fold
logic across operation files.

`diff(committed, planned)` is the pending-work source. It reports element-level
changes for nodes, links, responsibilities, properties, and groups. `sourceMap`,
`boundaries`, `stale`, `vagrant`, and `staleProposal` are folded as dependent
state attached to those elements; they are not independent top-level diff items
in the first implementation.

Fold target shape:

```ts
type ScryerFoldTarget =
  | { kind: 'node'; node_id: string; includeDescendants?: boolean }
  | { kind: 'responsibility'; responsibility_id: string }
  | { kind: 'property'; node_id: string; label: string }
  | { kind: 'link'; link_id: string }
  | { kind: 'group'; group_id: string }
```

`scryer.plan.fold` keeps the upstream-compatible `node_id` and
`responsibility_ids` path, but the internal fold module must support the full
target set so links, groups, properties, source anchors, and drift markers do not
require one-off fold code. Adapter aliases may translate CLI flags such as
`--link`, `--group`, or `--property node.label` into the target list.

Element fold behavior:

| Element | Add/update/move/reword fold | Deletion fold | Dependent state |
| --- | --- | --- | --- |
| Node | Upsert the planned node into committed by `node_id`. A move uses the planned parent field. A whole-node fold includes node scalar fields, direct responsibilities, properties, `visual`, and `appearance`; it does not fold descendants unless `includeDescendants` is true or descendant targets are selected. | If the node is absent from planned but present in committed, delete the committed node. For subtree deletion, delete descendants as one operation so committed state cannot keep orphaned children. | Move planned sourceMap entry keyed by node id and planned boundary entry keyed by node id into committed, then remove those planned entries. If deleting, remove committed and planned node sourceMap/boundary entries, responsibility anchors owned by the removed subtree, links touching removed nodes, and group memberships for removed nodes. |
| Responsibility | Remove the responsibility id from every committed host, then insert the planned responsibility under its planned node or group host. The host must already be committed or included earlier in the same fold batch. | If absent from planned, remove it from committed. | Move planned sourceMap keyed by responsibility id into committed and remove the planned copy. If planned does not carry a sourceMap for an already committed responsibility, keep the committed sourceMap. Clear `vagrant`, `stale`, and `staleProposal` on the committed folded responsibility. |
| Property | Upsert by `(node_id, label)` from planned into committed. Label changes appear as delete plus add because properties have no id. | If absent from planned, remove the committed property from the owner node. | Clear `vagrant` and `stale` on the committed folded property. Property folds do not own sourceMap unless the owning schema node also folds its sourceMap. |
| Link | Upsert the planned link by `link_id`; endpoint changes use planned `src` and `dst`. | If absent from planned, remove the committed link. | Validate that endpoints exist after the current fold batch. Link folds do not touch sourceMap or boundaries. |
| Group | Upsert the planned group by `group_id`, including parent group/node, members, responsibilities, and metadata. | If absent from planned, remove the committed group. Child groups that referenced the deleted group must match planned state when present; otherwise clear their `parentGroupId`. | Validate members exist and remain same-level. Group responsibilities fold through responsibility targets when selected independently; whole-group fold includes direct group responsibilities. |

Fold batch ordering:

1. Normalize requested fold selectors into `ScryerFoldTarget[]` and reject an
   empty selection with `invalid_input`.
2. Compute `diff(committed, planned)` and reject selected targets that are not
   pending work with `validation_failed`, except planned deletion targets that
   are absent from planned and present in committed.
3. Expand node deletion targets to their committed subtree and associated links,
   anchors, boundaries, and group memberships.
4. Apply additions and updates in dependency order: ancestor nodes, groups,
   responsibilities, properties, then links.
5. Apply deletions in reverse dependency order: links, responsibilities,
   properties, groups, descendant nodes, then ancestor nodes.
6. Validate the resulting committed and planned models before commit. Blocking
   structural errors return `validation_failed`; warnings may be returned in the
   success payload and must not block fold.
7. Commit committed+planned snapshots as one primary state-store transaction.
8. Refresh baseline and append implementation history as best-effort
   maintenance writes where declared by catalog policy.

Plan-layer update rules after fold:

- The planned layer remains the editable draft for unfolded work. Folding one
  target must not erase unrelated pending changes on the same node.
- For folded add/update targets, planned state is rewritten so the folded fields
  equal committed state. If other fields on the same element still differ, those
  differences remain pending.
- For folded deletion targets, planned and committed both omit the element after
  the fold; no tombstone file is required in the first implementation.
- Planned sourceMap or boundary entries moved to committed are removed from
  planned to preserve single-home source ownership.
- If the final planned model is state-equal to committed after source ownership
  cleanup, the state store may delete `planned.scry`; subsequent plan-layer reads
  still fall back to committed.

Drift marker fold rules:

- `vagrant` means code already exists and the model is considering adoption.
  Successful adoption fold clears `vagrant` on the committed node,
  responsibility, or property.
- `stale` means committed model truth no longer matches code. A re-implementation
  fold clears `stale`; an accepted reword fold commits the planned statement and
  clears both `stale` and `staleProposal`; a drop verdict folds a deletion.
- Partial folds clear markers only on selected elements. Remaining `vagrant` or
  `stale` elements must stay in planned state and continue to appear in health
  or pending views according to their operation semantics.

Required fold tests:

- Whole-node fold commits direct responsibilities, properties, visual state, and
  appearance without folding unrelated descendant changes.
- Selected responsibility fold leaves other planned responsibilities pending.
- Node deletion fold removes descendants, connected links, committed
  sourceMap/boundary entries, responsibility anchors, and group memberships.
- Node and responsibility sourceMap entries move from planned to committed on
  fold, while committed anchors are preserved when planned has no replacement.
- Link add/update/delete folds validate endpoints after the batch.
- Group add/update/delete folds validate membership, parent group, and child
  group cleanup.
- Property add/update/delete folds by `(node_id, label)`.
- Vagrant adoption clears `vagrant`; stale re-implementation or accepted reword
  clears `stale` and `staleProposal`; deletion removes stale/vagrant elements.

## ID Minting Semantics

Upstream behavior anchors are `scryer-core/src/lib.rs::next_node_id`,
`next_group_id`, `make_link_id`, `scryer-mcp/src/tools/intent.rs::RespMinter`,
and `scryer-mcp/src/tools/generation.rs::IdMinter`. Orca should keep the
upstream id formats but centralize minting in `id-minter` so operation files do
not scan models or reserve ids directly.

Target TypeScript shape:

```ts
type ScryerIdKind = 'node' | 'responsibility' | 'group' | 'link'

type ScryerIdUniverse = {
  committed?: ScryModel
  planned?: ScryModel
  reserved?: Iterable<string>
}

type ScryerIdMinter = {
  node(): string
  responsibility(): string
  group(): string
  link(src: string, dst: string): string
  reserveExisting(id: string, kind?: ScryerIdKind): void
}

function createScryerIdMinter(universe: ScryerIdUniverse): ScryerIdMinter
```

The implementation may use separate internal counters, but callers only see the
small `ScryerIdMinter` interface. A minted id is reserved immediately, before
the caller inserts the element into a model snapshot. This makes one operation
batch deterministic and prevents duplicate ids when several nodes,
responsibilities, and groups are created before the next model scan.

ID format and allocation rules:

| Element | Format | Counter source | Reservation rule | Notes |
| --- | --- | --- | --- | --- |
| Node | `node-N` | Max numeric `node-` suffix across committed, planned, and current batch reservations. | `node()` returns `node-${next}` and reserves it immediately. | Same sequence for person, system, container, component, and symbol. Names are not slugged into ids. |
| Responsibility | `resp-N` | Max numeric `resp-` suffix across all node-owned and group-owned responsibilities in committed, planned, and current batch reservations. | `responsibility()` returns `resp-${next}` and reserves it immediately. | Responsibility ids are globally unique across node and group hosts so move/fold can locate one id unambiguously. |
| Group | `group-N` | Max numeric `group-` suffix across committed, planned, and current batch reservations. | `group()` returns `group-${next}` and reserves it immediately. | Group ids are independent of node ids. |
| Link | `link-${src}-${dst}` | No numeric counter for normal add/generation operations. | `link(src, dst)` returns the deterministic endpoint id and reserves it; duplicate endpoint pairs are rejected or dropped according to the operation's policy. | `next_link_id` exists upstream but Orca's migrated add/generation operations use endpoint-deterministic ids. |
| Property | No id. | N/A | N/A | Property identity is `(node_id, label)`. Label changes appear as delete plus add. |
| SourceMap entry | Keyed by node id or responsibility id. | N/A | N/A | The key must reference an existing or newly minted node/responsibility id. |
| Boundary entry | Keyed by node id. | N/A | N/A | The key must reference an existing or newly minted node id. |

Seeding rules:

- The minter scans both committed and planned model layers whenever an operation
  can create ids. `planned.scry` still falls back to committed when absent.
- Scanning only committed is forbidden for generation operations such as
  `scryer.container.fill`, because planned-only enrichment may already have
  minted ids that are not committed yet.
- Non-numeric custom ids are preserved and exact-collision checked, but they do
  not advance numeric counters. Example: existing `node-api` blocks reusing
  `node-api`; it does not affect the next `node-N`.
- Explicit ids supplied inside `scryer.model.set`, `scryer.node.set-subtree`, or
  `scryer.group.set` are validated, not reminted. These raw generation
  primitives must reject duplicate ids in the resulting model state instead of
  silently rewriting caller data.
- Local keys in `scryer.container.fill` and `scryer.drift.flag` are request-local
  references, not persisted ids. They must be unique within the request and must
  not conflict with an existing model id when the operation resolves endpoints by
  either local key or existing id.

Batch behavior:

- Mint order is input order after validation. Reordering request arrays changes
  ids and is not a supported stability guarantee.
- Parent/child local references must point backward to an already validated
  request-local key, or to an existing model id. This preserves deterministic
  minting for chains such as drift-created component -> symbol.
- The operation holds the exclusive state-store lock for the read/mint/write
  cycle. `id-minter` does not provide cross-operation reservations after the
  lock is released.
- If the primary commit fails before writing any model state, retrying the same
  request should mint the same ids unless another successful operation changed
  committed or planned state in between.
- Best-effort maintenance failures do not affect minted ids, because ids live in
  the primary model snapshots.

Operation-specific minting rules:

| Operation family | Minting behavior |
| --- | --- |
| Intent add operations | `person.add`, `system.add`, `container.add`, `component.add`, and `symbol.add` mint node ids from the shared node counter and responsibility ids from the shared responsibility counter. `group.add` mints group ids and group responsibility ids. |
| `scryer.symbol.add` | Mints one symbol node id and zero or more responsibility ids. Responsibility sourceMap entries are keyed by the minted responsibility ids; schema-node sourceMap entry is keyed by the minted symbol node id when properties are present. |
| `scryer.container.fill` | Seeds from committed plus planned, mints component and symbol node ids, responsibility ids, group ids, and endpoint-deterministic link ids in one locked batch. Generated subtree is mirrored into planned without overwriting unrelated planned-only enrichment. |
| `scryer.drift.flag` | Mints vagrant node chains from request-local `new_nodes` keys, then mints vagrant responsibility ids or property entries for code-discovered behavior. New nodes and responsibilities are planned-only until folded. |
| `scryer.link.add` and generated links | Use deterministic endpoint ids. Duplicate endpoint pairs are illegal for interactive add; generation may drop non-essential duplicates or illegal optional links and report them in the success payload. |
| Raw set operations | `model.set`, `node.set-subtree`, and `group.set` validate supplied ids and do not call `id-minter`. |

Required ID minting tests:

- Minting scans committed plus planned plus current batch reservations.
- `container.fill` does not collide with a planned-only node, responsibility, or
  group id created by another operation.
- `add_symbol` writes responsibility anchors under minted `resp-N` ids and data
  shape anchors under the minted symbol node id.
- `group.add` mints group ids and group responsibility ids from the shared
  responsibility counter.
- `drift.flag` request-local parent keys resolve only to earlier minted nodes in
  the same request.
- Deterministic link ids are stable for the same `src` and `dst`; duplicate
  endpoint pairs do not mint alternate link ids.
- Raw set operations reject duplicate ids but do not rewrite supplied ids.

## 33 Operation Contract Appendix

These cards are behavior briefs that supplement the catalog matrix. The catalog
source is still the executable contract. Every card must be backed by focused
tests before or during migration.

Shared policy defaults:

- Read operations use `lease: 'none'` and no semantic model writes. Pure reads
  use `lock: 'none'`; reads with possible upstream maintenance side effects use
  `lock: 'commit_if_writing'`. Maintenance side effects must be explicit in
  catalog policy and must not change model intent. If a read operation performs
  a declared maintenance write, that write must run through state-store locking
  and transaction semantics. In catalog policy, read operations normally declare
  `semanticWrites: []`; any allowed maintenance files are declared in
  `maintenanceWrites`.
- Planned authoring operations use `lock: 'exclusive'`,
  `lease: 'write_if_active'`, read `planned`, and write `planned`.
- Source mapping operations use `lock: 'exclusive'`, `lease: 'write_if_active'`,
  read `planned + committed`, and route each `sourceMap` or `boundaries` entry
  according to whether the target model element exists in committed state or
  only in planned state.
- Committed-changing operations use `lock: 'exclusive'` and the card-specific
  lease/completion policy.
- All model-state operations reject non-0.3 models with `incompatible_model`.
- Operation input schemas include `project?: string` only where upstream has it.
- Success payloads are structured Orca equivalents of upstream text/JSON
  results; adapters may render them as text.

### `scryer.model.read`

- Upstream: `read_model` / `ReadModelRequest` /
  `tools/read.rs::read_model`.
- Input: `{ project?: string; node?: string; layer?: 'plan' | 'committed' }`.
- Success: overview without symbols when `node` is absent; subtree with
  descendants, links, references-for-children, sourceMap, boundaries, and
  `truncated` fallback when the subtree is too large.
- Policy: `read`, normal risk, reads plan by default or committed when
  requested; committed reads may refresh baseline with
  `maintenanceWrites: [{ target: 'baseline', mode: 'best_effort' }]` and
  `sideEffects: ['baseline_refresh']`.
- Tests: overview excludes symbols; scoped subtree includes source/reference
  data; unknown node returns `not_found`; committed read refreshes baseline
  best-effort.

### `scryer.model.search`

- Upstream: `search_model` / `SearchModelRequest` /
  `tools/read.rs::search_model`.
- Input: `{ project?: string; query: string; kind?: ScryKind; layer?: ScryerLayer }`.
- Success: `{ query; hits; truncated; results }` where results carry id, kind,
  breadcrumb path, score, and exact/fuzzy matched fields.
- Policy: `read`, normal risk, reads requested layer, caps at 50 hits.
- Tests: ANDs terms, honors kind filter, fuzzy-matches typos, ranks exact above
  fuzzy, empty query returns `invalid_input`.

### `scryer.model.query`

- Upstream: `query_model` / `QueryModelRequest` /
  `tools/read.rs::query_model`.
- Input: `{ project?: string; where: QueryCondition[]; under?: string; layer?: ScryerLayer }`.
- Success: `{ hits; truncated; results }` with id, kind, name, breadcrumb path,
  responsibility/property counts, and empty-symbol flag when true.
- Policy: `read`, normal risk, reads requested layer, caps at 200 hits.
- Tests: rejects empty predicate list; rejects unknown field/operator; scopes to
  subtree; composes predicates with AND.

### `scryer.drift.get`

- Upstream: `get_drift` / `GetDriftRequest` /
  `tools/read.rs::get_drift`.
- Input: `{ project?: string }`.
- Success: `{ clean; seeded?; scopes; guidance }`; each scope includes node id,
  node name, breadcrumb path, and changed files.
- Policy: `drift_detect`, normal risk, reads committed model, `.sync`,
  `.anchors.json`, and project files; may seed `.sync` and anchor baseline when
  missing with best-effort maintenance writes:
  `[{ target: 'sync', mode: 'best_effort' }, { target: 'anchor_baseline', mode: 'best_effort' }]`
  and side effects `['seed_sync_if_absent', 'write_anchor_baseline_if_absent']`.
- Tests: first call without anchor seeds clean state; later changed files surface
  scoped nodes; changed files are not semantic drift verdicts.

### `scryer.plan.pending`

- Upstream: `get_pending` / `GetPendingRequest` /
  `tools/read.rs::get_pending`.
- Input: `{ project?: string }`.
- Success: `{ clean; summary; changes }` where changes include node,
  responsibility, property, link, and group plan differences with source anchors
  where upstream provides them.
- Policy: `plan_diff`, normal risk, reads committed and planned, no writes.
- Tests: reports add/reword/move/delete/repoint; filters vagrant drift adoption
  entries; includes responsibility source anchors.

### `scryer.rules.read`

- Upstream: `get_rules` / `GetRulesRequest` /
  `tools/read.rs::get_rules`.
- Input: `{ topic?: string }`.
- Success: compact rules index when topic is absent; full matching rule text
  when topic is present.
- Policy: `read`, normal risk, reads Orca-owned rules asset, no model files.
- Tests: returns index without topic; returns matching topic; unknown topic
  returns guidance and index.

### `scryer.codebase.read`

- Upstream: `read_codebase` / `ReadCodebaseRequest` /
  `tools/read.rs::read_codebase`.
- Input: `{ path: string }`.
- Success: annotated project tree with manifest, infrastructure, and environment
  markers.
- Policy: `read`, normal risk, reads project directory, no model state.
- Tests: respects ignored build/dependency folders; marks manifests and
  infrastructure files; returns `io_error` for unreadable path.

### `scryer.model.validate`

- Upstream: `validate_model` / `ValidateModelRequest` /
  `tools/read.rs::validate_model` and `scryer-core/src/validate.rs`.
- Input: `{ project?: string }`; upstream reads committed model state.
- Success: `{ findings: ScryerValidationFinding[] }`.
- Policy: `validate`, normal risk, reads committed model state, no writes.
- Tests: maps upstream warnings to `severity: 'warning'`; returns structured
  paths for machine-actionable findings; warning-only result does not fail the
  engine operation; planned drafts are not validated by this operation.

### `scryer.model.health`

- Upstream: `get_health` / `GetHealthRequest` /
  `tools/read.rs::get_health`, `health.rs`, and `build_edges.rs`.
- Input: `{ project?: string; node_id?: string }`.
- Success: whole-model totals/roots/anchor observations/link audit, or scoped
  node rollup with children, anchors, links, and unmodeled edges.
- Policy: `read`, normal risk, reads committed model, sync/anchors, project
  files, and optional build-edge cache; `semanticWrites: []`;
  `maintenanceWrites: [{ target: 'sync', mode: 'best_effort' }, { target: 'anchor_baseline', mode: 'best_effort' }, { target: 'committed_source_map_reanchor', mode: 'best_effort' }]`;
  declared maintenance side effects:
  `['seed_sync_if_absent', 'write_anchor_baseline_if_absent', 'silent_reanchor_committed_source_map']`.
  Health reads that do not perform maintenance writes may run without a lock;
  maintenance writes must acquire the state-store lock and commit atomically.
- Tests: whole-model report; scoped report; missing node returns `not_found`;
  absent build-edge cache omits link audit instead of guessing.

### `scryer.model.set`

- Upstream: `set_model` / `SetModelRequest` /
  `tools/nodes.rs::set_model`.
- Input: `{ project?: string; data: ScryModel | string }`; incoming model must
  be Scryer 0.3.
- Success: `{ nodeCount; linkCount; groupCount; findings }`.
- Policy: `model_generate`, high risk, exclusive lock, reads optional committed
  prior, `semanticWrites: ['planned', 'committed']`,
  `maintenanceWrites: [{ target: 'baseline', mode: 'best_effort' }]`,
  `sideEffects: ['baseline_refresh']`.
- Tests: rejects invalid JSON/non-0.3 model; writes plan and committed equal;
  preserves read-only directives from prior; warnings do not block write.

### `scryer.node.update`

- Upstream: `update_nodes` / `UpdateNodeRequest` /
  `tools/nodes.rs::update_nodes`.
- Input: `{ project?: string; nodes: UpdateNodeItem[] }` with optional kind,
  name, description, technology, external, responsibilities, properties, visual,
  and parent id patches.
- Success: `{ updatedCount; findings?; pendingSummary? }`.
- Policy: `plan_author`, normal risk, exclusive lock, write-if-active lease,
  reads/writes planned.
- Tests: patches existing nodes only; whole-array responsibility/property
  replacement; unknown node returns `not_found`; preserves read-only directives;
  rewrites renamed wikilinks.

### `scryer.plan.fold`

- Upstream: `mark_implemented` / `MarkImplementedRequest` /
  `tools/nodes.rs::mark_implemented`.
- Input: `{ project?: string; mode: 'manual' | 'agent_completion'; node_id?: string; responsibility_ids?: string[]; link_ids?: string[]; group_ids?: string[]; properties?: { node_id: string; label: string }[]; include_descendants?: boolean }`. At least one fold selector is required. `node_id` plus `responsibility_ids` preserves the upstream `mark_implemented` path; the extra selectors expose the shared fold module so link, group, and property plan diffs can fold without operation-specific write code.
- Success: `{ folded; remaining; findings? }` plus `meta.completionGate`.
- Policy: `plan_fold`, high risk, `ScryerBranchedOperationPolicy` on `mode`.
  Both branches use exclusive lock, committed+planned reads,
  `semanticWrites: ['committed', 'planned']`,
  `maintenanceWrites: [{ target: 'baseline', mode: 'best_effort' }, { target: 'history', mode: 'best_effort' }]`,
  and side effects `['baseline_refresh', 'history_append']`. The manual branch
  uses `lease: 'write_if_active'` and no agent-run requirement. The
  `agent_completion` branch uses `lease: 'completion_gate'`, requires trusted
  active Orca agent-run context, and adds the `completion_gate` side effect.
- Tests: folds whole planned node; folds selected responsibilities while leaving
  unrelated pending items; folds link, group, and property changes; folds planned
  subtree deletion with sourceMap/boundary cleanup; records implementation
  history; missing agent context in agent mode returns `agent_run_required`.

### `scryer.node.move`

- Upstream: `move_nodes` / `MoveNodesRequest` /
  `tools/nodes.rs::move_nodes`.
- Input: `{ project?: string; moves: { node_id: string; new_parent_id?: string | null }[] }`.
- Success: `{ movedCount; findings }`.
- Policy: `plan_author`, normal risk, exclusive lock, write-if-active lease,
  reads/writes planned,
  `maintenanceWrites: [{ target: 'history', mode: 'best_effort' }]`,
  `sideEffects: ['history_append']`.
- Tests: validates hierarchy, missing parent, external parent, and cycle; removes
  moved node from old groups; no-op move does not record history.

### `scryer.node.set-subtree`

- Upstream: `set_node` / `SetNodeRequest` /
  `tools/nodes.rs::set_node`.
- Input: `{ project?: string; node_id: string; data: { nodes: ScryNode[]; links?: ScryLink[] } | string }`.
- Success: `{ replacedRoot; removedDescendantCount; addedNodeCount; findings }`.
- Policy: `plan_author`, high risk, exclusive lock, write-if-active lease,
  reads/writes planned.
- Tests: rejects unknown root and malformed subtree JSON; removes existing
  descendants, links, sourceMap, and boundaries; skips accidental replacement of
  root; ignores links with unknown endpoints like upstream.

### `scryer.node.delete`

- Upstream: `delete_nodes` / `DeleteNodeRequest` /
  `tools/nodes.rs::delete_nodes`.
- Input: `{ project?: string; node_ids: string[] }`.
- Success: `{ deletedCount; missingIds? }`.
- Policy: `plan_author`, destructive risk, exclusive lock, write-if-active
  lease, reads/writes planned.
- Tests: removes descendants, connected links, sourceMap, boundaries, and group
  memberships; missing ids are tolerated only as upstream behavior permits;
  deletion remains pending until fold.

### `scryer.node.descope`

- Upstream: `descope` / `DescopeRequest` /
  `tools/nodes.rs::descope`.
- Input: `{ project?: string; node_ids: string[] }`.
- Success: `{ removed; relocatedResponsibilities; droppedResponsibilities }`.
- Policy: `model_correct`, high risk, exclusive lock, writes planned and
  committed,
  `maintenanceWrites: [{ target: 'baseline', mode: 'best_effort' }]`,
  `sideEffects: ['baseline_refresh']`,
  no pending work.
- Tests: rejects unknown node; relocates target node's own responsibilities to
  parent while preserving anchors; drops descendant responsibilities; code is
  untouched and no pending diff remains.

### `scryer.responsibility.move`

- Upstream: `move_responsibilities` / `MoveResponsibilitiesRequest` /
  `tools/nodes.rs::move_responsibilities`.
- Input: `{ project?: string; moves: { responsibility_id: string; from_node_id: string; to_node_id: string }[] }`.
- Success: `{ movedCount }`.
- Policy: `plan_author`, normal risk, exclusive lock, write-if-active lease,
  reads/writes planned,
  `maintenanceWrites: [{ target: 'history', mode: 'best_effort' }]`,
  `sideEffects: ['history_append']`.
- Tests: rejects missing source/destination/responsibility; rejects vagrant
  responsibility moves; preserves responsibility id and source anchors.

### `scryer.source.update`

- Upstream: `update_source_map` / `UpdateSourceMapRequest` /
  `tools/misc.rs::update_source_map`.
- Input: `{ project?: string; entries?: SourceMapEntry[]; schemas?: SchemaSourceEntry[]; boundaries?: BoundaryEntry[] }`.
- Success: `{ updatedCount; normalizedWholeSymbolRanges }`.
- Policy: `source_author`, normal risk, exclusive lock, write-if-active lease,
  reads planned and committed, writes planned and/or committed with
  sourceMap/boundary routing derived from the target model element.
- Tests: validates responsibility ids, schema nodes with properties, and boundary
  node ids; normalizes whole-symbol line ranges to symbol-only anchors; model
  elements present in committed write committed `sourceMap`/`boundaries` entries
  and remove planned shadow entries; model elements present only in planned write
  planned `sourceMap`/`boundaries` entries.

### `scryer.group.set`

- Upstream: `set_groups` / `SetGroupsRequest` /
  `tools/misc.rs::set_groups`.
- Input: `{ project?: string; data: ScryGroup | ScryGroup[] | string }`.
- Success: `{ writtenCount }`.
- Policy: `plan_author`, high risk, exclusive lock, write-if-active lease,
  reads/writes planned.
- Tests: accepts single group or array; rejects empty array, invalid JSON,
  missing members, unknown members, and mixed member kinds; upserts by id.

### `scryer.group.update`

- Upstream: `update_group` / `UpdateGroupRequest` /
  `tools/misc.rs::update_group`.
- Input: `{ project?: string; items: UpdateGroupItem[] }` with optional name,
  description, member ids, and responsibilities.
- Success: `{ updatedCount }`.
- Policy: `plan_author`, normal risk, exclusive lock, write-if-active lease,
  reads/writes planned.
- Tests: rejects missing group, fewer than two replacement members, unknown
  member, and member outside the group's parent node; patches only provided
  fields.

### `scryer.group.delete`

- Upstream: `delete_group` / `DeleteGroupRequest` /
  `tools/misc.rs::delete_group`.
- Input: `{ project?: string; group_id: string }`.
- Success: `{ deletedGroupId }`.
- Policy: `plan_author`, destructive risk, exclusive lock, write-if-active
  lease, reads/writes planned.
- Tests: rejects unknown group; deletes target group; detaches child groups by
  clearing `parentGroupId`.

### `scryer.link.add`

- Upstream: `add_links` / `AddLinkRequest` /
  `tools/links.rs::add_links`.
- Input: `{ project?: string; links: { src: string; dst: string; label: string; method?: string }[] }`.
- Success: `{ addedIds: string[] }` with deterministic link ids.
- Policy: `plan_author`, normal risk, exclusive lock, write-if-active lease,
  reads/writes planned.
- Tests: rejects unknown endpoints, self-links, ancestor/descendant links, and
  same-level/reference violations; rejects illegal batch without partial write.

### `scryer.link.update`

- Upstream: `update_links` / `UpdateLinkRequest` /
  `tools/links.rs::update_links`.
- Input: `{ project?: string; links: { link_id: string; label?: string; method?: string }[] }`.
- Success: `{ updatedCount }`.
- Policy: `plan_author`, normal risk, exclusive lock, write-if-active lease,
  reads/writes planned.
- Tests: rejects missing link; patches only label/method; leaves endpoints
  immutable.

### `scryer.link.delete`

- Upstream: `delete_links` / `DeleteLinkRequest` /
  `tools/links.rs::delete_links`.
- Input: `{ project?: string; link_ids: string[] }`.
- Success: `{ deletedCount; missingIds?: string[] }`.
- Policy: `plan_author`, normal risk, exclusive lock, write-if-active lease,
  reads/writes planned.
- Tests: deletes by id; first-slice behavior may report missing ids while
  preserving upstream's no-error deletion semantics.

### `scryer.person.add`

- Upstream: `add_person` / `AddPersonRequest` /
  `tools/intent.rs::add_person`.
- Input: `{ project?: string; items: { name: string; description?: string; responsibilities?: string[] }[] }`.
- Success: `ScryerAddedItemsResult` with node items.
- Policy: `plan_author`, normal risk, exclusive lock, write-if-active lease,
  reads/writes planned.
- Tests: mints top-level person node ids and responsibility ids; writes only
  planned; accepts multiple items.

### `scryer.system.add`

- Upstream: `add_system` / `AddSystemRequest` /
  `tools/intent.rs::add_system`.
- Input: `{ project?: string; items: { name: string; description?: string; technology?: string; external?: boolean; responsibilities?: string[] }[] }`.
- Success: `ScryerAddedItemsResult` with node items.
- Policy: `plan_author`, normal risk, exclusive lock, write-if-active lease,
  reads/writes planned.
- Tests: mints top-level system/external nodes; preserves external flag and
  technology; writes responsibilities.

### `scryer.container.add`

- Upstream: `add_container` / `AddContainerRequest` /
  `tools/intent.rs::add_container`.
- Input: `{ project?: string; items: { parent_id: string; name: string; technology?: string; description?: string; external?: boolean; responsibilities?: string[]; boundary_dir?: string }[] }`.
- Success: `ScryerAddedItemsResult` with node and boundary items.
- Policy: `plan_author`, normal risk, exclusive lock, write-if-active lease,
  reads/writes planned; may write planned boundary globs.
- Tests: rejects non-system parent; mints container ids and responsibilities;
  writes boundary glob from `boundary_dir`.

### `scryer.component.add`

- Upstream: `add_component` / `AddComponentRequest` /
  `tools/intent.rs::add_component`.
- Input: `{ project?: string; items: { parent_id: string; name: string; description?: string; responsibilities?: string[] }[] }`.
- Success: `ScryerAddedItemsResult` with node items.
- Policy: `plan_author`, normal risk, exclusive lock, write-if-active lease,
  reads/writes planned.
- Tests: rejects non-container parent; mints component ids/responsibilities; does
  not create source anchors.

### `scryer.group.add`

- Upstream: `add_group` / `AddGroupRequest` /
  `tools/intent.rs::add_group`.
- Input: `{ project?: string; items: { parent_id: string; name: string; description?: string; member_ids?: string[]; responsibilities?: string[] }[] }`.
- Success: `ScryerAddedItemsResult` with group items.
- Policy: `plan_author`, normal risk, exclusive lock, write-if-active lease,
  reads/writes planned.
- Tests: validates sibling members under parent; mints group and responsibility
  ids; rejects wrong parent/member level.

### `scryer.symbol.add`

- Upstream: `add_symbol` / `AddSymbolRequest` /
  `tools/intent.rs::add_symbol`.
- Input: `{ project?: string; items: SymbolItem[] }` including parent component,
  source file, optional line/end_line, rich responsibilities, properties, and
  visual flag.
- Success: `ScryerAddedItemsResult` with node, property, and source-map items.
- Policy: `plan_author`, normal risk, exclusive lock, write-if-active lease,
  reads/writes planned and planned sourceMap anchors.
- Tests: rejects non-component parent; mints symbol and responsibility ids
  through shared `id-minter`; writes responsibility anchors and schema-node
  anchors keyed by minted ids; supports visual flag.

### `scryer.drift.flag`

- Upstream: `flag_drift` / `FlagDriftRequest` /
  `tools/intent.rs::flag_drift`.
- Input: `{ project?: string; node_id: string; undescribed?; new_nodes?; undescribed_properties?; stale?; stale_properties?; stale_nodes? }`.
  Upstream camelCase aliases are accepted only at the catalog input boundary and
  normalized before execution.
- Success: `{ flagged; mintedNodes; vagrantResponsibilities; staleResponsibilities; staleProperties; staleNodes }`.
- Policy: `drift_record`, high risk, exclusive lock, write-if-active lease,
  reads/writes planned,
  `maintenanceWrites: [{ target: 'history', mode: 'best_effort' }]`,
  `sideEffects: ['history_append']`.
- Tests: records vagrant responsibilities/properties, stale proposals, stale
  properties, minted vagrant node chains, and whole stale nodes; routes
  undescribed behavior to existing or newly minted homes; rejects duplicate or
  forward request-local parent keys.

### `scryer.drift.reconcile`

- Upstream: `reconcile_drift` / `ReconcileDriftRequest` /
  `tools/intent.rs::reconcile_drift`.
- Input: `{ project?: string }`.
- Success: `{ reconciledAt; commit? }`.
- Policy: `drift_reconcile`, high risk, exclusive lock,
  `semanticWrites: []`,
  `maintenanceWrites: [{ target: 'sync', mode: 'required' }, { target: 'anchor_baseline', mode: 'required' }]`,
  `sideEffects: ['sync_state_write', 'anchor_baseline_refresh']`.
- Tests: advances reconcile anchor; records current git commit when available;
  clears previously reported drift scope until newer changes occur.

### `scryer.container.fill`

- Upstream: `fill_container` / `CommitContainerModelRequest` /
  `tools/generation.rs::fill_container`.
- Input: `{ project?: string; container_id: string; components: ProposedComponent[]; links?: ProposedLink[]; groups?: ProposedGroup[] }`.
- Success: `{ containerId; componentIds; symbolIds; groupIds; droppedLinks?; findings? }`.
- Policy: `model_generate`, high risk, exclusive lock, reads committed,
  planned, and build-edge cache; `semanticWrites: ['committed', 'planned']`;
  `maintenanceWrites: [{ target: 'history', mode: 'best_effort' }]`;
  `sideEffects: ['build_edges_read', 'history_append']`; records born/history
  events. Upstream atomic generation does not refresh `model.baseline.scry`.
- Tests: commits complete component/symbol subtree in one write; preserves
  concurrent planned-only enrichment; mints ids against committed plus planned;
  rejects missing symbol coverage and duplicate local keys without writing;
  derives code links from build edges; drops illegal optional agent links without
  failing the container fill.

## Orca-Native Auxiliary Operations

No Orca-native auxiliary audit or undo/redo operations are included in this
foundation. Future auxiliary operations must be justified by Scryer model
semantics, not by generic file rollback or audit needs.

## Out Of Orca Product Scope

Do not migrate these as Native Scryer Engine operations:

- Scryer MCP transport as a product path.
- Scryer Tauri app shell.
- Standalone Scryer AI provider settings.
- Standalone Scryer docs/templates product surfaces.
- Normal-runtime pre-0.3 auto-migration.
- Direct copies or mechanical ports of upstream Rust implementation source.

Upstream remains the semantic and test reference. Orca reimplements behavior in
Orca-owned TypeScript/Node modules.

## Pipeline Implications

The catalog replaces first-slice switch dispatch.

Pipeline stages:

1. Look up the operation contract.
2. Validate `ScryerOperationContext`.
3. Validate input with `inputSchema`.
4. Resolve any branched policy into one flat policy using validated input.
5. Resolve project root.
6. Check authorization.
7. Apply lock and lease policy.
8. Load declared state and auxiliary files.
9. Run operation executor with loaded state and deterministic services.
10. If the executor returns `{ ok: false, failure }`, validate that failure
    against the operation contract and return a failure envelope through
    `error-mapper`.
11. If the executor throws unexpectedly, map the exception to `internal_error`
    through `error-mapper`.
12. Validate declared postconditions for successful executor outcomes.
13. Convert declared state changes into a commit plan and validate it against
    the resolved policy.
14. Commit declared state changes and side effects.
15. Validate success payload or error details.
16. Return the shared operation result envelope.

The state store should expose transaction-level methods rather than individual
file writes. Operation executors should receive `ScryerLoadedState` and
`ScryerOperationServices`, not `ScryerStateStore`.

## State Store Transaction Contract

`state-store` is the only module that may read or write `.scryer/*` files for
engine operations. The pipeline converts an executor's `ScryerStateChanges`
into a `ScryerStateCommitPlan`, validates that the plan is allowed by the
operation contract, then passes the plan to the state store.

Target TypeScript shape:

```ts
type ScryerStateCommitPlan = {
  operationId: ScryerOperationId
  requestId: string
  project: ResolvedScryerProject
  primary: ScryerPrimaryCommitItem[]
  bestEffort: ScryerBestEffortCommitItem[]
}

type ScryerPrimaryCommitItem =
  | { target: 'planned'; model: ScryModel }
  | { target: 'committed'; model: ScryModel }
  | { target: 'sync'; state: ScryerSyncState }
  | { target: 'anchor_baseline'; action: 'refresh' }

type ScryerBestEffortCommitItem =
  | { target: 'history'; events: ScryerHistoryEvent[] }
  | { target: 'baseline'; action: 'refresh' }
  | { target: 'sync'; state: ScryerSyncState }
  | { target: 'anchor_baseline'; action: 'refresh' }
  | { target: 'committed_source_map_reanchor'; action: 'refresh' }

type ScryerStateCommitResult = {
  warnings: ScryerOperationWarning[]
}

type ScryerStateStore = {
  loadDeclaredState(
    project: ResolvedScryerProject,
    policy: ScryerFlatOperationPolicy,
  ): Promise<ScryerLoadedState>

  commit(plan: ScryerStateCommitPlan): Promise<ScryerStateCommitResult>
}
```

The exact source file may use narrower internal helper types, but the public
module boundary must keep these responsibilities:

- `loadDeclaredState` loads only state declared by `policy.reads` and handles
  planned-layer fallback to committed state when `planned.scry` is absent.
- `commit` receives already-authorized write items. It does not decide whether
  an operation is allowed to write a target.
- The pipeline rejects any `ScryerStateChanges` target that is not declared by
  the resolved flat policy's `semanticWrites`, `maintenanceWrites`, and
  `sideEffects`.
- Operation executors never call `commit`, never read `.scryer/*` directly, and
  never decide file paths.

`ScryerStateChanges` to `ScryerStateCommitPlan` mapping:

| Executor change | Required policy declaration | Commit item |
| --- | --- | --- |
| `planned` | `semanticWrites` includes `planned` | `primary: { target: 'planned', model }` |
| `committed` | `semanticWrites` includes `committed` | `primary: { target: 'committed', model }` |
| non-empty `historyEvents` | `maintenanceWrites` includes `history` and `sideEffects` includes `history_append` | `primary` if `history` mode is `required`; otherwise `bestEffort` |
| `syncState` | `maintenanceWrites` includes `sync` and `sideEffects` includes `sync_state_write` or `seed_sync_if_absent` | `primary` if `sync` mode is `required`; otherwise `bestEffort` |
| `baseline: 'refresh'` | `maintenanceWrites` includes `baseline` and `sideEffects` includes `baseline_refresh` | `primary` if `baseline` mode is `required`; otherwise `bestEffort` |
| `anchorBaseline: 'refresh'` | `maintenanceWrites` includes `anchor_baseline` and `sideEffects` includes `anchor_baseline_refresh` or `write_anchor_baseline_if_absent` | `primary` if `anchor_baseline` mode is `required`; otherwise `bestEffort` |
| `committedSourceMapReanchor: 'refresh'` | `maintenanceWrites` includes `committed_source_map_reanchor` and `sideEffects` includes `silent_reanchor_committed_source_map` | `primary` if `committed_source_map_reanchor` mode is `required`; otherwise `bestEffort` |

Mapping rules:

- The pipeline resolves a branched policy before mapping changes. The mapping
  always uses one `ScryerFlatOperationPolicy`.
- `undefined`, `'none'`, and empty arrays produce no commit item.
- Each target may appear at most once in the generated plan. Duplicate requests
  for the same target are an executor contract violation and return
  `internal_error`.
- A change that lacks the required semantic write, maintenance write, or side
  effect declaration is an executor contract violation and returns
  `internal_error`.
- The pipeline attaches the already assigned `operationId`, `requestId`, and
  resolved project to the commit plan. Executors do not construct
  `ScryerStateCommitPlan` directly.

Commit ordering:

1. Acquire the exclusive state-store lock when the operation policy requires a
   lock or when a read operation actually performs a declared maintenance write.
2. Snapshot the current contents of every primary target that already exists.
3. Write primary items in a controlled order: committed model, planned model,
   sync state, anchor baseline.
4. If a primary write fails, restore written primary targets from the snapshot
   where possible and return `ok:false` with `io_error`.
5. After all primary writes succeed, run `bestEffort` items in deterministic
   order: baseline refresh, history append, sync seed, anchor baseline refresh,
   committed sourceMap re-anchor.
6. Convert each failed `bestEffort` item into
   `meta.warnings[{ code: 'maintenance_write_failed', target, details }]`.
7. Release the state-store lock.

Atomicity rules:

- Individual file replacements use temp-file plus rename.
- Primary commit success means later engine reads must not observe a mixed
  planned/committed state caused by an ordinary write failure.
- The first implementation does not need a transaction journal and does not
  promise recovery from process crash, OS crash, or power loss.
- `history` append and baseline refresh are not part of the primary
  all-or-nothing guarantee when their policy mode is `best_effort`.
- `required` maintenance writes are part of the primary commit group and make
  the operation fail when they cannot be written.

Failure tests must use injected write failures rather than relying on platform
permissions. Required cases:

- Primary committed write fails before planned write: committed and planned
  remain unchanged.
- Primary planned write fails after committed write: both layers read back as
  their pre-operation state.
- Required sync or anchor write fails: operation returns `ok:false`, and model
  layers remain unchanged.
- Best-effort history or baseline write fails: operation returns `ok:true` with
  `maintenance_write_failed`, and primary model changes remain visible.
- A read operation that performs a maintenance write acquires the same
  state-store lock as write operations for that commit.

## Deep Module Implementation Strategy

Broad operation coverage should be implemented through a small set of deep
engine modules. Operation files should express Scryer domain changes only; they
must not own path resolution, locks, leases, durable file writes, id minting,
transport formatting, or caller-specific compatibility behavior.

Decision record: [ADR 0025](../adr/0025-use-deep-engine-modules-for-scryer-operation-migration.md).

| Risk area | Owning module | Strategy |
| --- | --- | --- |
| Executor contract drift | `pipeline` / `operations/*` | Operation executors return only `ScryerExecutorResult<TResult>`. The pipeline owns envelopes, request ids, failure mapping, commit-plan conversion, policy validation, and state-store calls. |
| Multi-file state writes | `state-store` | Commit `semanticWrites` and `required` maintenance writes as the primary commit group. Run `best_effort` maintenance writes after the primary commit; failures become structured `meta.warnings` and do not roll back the primary commit. Use temp-file plus rename and ordinary IO failure recovery in the first implementation; do not promise process-crash or power-loss transactions. |
| Fold semantics | `diff` / `fold` | Provide one fold implementation for node, link, group, property, responsibility, sourceMap/boundary cleanup, stale flags, and vagrant markers. Planned elements upsert into committed state; planned absences fold deletions into committed state; related source entries are synchronized or deleted according to upstream behavior. |
| ID generation | `id-minter` | Mint ids against the union of committed state, planned state, and ids reserved by the current operation batch. Link ids remain deterministic from endpoints. Generation operations such as `container.fill` must not mint from committed state alone. |
| Source ownership routing | `source-router` | Route `sourceMap` and `boundaries` entries to exactly one layer based on target ownership. Return layer snapshots for state changes; never write files directly. |
| Structured errors | `error-mapper` / validators | Validators and operation executors return structured failures instead of transport text. `error-mapper` converts executor, pipeline, state-store, and unexpected failures into the shared envelope. Upstream text is behavior reference only; adapters may render human text from `code` and `details`. Error detail schemas remain zod-validated. |
| Legacy adapter migration | CLI/IPC/UI adapters | Product callers cross the engine seam through `executeOperation(...)` or `readView(...)`. Legacy Scryer files may remain compatibility scaffolding, but no adapter may own lock, lease, planned/committed, history, baseline, sourceMap, or result-envelope semantics. Adapters are the only place where legacy `C4ModelData` shapes map into `ScryModel` 0.3 shapes. |
| Deterministic tests | Engine services | Inject `clock` and request-id factories. Operation files, state-store, and parity tests use those services instead of direct time or random generation. |
| 33-operation sequencing | Implementation plan | Deliver all 33 upstream operations in one feature branch, but implement in dependency batches: catalog/pipeline/state-store first, then read/query, planned writes, source/group routing, fold, intent writers, drift/health/reconcile, generation, then representative adapters. |
| Upstream parity evidence | Engine tests | Use behavior fixtures and golden state assertions to compare Orca results against upstream semantics. Prefer state/result comparisons over source-code similarity; direct source copying remains out of scope. |
| Fixture and ownership drift | Parity loader / ownership test | Load parity fixtures only through a zod-validated loader and enforce dependency direction with a Vitest static import scanner. |

This structure is intentionally deeper than one operation file per tool. If a
module were deleted, its complexity would reappear across many operation files;
that is the signal that the module belongs behind a small engine interface.

## Upstream Parity Test Strategy

Parity tests prove that Orca preserves upstream Scryer behavior while using
Orca-owned TypeScript implementation. They do not compare source code, internal
control flow, Rust text messages, or MCP `Content::text(...)` formatting.

Use fixture-driven tests for behavior that is too cross-cutting for narrow unit
tests:

```text
src/main/scryer/engine/__fixtures__/upstream-parity/
  <operation-id>/
    <case-name>/
      case.json
      project/
        .scryer/model.scry
        .scryer/planned.scry
        ...
      expected/
        result.json
        model.scry
        planned.scry
        history.jsonl
        warnings.json
```

`case.json` records the Orca operation id, input, context flags, expected
success/failure, and upstream anchors such as `diff.rs::diff`,
`lib.rs::commit_element`, `validate.rs`, `read.rs::get_pending`,
`nodes.rs::mark_implemented`, `links.rs::add_links`, `misc.rs::set_groups`,
`intent.rs::add_component`, `generation.rs::fill_container`, or
`health.rs`. This keeps the behavior traceable without copying upstream code
into Orca tests.

Golden comparison rules:

- Compare normalized `ScryerOperationResult` values, not transport text.
- Compare structured `code`, `details`, and `path` for failures and validation
  findings. Do not compare upstream English warning strings.
- Compare final `.scryer/model.scry` and `.scryer/planned.scry` for operations
  that write semantic state.
- Compare selected maintenance files only when the operation declares those
  maintenance writes: baseline, history, sync, anchors, or build-edge reads.
- Scrub absolute paths, timestamps, request ids, and generated temporary paths
  from golden results. Preserve Scryer ids, element order, sourceMap keys,
  boundaries, stale flags, and vagrant flags.
- Golden files must be small enough to review. Large generated fixtures should
  assert selected semantic paths instead of snapshotting unrelated data.
- Intentional Orca differences, such as structured envelopes replacing MCP text
  messages, must be recorded in `case.json` under `orcaDifferenceReason` before
  the test may pass.

Parity coverage by operation family:

| Operation family | Required parity evidence |
| --- | --- |
| Read/query/rules/codebase | Structured result fixtures for overview/subtree reads, search match semantics, query predicates, rules topic lookup, and codebase tree filtering. |
| Validation and link legality | Finding/error fixtures for duplicate ids, missing references, illegal hierarchy, illegal links, coverage warnings, and anchor warnings. |
| Planned writes | Golden planned-state files proving committed state is unchanged and planned state carries the intended node/link/group/source edit. |
| SourceMap/boundary routing | Golden committed/planned files proving source entries are routed according to target element ownership. |
| Diff/pending/fold | Golden pending result plus post-fold committed/planned files for node, link, group, property, responsibility, sourceMap, stale, and vagrant cases. |
| ID minting and intent writers | Golden ids and references proving ids are minted from committed plus planned plus current batch reservations. |
| Drift/health/reconcile | Fixtures with deterministic project files, sync state, anchors, stale/vagrant markers, health rollups, and maintenance side effects. |
| Generation | Golden model/planned state for `container.fill`, including group creation, source anchors, build-edge-derived links, dropped optional links, and history behavior. |

Golden update discipline:

- Do not run broad snapshot updates as a normal development step.
- A golden change must name the upstream behavior anchor or the accepted Orca
  divergence that justifies the update.
- If upstream behavior is unclear, add a small upstream reproduction note or
  fixture comment before changing Orca behavior.
- If a parity fixture exposes a missing deep-module rule, fix the shared module
  first instead of patching a single operation around the fixture.

Parity fixture loader contract:

```ts
type ScryerParityFixtureCase = {
  operationId: ScryerOperationId
  upstreamCommit: string
  upstreamAnchors: NonEmptyArray<string>
  input: Record<string, unknown>
  context?: Record<string, unknown>
  expected: 'success' | 'failure'
  orcaDifferenceReason?: string
}

type ScryerParityFixture = {
  case: ScryerParityFixtureCase
  projectPath: string
  expectedResultPath: string
  expectedModelPath?: string
  expectedPlannedPath?: string
  expectedWarningsPath?: string
}
```

Implement `src/main/scryer/engine/upstream-parity/fixture-schema.ts` with zod
schemas for `case.json`, and `loadParityFixture(...)` as the only test helper
that reads parity cases. The loader validates that:

- `operationId` exists in the runtime catalog.
- `upstreamCommit` is present and non-empty.
- `upstreamAnchors` is non-empty.
- `expected: 'success'` has `expected/result.json` with an `ok:true` envelope.
- `expected: 'failure'` has `expected/result.json` with an `ok:false` envelope.
- Any accepted Orca divergence has a non-empty `orcaDifferenceReason`.
- Expected model files are present only when the operation declares the matching
  semantic or maintenance writes.

Parity tests must call `loadParityFixture(...)` instead of reading fixture files
directly, so fixture schema drift fails at the parity seam.

## Implementation Readiness Gate

Historical gate: the broad 33-operation migration was gated on the engine
foundation being green. That gate has since been satisfied; it kept operation
files focused on domain changes and prevented catalog, state, validation, id,
fold, and parity rules from being reimplemented per operation.

The gate passes only when all of the following are true:

- `UPSTREAM_SCRYER_OPERATION_IDS` or equivalent machine-readable coverage list
  contains the 33 upstream operations in this PRD.
- The runtime catalog registers all 33 operation ids with capability, risk,
  lock policy, lease policy, transport allow-list, read/write policy,
  maintenance writes, side effects, zod input schema, zod success schema,
  declared operation errors, and upstream anchors.
- The schema field matrix has been converted into zod input and success schemas,
  including shared helper schemas for nested request objects.
- Shared success result types have zod schemas and focused tests; operation
  success schemas compose those shared schemas instead of redefining complex
  nested payloads.
- Catalog tests prove every registered operation has a valid contract and every
  upstream operation is either implemented in this PRD's final target or
  explicitly excluded. For this PRD, excluded/postponed entries must be zero.
- Pipeline tests prove input validation, executor failure mapping, unexpected
  exception mapping, success validation, error-detail validation, warning
  validation, undeclared-error rejection, common error envelopes, lock
  enforcement, lease enforcement, and best-effort warning behavior.
- `error-mapper` tests prove executor, pipeline, state-store, and unexpected
  exception failures all produce valid `ScryerOperationResult` envelopes and
  zod-validated error details.
- `state-store` tests prove committed/planned fallback, primary commit grouping,
  required maintenance failure behavior, best-effort maintenance warnings, and
  no partial visible state after injected IO failures.
- Shared validator tests cover every declared `ScryerValidationFindingCode` at
  least once and representative operation guards for blocking mode.
- `id-minter` tests prove ids are minted from committed state, planned state,
  and current batch reservations, while raw set operations validate supplied ids
  without rewriting them.
- `diff/fold` tests cover node, link, group, property, responsibility,
  sourceMap, boundary, stale marker, and vagrant marker behavior before
  operation files call fold for committed-changing work.
- Upstream parity fixture harness exists, and each operation family has at
  least one fixture/golden case before that family is expanded.
- The first seven operations still pass through the catalog/pipeline path.
- CLI/IPC/UI adapters have not gained ownership of `.scryer` path resolution,
  planned/committed state, locks, leases, validation, result envelopes,
  history, baseline, sync, anchors, or sourceMap routing.
- No audit, undo, redo, save, or recovery storage exists in the engine
  foundation.

After the gate passes, implement operation families in the dependency order
below. If a later operation exposes a missing cross-cutting rule, add that rule
to the owning foundation module and its gate tests before continuing the family.

### Readiness Test Suite Map

The readiness gate maps to named test files so every foundation rule has a
stable verification home.

| Test file | Required coverage |
| --- | --- |
| `src/main/scryer/engine/catalog.test.ts` | 33 operation ids, unique registration, capability/risk/policy/schema/error/anchor completeness, no postponed upstream operations. |
| `src/main/scryer/engine/pipeline.test.ts` | Unknown operation id, input normalization, alias conflicts, executor failure mapping, unexpected exception mapping, success validation, error detail validation, warning validation, lock/lease policy, side-effect authorization, result envelopes. |
| `src/main/scryer/engine/error-mapper.test.ts` | Executor failure, pipeline failure, state-store failure, unexpected exception, malformed details, undeclared error code, and result envelope construction. |
| `src/main/scryer/engine/state-store.test.ts` | Project resolution, Scryer 0.3 rejection, planned fallback, single-home planned seed, exclusive lock, primary commit grouping, required maintenance failures, best-effort warnings, injected IO failure recovery. |
| `src/main/scryer/engine/validators.test.ts` | Every `ScryerValidationFindingCode`, warning mode, blocking mode, link legality, group integrity, sourceMap and boundary integrity, semantic path formatting. |
| `src/main/scryer/engine/id-minter.test.ts` | Node, responsibility, group, and link id allocation from committed state, planned state, and current batch reservations. Raw set operations validate supplied ids without rewriting them. |
| `src/main/scryer/engine/diff-fold.test.ts` | Diff identity and fold behavior for nodes, links, groups, properties, responsibilities, sourceMap, boundaries, stale markers, and vagrant markers. |
| `src/main/scryer/engine/source-router.test.ts` | `sourceMap` and `boundaries` entries route to committed or planned according to target element ownership and clear the non-owning layer. |
| `src/main/scryer/engine/adapters/legacy-c4.test.ts` | Field-by-field `C4ModelData` to `ScryModel` mapping, legacy-only view fields kept outside `ScryModel`, no cross-boundary object spread. |
| `src/main/scryer/engine/adapters/cli.test.ts` | CLI flags and JSON input normalize before `executeOperation(...)`; exit code follows `ok`, not `meta.warnings`. |
| `src/main/scryer/engine/adapters/ipc.test.ts` | IPC payloads call engine operations through the public seam and do not own state semantics. |
| `src/main/scryer/engine/upstream-parity/*.test.ts` | Fixture/golden behavior comparison for each operation family against recorded upstream anchors and accepted Orca differences. |
| `src/main/scryer/engine/architecture-ownership.test.ts` | Forbidden dependency checks for adapters, renderer code, operation files, `state-store`, and legacy scaffolding. |
| `src/main/scryer/engine/operations/*.test.ts` | Operation-specific domain behavior after shared catalog, pipeline, state-store, validator, id, and fold tests cover cross-cutting rules. |

`architecture-ownership.test.ts` first implementation should use a Vitest
static import scanner built on the TypeScript compiler API already available in
the repo. Do not add `dependency-cruiser` or a new lint dependency for the first
version. The scanner reads `import` declarations and `export ... from`
declarations, resolves relative imports to normalized repo paths, and enforces
these rules:

- Product callers and adapters may import `src/main/scryer/engine/index.ts` or
  adapter wrappers, but not engine internals such as `state-store`, `fold`,
  `id-minter`, `source-router`, `error-mapper`, or individual operation files.
- Operation files may import model types, schema helpers, validators, diff/fold
  interfaces, and pure helpers. They must not import `state-store`, adapters,
  `error-mapper`, IPC, CLI, renderer code, `model-store`, or `mcp-tools`.
- `state-store` may import model, paths, and pure serialization helpers. It must
  not import operation files, adapters, renderer code, CLI code, or legacy
  model-store modules.
- Legacy scaffolding may call the engine public seam during migration, but it
  must not import catalog, pipeline, state-store, source-router, diff/fold,
  id-minter, or operation internals.

## Implementation Plan

Deliver all 33 upstream Scryer operations in one feature branch. Implement them
in dependency-ordered batches for testability, but the accepted end state is
33/33 implemented operations, not a partially postponed catalog.

1. Add `catalog.ts`, `UPSTREAM_SCRYER_OPERATION_IDS`, and operation coverage
   tests for the full 33-operation upstream public surface.
2. Register all 33 contracts with operation ids, capability, risk, zod input
   schemas, zod success schemas, declared errors, policy, upstream anchors, and
   transport metadata.
3. Replace first-slice switch dispatch with catalog lookup.
4. Enforce input schema validation.
5. Enforce success payload and error detail validation.
6. Implement structured warning validation and operation result-envelope
   validation, including `meta.warnings`.
7. Move lock, lease, layer reads, semantic writes, maintenance writes, baseline,
   history, sync, and anchor effects behind declared policy.
8. Implement state-store transaction commits for semantic writes and required
   maintenance writes, then best-effort maintenance warnings.
9. Implement shared `id-minter`, validators, error mapping, and diff/fold
   primitives before broad operation migration.
10. Add upstream parity fixture harnesses and at least one golden case for each
   operation family before expanding that family.
11. Run the implementation readiness gate and keep it green before expanding
   beyond foundation work.
12. Implement read/query/validate/health/pending/rules/codebase operations.
13. Implement planned structural writes: node, link, and group operations; then
   implement sourceMap/boundary routing as `source_author`, not as a planned
   write shortcut.
14. Implement intent writers: person, system, container, component, group, and
   symbol adds.
15. Implement committed-changing and high-risk operations: fold, descope,
   drift detect/flag/reconcile, model set, and container fill.
16. Keep the state store focused on committed/planned/source/history/sync/
   anchors/build-edge files; do not add `.scryer/audit.jsonl` or `.scryer/undo`
   storage.
17. Implement transaction-level state-store commits so declared writes are
   all-or-nothing from the operation caller's perspective.
18. Expand diff/fold coverage for groups, properties, source anchors, and stale/
   vagrant drift markers before broad operation migration.
19. Add CLI/IPC adapters only after the engine-level 33-operation catalog tests
   and operation behavior tests are green.
20. Keep Architecture UI semantic migration out of this engine batch except for
   minimal adapter smoke paths needed to prove the engine seam. Existing legacy
   UI paths must keep working until a later intent-by-intent migration.

## Test Plan

Catalog tests:

- The implementation readiness gate has a named test or test suite that fails
  until every foundation prerequisite above is satisfied.
- Every operation id is unique and registered once.
- The upstream operation coverage test lists the 33 upstream public tools from
  this PRD and asserts each is either registered in the catalog or explicitly
  marked postponed/excluded with a reason.
- This PRD's implementation target is stricter than the generic coverage
  mechanism: the final catalog must have all 33 upstream operations registered
  and implemented, with no postponed/excluded entries.
- Keep that coverage list machine-readable in test/code, not only in this
  markdown document. The first implementation may define a constant such as
  `UPSTREAM_SCRYER_OPERATION_IDS`; it does not need to parse the PRD.
- Every operation has `inputSchema`, `successSchema`, declared errors, policy,
  risk, and upstream anchors.
- Every operation's `inputSchema` and `successSchema` cover the fields declared
  in the schema field matrix, including defaults, accepted upstream input
  aliases, canonical normalization, and alias/canonical conflict rejection.
- Executor tests prove operation executors receive only canonical input fields;
  input aliases such as `endLine`, `newNodes`, `nodeId`, and `parentKey` do not
  appear after pipeline normalization.
- Shared complex success schemas are tested once and reused by operation
  success schemas: read view, validation result, pending/fold result, intent
  added items, health report, drift scope result, and generation result.
- Every declared error code exists in the structured error taxonomy.
- Every error code in the taxonomy has exactly one zod detail schema, including
  codes whose details are `undefined`.
- Capability defaults and explicit policy are internally consistent.
- Risk defaults are not inferred from capability; each operation declares
  `normal`, `destructive`, or `high` explicitly.
- Risk/policy consistency is enforced: high-risk operations require exclusive
  lock when writing `.scryer` state.
- No operation declares approval-gate policy.
- High-risk operations do not require audit reason, audit storage, save storage,
  or default UI prompts.
- Every operation declares a non-empty transport allow-list; omitted transports
  are never treated as "all transports allowed."
- Production operation contracts do not include `test` transport by default;
  test-only operations may use it in test catalogs.
- No operation declares committed writes without exclusive lock unless explicitly
  exempted by a test-named policy.
- No operation declares audit or undo/redo side effects, and no operation writes
  `.scryer/audit.jsonl` or `.scryer/undo`.
- Catalog/state-store code does not implement save or recovery workflows.
- Operation files do not perform file IO; all durable writes pass through the
  state-store transaction commit path.

Pipeline tests:

- Unknown operation id returns `operation_not_found`.
- Invalid input returns `invalid_input` with `fieldErrors`.
- Malformed success payload returns `internal_error`.
- Declared error with malformed details returns `internal_error`.
- Undeclared operation-level error returns `internal_error`.
- Pipeline-owned common errors use the shared taxonomy detail schemas and do not
  require per-operation declarations.
- Operation-owned domain errors must use the shared taxonomy detail schemas
  rather than operation-local ad hoc detail objects.
- Agent-completion mode without trusted active run context returns
  `agent_run_required`.
- Write operations still enforce lock and active edit lease.
- Failed `best_effort` maintenance writes keep `ok: true` and append structured
  `meta.warnings`.
- Malformed `meta.warnings` entries return `internal_error`.
- Unknown warning codes return `internal_error`.
- Unknown `sideEffects` enum values fail catalog/pipeline contract validation.
- `sideEffects` without the required `maintenanceWrites`, `reads`, or lease
  policy fail catalog/pipeline contract validation.
- Failed `required` maintenance writes return a structured operation error.
- Engine writes do not create audit, undo, redo, save, or recovery files.
- Multi-file writes are all-or-nothing from the operation caller's perspective:
  injected IO failures do not leave a partially advanced planned/committed
  state visible through the engine.

Operation behavior tests scale by risk and side effects rather than requiring
the same number of tests per operation:

- Read/query/rules/codebase operations: 2-4 focused tests each.
- Planned write operations: 3-5 focused tests each.
- SourceMap, fold, drift, health, model set, and container fill operations:
  5-8 focused tests each, with extra coverage for side effects and no-partial
  write behavior.
- Each operation family must include upstream parity fixtures as described in
  the parity strategy section. Narrow unit tests may cover local branches, but
  at least one fixture/golden case must prove the family against upstream
  behavior anchors.
- Catalog and pipeline tests cover shared schema, policy, lock/lease, envelope,
  and coverage invariants once, instead of duplicating them in every operation
  test.

Adapter tests:

- Add minimal CLI/IPC mapping tests for representative read, planned write, and
  committed-changing operations after engine tests are green.
- CLI tests verify exit code follows `ok`, not `meta.warnings`: `ok:true` with
  warnings exits `0`, while `ok:false` exits non-zero.
- Do not require broad Architecture UI migration in this PRD. Existing UI paths
  should remain compatible while later adapters move UI intents to
  `executeOperation(...)` and `readView(...)`.
- The first implementation does not claim database-grade crash or power-loss
  recovery across multiple files.

Migration tests:

- Existing seven first-slice operation tests continue to pass through the
  catalog path.
- New operations use temp project directories with real `.scryer` files.
- Transport tests verify command/IPC mapping only and do not duplicate Scryer
  semantics.
