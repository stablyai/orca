# Orca Scryer Operation Migration Issue Slices

These were implementation-ready issue drafts for the Native Scryer Engine
operation migration work set. The operation migration and follow-up #26-#29
product-integration slices carried the stable Architecture product path through
the engine seam and live UI coverage, and #36 has closed the current
Architecture slice release gate from the #30 audit. Full operation parity is not
complete: some operation rows in the 33-operation catalog remain
contract-only and still need executors, adapter wiring, and tests through
decision map #31-#35.

This file is retained as historical planning context and a parity reference,
not as proof that every slice below is already executable.

Do not publish these slices as new unchecked issues without first revalidating
them against the current decision map and code. Current follow-up issue
boundaries are #31-#35 in `docs/orca-scryer-decision-map.md`.

## Parent

- GitHub parent PRD: https://github.com/Nikolatesla-lj/orca/issues/23
- Decision map coverage: `docs/orca-scryer-decision-map.md` #16-#24
- Work-set PRD: `docs/prd/orca-scryer-operation-migration-work-set.md`

## Shared Rules For Every Slice

Every implementation issue below inherits these rules.

### Source docs every agent must read

- `docs/orca-scryer-decision-map.md`
  - #15 "What Shared Foundation Must Expand Before Broad Operation Coverage?"
  - #16-#24 for the relevant operation family and migration safety rules
- `docs/prd/orca-scryer-operation-migration-work-set.md`
  - "Operation-Family Slices"
  - "Slice Completion Definition"
  - the operation-family section named by the issue
  - "Safe Broad Operation Migration Decision"
  - "Implementation Blueprint For Code Generation"
  - "Normative Language"
  - "Deep Module Interface Drafts"
  - "Catalog Matrix Requirements"
  - "Minimum Operation Test Checklist"
  - "Canonical Error Code Registry"
  - "Success Payload Field Contracts"
  - "Upstream Parity Fixture Format"
  - "Adapter Migration Mapping"
  - "UI Live Test Scenarios"
  - "Implementation Issue Slice Template"
- `docs/prd/orca-scryer-engine-catalog-foundation.md`
  - "Engine Foundation Interface Contract"
  - "Runtime Schema Rules"
  - "Structured Error Taxonomy"
  - "Catalog Contract Matrix"
  - "Schema, Error, And Upstream Anchor Matrix"
  - "Schema Field Matrix"
  - "State Store Transaction Contract"
  - "Deep Module Implementation Strategy"
  - "Upstream Parity Test Strategy"
  - "Implementation Readiness Gate"
  - "Readiness Test Suite Map"
- `docs/adr/0025-use-deep-engine-modules-for-scryer-operation-migration.md`
- `docs/adr/0026-use-a-shared-scryer-read-surface.md` when the slice touches read/query or adapters
- `CONTEXT.md` for project vocabulary

### Verification baseline

Each slice should run the narrow tests it adds plus the relevant baseline:

```bash
corepack pnpm exec vitest run --config config/vitest.config.ts src/main/scryer/engine/*.test.ts src/main/scryer/engine/**/*.test.ts
corepack pnpm exec vitest run --config config/vitest.config.ts src/main/scryer/model-store.test.ts src/main/scryer/mcp-tools.test.ts src/main/ipc/architecture.test.ts
corepack pnpm run tc:node
git diff --check
```

If the slice touches CLI, also run:

```bash
corepack pnpm run tc:cli
corepack pnpm exec vitest run --config config/vitest.config.ts src/cli/**/*.test.ts
```

If the slice touches UI live behavior, also run the focused Electron Playwright
specs it adds through `pnpm run test:e2e` or the repo's focused Playwright
command pattern.

### Global forbidden changes

- Do not copy upstream Rust implementation source into Orca runtime.
- Do not add operation-local file IO, state semantics, lock handling, result
  envelopes, id scanning, source routing, fold rules, or transport formatting.
- Do not add a second catalog or transport-specific operation contract.
- Do not preserve legacy fallback for a cataloged operation.
- Do not broaden scope into audit, undo, redo, save, recovery storage, Scryer
  MCP server, Scryer Tauri shell, provider UI, template marketplace, or Rust
  sidecar runtime.

---

## Slice 1: Align Scryer Engine Codegen Contract Scaffolding

### Parent

- https://github.com/Nikolatesla-lj/orca/issues/23

### What to build

Prepare the Native Scryer Engine for broad operation migration by aligning the
runtime code with the implementation blueprint. This slice does not migrate a
new operation family. It creates the shared code-generation scaffolding that
later slices must reuse: public module file targets, planner result types,
loaded-state contract checks, canonical public error and warning registries,
success payload helper types, parity fixture directory-loader support, and
tests that prevent operation-local reinvention.

### Source docs to cite in the implementation

- `docs/prd/orca-scryer-operation-migration-work-set.md`
  - "Implementation Blueprint For Code Generation"
  - "Normative Language"
  - "Deep Module Interface Drafts"
  - "Catalog Matrix Requirements"
  - "Canonical Error Code Registry"
  - "Success Payload Field Contracts"
  - "Upstream Parity Fixture Format"
  - "Implementation Issue Slice Template"
- `docs/prd/orca-scryer-engine-catalog-foundation.md`
  - "Engine Foundation Interface Contract"
  - "Runtime Schema Rules"
  - "Structured Error Taxonomy"
  - "State Store Transaction Contract"
  - "Upstream Parity Test Strategy"
  - "Implementation Readiness Gate"
- `docs/adr/0025-use-deep-engine-modules-for-scryer-operation-migration.md`
- `CONTEXT.md`
  - `Scryer Operation Catalog`
  - `Scryer Operation Result Envelope`
  - `Scryer Error Mapper`
  - `Scryer State Commit Plan`
  - `Scryer Parity Fixture Loader`

### Files to inspect first

- `src/main/scryer/engine/types.ts`
- `src/main/scryer/engine/schemas.ts`
- `src/main/scryer/engine/catalog.ts`
- `src/main/scryer/engine/pipeline.ts`
- `src/main/scryer/engine/error-mapper.ts`
- `src/main/scryer/engine/state-store.ts`
- `src/main/scryer/engine/parity-fixtures.ts`
- `src/main/scryer/engine/parity-fixtures.test.ts`
- `src/main/scryer/engine/architecture-ownership.test.ts`

### Implementation scope

- Add public module shell files and exported interfaces/factories required by the blueprint:
  - `src/main/scryer/engine/read-selector.ts`
  - `src/main/scryer/engine/structural-planner.ts`
  - `src/main/scryer/engine/group-planner.ts`
  - `src/main/scryer/engine/intent-planner.ts`
  - `src/main/scryer/engine/drift-planner.ts`
  - `src/main/scryer/engine/health-reporter.ts`
  - `src/main/scryer/engine/container-generation-planner.ts`
- Align `ScryerLoadedState` and planner result types with the rule that the
  pipeline/state-store loads catalog-declared state before planner execution.
- Align public `ScryerOperationErrorCode` with the canonical registry:
  `invalid_input`, `invalid_context`, `incompatible_model`, `io_error`,
  `lock_busy`, `lease_required`, `operation_not_found`, `internal_error`,
  `not_found`, `illegal_link`, `validation_failed`, and
  `agent_run_required`.
- Extend warning code/schema support for the warning codes required by later
  slices while keeping warning objects in `ScryerOperationResult.meta.warnings`.
- Add shared success payload helper types such as `ScryerRecommendedNextRead`
  and common count/id summary shapes.
- Upgrade the parity fixture loader so new fixtures can use the canonical case
  directory layout while retaining flat `case.json` support only for existing
  bootstrap tests.
- Add ownership tests that fail if operation executors or adapters import
  modules they must not own.

### Acceptance criteria

- [ ] Public module files exist and export only the intended small interfaces,
  factories, and public input/result types.
- [ ] Planner interfaces do not include file IO, lock, lease, path resolution,
  result-envelope, or transport concerns.
- [ ] Missing catalog-declared loaded state is treated as an engine contract
  violation and maps through `internal_error`, not planner-local file reads.
- [ ] Public error codes use the canonical registry; rejected aliases such as
  `incompatible_model_version`, `lock_conflict`, `lease_conflict`,
  `operation_not_cataloged`, and `legacy_fallback_forbidden` are not added as
  public `error.code` values.
- [ ] Warning objects validate through the shared warning schema and are carried
  only in `ScryerOperationResult.meta.warnings`.
- [ ] New parity fixtures can be loaded from
  `src/main/scryer/engine/__fixtures__/upstream-parity/<operation>/<case>/`.
- [ ] Tests prove broad operation slices can depend on this scaffolding without
  adding operation-local substitutes.

### Blocked by

- None - can start immediately after the current engine foundation is green.

---

## Slice 2: Migrate Read Surface And Query Operations

### Parent

- https://github.com/Nikolatesla-lj/orca/issues/23

### What to build

Replace the foundation-era read shape with the formal Scryer Read Surface and
migrate the remaining read/query operations through `ScryerReadSelector`.
`readView(...)`, CLI, IPC, UI adapters, and tests must consume selector payloads
instead of constructing overview, subtree, search, query, rules, or codebase
views from raw model files.

### Operations

- `scryer.model.read` result upgrade
- `scryer.model.search`
- `scryer.model.query`
- `scryer.rules.read`
- `scryer.codebase.read`

### Source docs to cite in the implementation

- `docs/orca-scryer-decision-map.md`
  - #16 "How Should Read And Query Operations Migrate?"
  - #24 "How Should The 33-Operation Migration Be Implemented Safely?"
- `docs/prd/orca-scryer-operation-migration-work-set.md`
  - "Read Surface Decision"
  - "Upstream Read Strategy To Preserve"
  - "Read Mode Selection Policy"
  - "Overview Payload Requirements"
  - "Success Payload Field Contracts"
  - "Adapter Migration Mapping"
  - "Minimum Operation Test Checklist"
- `docs/adr/0026-use-a-shared-scryer-read-surface.md`
- `docs/prd/orca-scryer-engine-catalog-foundation.md`
  - "Operation Migration Matrix"
  - "Catalog Policy Matrix"
  - "Schema, Error, And Upstream Anchor Matrix"
  - "Schema Field Matrix"
  - operation cards for `scryer.model.read`, `scryer.model.search`,
    `scryer.model.query`, `scryer.rules.read`, and `scryer.codebase.read`
- Upstream anchors:
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-mcp/src/tools/read.rs`
  - request types in `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-mcp/src/types.rs`

### Files to inspect first

- `src/main/scryer/engine/read-selector.ts`
- `src/main/scryer/engine/operations/model-read.ts`
- `src/main/scryer/engine/model-read.test.ts`
- `src/main/scryer/engine/catalog.ts`
- `src/main/scryer/engine/schemas.ts`
- `src/main/scryer/engine/index.ts`
- `src/main/ipc/architecture.ts`
- `src/cli/handlers/scryer.ts`
- `src/cli/specs/scryer.ts`

### Implementation scope

- Implement `ScryerReadSelector` as the single engine module for overview,
  subtree, explicit full, search, query, rules, and codebase read payloads.
- Update catalog rows, zod input schemas, success schemas, declared errors, and
  upstream anchors for all operations in this slice.
- Update `readView(...)` so it is a real read facade, not a thin alias around
  the provisional `model.read` result.
- Ensure overview is the default, subtree is the normal drill-down mode, full
  remains explicit, and full is not an implicit fallback.
- Ensure overview payloads include ids, breadcrumbs, counts, hidden-symbol
  indicators, source/boundary/link coverage, and `recommendedNextReads`.
- Add parity fixtures and golden cases for overview, subtree, full, search,
  query, rules topic/index reads, and codebase tree filtering.
- Add adapter tests that prove CLI/IPC/UI callers consume read selector payloads.

### Acceptance criteria

- [ ] `readView(...)` returns formal Read Surface payloads for overview and
  subtree reads.
- [ ] `scryer.model.read` no longer exposes the provisional foundation-era
  result shape to product callers.
- [ ] `scryer.model.search` and `scryer.model.query` return structured hits,
  truncation state, paths, counts, and next-read hints.
- [ ] `scryer.rules.read` and `scryer.codebase.read` use catalog schemas and
  result validation.
- [ ] Adapters do not generate read payloads from raw model files.
- [ ] Explicit full reads remain supported for export, debug, compatibility,
  fixture, cross-subtree restructuring, and direct user-request cases.
- [ ] Focused tests cover default overview, subtree drill-down, explicit full,
  not-found, truncation/hidden counts, and adapter mapping.

### Blocked by

- Slice 1: Align Scryer Engine Codegen Contract Scaffolding

---

## Slice 3: Implement Structural Mutation Planner Operations

### Parent

- https://github.com/Nikolatesla-lj/orca/issues/23

### What to build

Implement core structural writes through `ScryerStructuralMutationPlanner` so
operation files express intent and the planner owns atomic mutation planning,
identity rules, cleanup, hard-error versus warning classification, and handoff
to validators, source-router, diff/fold, and state-store.

### Operations

- `scryer.model.set`
- `scryer.node.set-subtree`
- `scryer.node.delete`
- `scryer.node.move`
- `scryer.node.descope`
- `scryer.responsibility.move`
- `scryer.link.update`

### Source docs to cite in the implementation

- `docs/orca-scryer-decision-map.md`
  - #17 "How Should Core Structural Writes Migrate?"
  - #23 "What Stays Out Of The Operation Migration?"
  - #24 "How Should The 33-Operation Migration Be Implemented Safely?"
- `docs/prd/orca-scryer-operation-migration-work-set.md`
  - "Core Structural Write Decision"
  - "Replacement Operations"
  - "Planned Structural Semantics"
  - "Atomicity And Cleanup"
  - "Canonical Error Code Registry"
  - "Success Payload Field Contracts"
  - "Minimum Operation Test Checklist"
- `docs/prd/orca-scryer-engine-catalog-foundation.md`
  - "Diff And Fold Semantics"
  - "ID Minting Semantics"
  - operation cards for the structural operations listed above
  - "Catalog Policy Matrix"
  - "Schema Field Matrix"
- `docs/adr/0025-use-deep-engine-modules-for-scryer-operation-migration.md`
- Upstream anchors:
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-mcp/src/tools/nodes.rs`
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-mcp/src/tools/links.rs`
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-core/src/lib.rs`
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-core/src/diff.rs`
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-core/src/validate.rs`

### Files to inspect first

- `src/main/scryer/engine/structural-planner.ts`
- `src/main/scryer/engine/fold.ts`
- `src/main/scryer/engine/diff.ts`
- `src/main/scryer/engine/validators.ts`
- `src/main/scryer/engine/source-router.ts`
- `src/main/scryer/engine/operations/link-add.ts`
- `src/main/scryer/engine/operations/link-delete.ts`
- `src/main/scryer/engine/operations/node-update.ts`
- `src/main/scryer/engine/plan-operations.test.ts`
- `src/main/scryer/engine/link-operations.test.ts`

### Implementation scope

- Add catalog rows, schemas, success payloads, error details, and upstream
  anchors for all structural operations.
- Implement `ScryerStructuralMutationPlanner` with no private IO or direct
  state-store commits.
- Keep `model.set` and `node.set-subtree` available as high-risk structural
  replacement/generation primitives, not default interactive editing paths.
- Preserve ids for `node.move` and `responsibility.move`; move source anchors
  with responsibility ids.
- Make `link.update` endpoint-immutable; endpoint changes require delete plus
  add.
- Enforce hard failures for malformed structure, schema version mismatch,
  duplicate ids, missing parents, illegal hierarchy, missing endpoints, and
  source/group references that would break engine invariants.
- Return non-blocking warnings through `meta.warnings`.

### Acceptance criteria

- [ ] Batch structural writes validate the whole requested mutation before any
  durable write occurs.
- [ ] Hard failures leave committed, planned, source, boundary, group, and link
  state unchanged.
- [ ] `node.move` preserves node id, subtree identity, and legal hierarchy.
- [ ] `responsibility.move` preserves responsibility id and source anchors.
- [ ] `link.update` rejects endpoint mutation.
- [ ] `model.set` and `node.set-subtree` are cataloged as high-risk operations.
- [ ] Tests cover success, hard errors, warnings, atomicity, cleanup, and no
  legacy fallback.

### Blocked by

- Slice 1: Align Scryer Engine Codegen Contract Scaffolding
- Slice 2: Migrate Read Surface And Query Operations

---

## Slice 4: Implement Source Routing And Group Ownership Operations

### Parent

- https://github.com/Nikolatesla-lj/orca/issues/23

### What to build

Migrate source anchor, boundary, and group ownership operations through
`ScryerSourceRouter` and `ScryerGroupOwnershipPlanner`. Source routing must
centralize single-home committed/planned ownership. Group operations must be
semantic model edits, not renderer overlays or node status management.

### Operations

- `scryer.source.update`
- `scryer.group.set`
- `scryer.group.update`
- `scryer.group.delete`

### Source docs to cite in the implementation

- `docs/orca-scryer-decision-map.md`
  - #18 "How Should Source And Group Ownership Migrate?"
  - #24 "How Should The 33-Operation Migration Be Implemented Safely?"
- `docs/prd/orca-scryer-operation-migration-work-set.md`
  - "Source And Group Ownership Decision"
  - "Source Router"
  - "Group Ownership Planner"
  - "Canonical Error Code Registry"
  - "Success Payload Field Contracts"
  - "Minimum Operation Test Checklist"
- `docs/prd/orca-scryer-engine-catalog-foundation.md`
  - "Current Code Migration Boundary"
  - "State Store Transaction Contract"
  - "Diff And Fold Semantics"
  - operation cards for source/group operations
  - "Schema Field Matrix"
- `CONTEXT.md`
  - `Scryer Source Router`
  - `Scryer Group`
  - `Scryer Group Ownership Planner`
- Upstream anchors:
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-mcp/src/tools/misc.rs`
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-core/src/lib.rs`
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-core/src/validate.rs`

### Files to inspect first

- `src/main/scryer/engine/source-router.ts`
- `src/main/scryer/engine/group-planner.ts`
- `src/main/scryer/engine/id-minter-source-router.test.ts`
- `src/main/scryer/engine/validators.ts`
- `src/main/scryer/engine/state-store.ts`
- `src/main/scryer/engine/schemas.ts`
- `src/main/scryer/engine/catalog.ts`

### Implementation scope

- Extend `ScryerSourceRouter` to plan committed versus planned sourceMap and
  boundary writes according to target ownership.
- Implement `ScryerGroupOwnershipPlanner` for group set, patch, delete, nesting,
  membership, responsibilities, and child-group detach behavior.
- Enforce strict group validation: valid parent node, direct-child membership,
  same-level members, no cycles, known parentGroupId, no duplicate group
  responsibility ids.
- Keep `group.set` available as a high-risk generation/fixture/migration/repair
  primitive.
- Keep `group.update` patch-only; do not allow group re-parenting.
- Make `group.delete` delete only the group, keep member nodes, and detach
  direct child groups.

### Acceptance criteria

- [ ] Source entries for committed elements write committed state and clear stale
  planned shadows.
- [ ] Source entries for planned-only elements write planned state.
- [ ] Empty source lists clear entries from the owning layer.
- [ ] Missing target ids, malformed input, and same-key conflicts fail without
  writes.
- [ ] Source quality issues can succeed with structured `meta.warnings`.
- [ ] Group validation rejects malformed raw group data, mixed-level members,
  missing parent nodes, unknown members, cycles, and duplicate ids.
- [ ] Renderer group overlays do not own model semantics.
- [ ] Tests cover planner seams, state routing, warnings, hard errors, and
  no-partial writes.

### Blocked by

- Slice 1: Align Scryer Engine Codegen Contract Scaffolding
- Slice 3: Implement Structural Mutation Planner Operations

---

## Slice 5: Implement Intent Authoring Operations

### Parent

- https://github.com/Nikolatesla-lj/orca/issues/23

### What to build

Migrate typed authoring operations through `ScryerIntentAuthoringPlanner` so
agents and UI callers add model elements by expressing intent rather than
submitting raw model JSON. The planner must mint ids, fix element kind from the
operation name, validate parent rules, construct responsibilities, route source
and boundary effects, and author planned state atomically.

### Operations

- `scryer.person.add`
- `scryer.system.add`
- `scryer.container.add`
- `scryer.component.add`
- `scryer.group.add`
- `scryer.symbol.add`

### Source docs to cite in the implementation

- `docs/orca-scryer-decision-map.md`
  - #19 "How Should Intent Writer Operations Migrate?"
  - #24 "How Should The 33-Operation Migration Be Implemented Safely?"
- `docs/prd/orca-scryer-operation-migration-work-set.md`
  - "Intent Authoring Decision"
  - "Source And Group Ownership Decision"
  - "Success Payload Field Contracts"
  - "Canonical Error Code Registry"
  - "Minimum Operation Test Checklist"
- `docs/prd/orca-scryer-engine-catalog-foundation.md`
  - "ID Minting Semantics"
  - operation cards for the six intent add operations
  - "Schema Field Matrix"
  - "Catalog Policy Matrix"
- `CONTEXT.md`
  - `Scryer Intent Authoring Planner`
  - `Scryer ID Minter`
  - `Scryer Source Router`
- Upstream anchors:
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-mcp/src/tools/intent.rs`
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-mcp/src/types.rs`

### Files to inspect first

- `src/main/scryer/engine/intent-planner.ts`
- `src/main/scryer/engine/id-minter.ts`
- `src/main/scryer/engine/source-router.ts`
- `src/main/scryer/engine/group-planner.ts`
- `src/main/scryer/engine/schemas.ts`
- `src/main/scryer/engine/catalog.ts`
- `src/main/scryer/engine/id-minter-source-router.test.ts`

### Implementation scope

- Add catalog rows, schemas, success payloads, error details, and upstream
  anchors for typed add operations.
- Implement intent authoring with shared id minting against committed state,
  planned state, and current batch reservations.
- Reject caller-supplied ids and caller-supplied kind for ordinary adds.
- Enforce parent-kind rules per operation name.
- Route symbol anchors and container boundaries through `ScryerSourceRouter`.
- Reuse group ownership validation for `scryer.group.add`.
- Return `ScryerAddedItemsResult` with minted ids, kind, name, parent ids,
  responsibility ids, property labels, source keys, boundary keys, counts, and
  `recommendedNextReads`.

### Acceptance criteria

- [ ] Multi-item intent add requests are atomic.
- [ ] Hard errors prevent all node, group, responsibility, sourceMap, and
  boundary writes.
- [ ] Ordinary node/group add inputs accept plain responsibility strings.
- [ ] `symbol.add` accepts string or line-precise responsibility entries.
- [ ] `external` is accepted only by `system.add` and `container.add`.
- [ ] Blank names, invalid parents, invalid group members, blank symbol
  `sourceFile`, and blank property labels fail predictably.
- [ ] Quality gaps such as missing descriptions or broad source patterns return
  `meta.warnings` where allowed.
- [ ] Tests prove no caller-supplied ids, no operation-local id scanning, and no
  legacy fallback.

### Blocked by

- Slice 1: Align Scryer Engine Codegen Contract Scaffolding
- Slice 4: Implement Source Routing And Group Ownership Operations

---

## Slice 6: Implement Drift And Health Operations

### Parent

- https://github.com/Nikolatesla-lj/orca/issues/23

### What to build

Migrate drift and health behavior into engine modules that separate detection,
reviewed verdict recording, reconcile baseline advancement, and observability
reporting. Drift detection must report scopes that need review; it must not
decide semantic correctness. Health must be a read/report operation with only
declared maintenance writes.

### Operations

- `scryer.drift.get`
- `scryer.drift.flag`
- `scryer.drift.reconcile`
- `scryer.model.health`

### Source docs to cite in the implementation

- `docs/orca-scryer-decision-map.md`
  - #20 "How Should Drift And Health Operations Migrate?"
  - #24 "How Should The 33-Operation Migration Be Implemented Safely?"
- `docs/prd/orca-scryer-operation-migration-work-set.md`
  - "Drift And Health Decision"
  - "Drift Scope Detector"
  - "Drift Verdict Recorder"
  - "Drift Reconcile Baseline"
  - "Health Reporter"
  - "Success Payload Field Contracts"
  - "Canonical Error Code Registry"
  - "Minimum Operation Test Checklist"
- `docs/prd/orca-scryer-engine-catalog-foundation.md`
  - operation cards for drift and health
  - "Catalog Policy Matrix"
  - "Schema Field Matrix"
  - "State Store Transaction Contract"
- `CONTEXT.md`
  - `Scryer Drift Scope Detector`
  - `Scryer Drift Verdict Recorder`
  - `Scryer Drift Reconcile Baseline`
  - `Scryer Health Reporter`
- Upstream anchors:
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-core/src/drift.rs`
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-core/src/health.rs`
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-core/src/build_edges.rs`
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-mcp/src/tools/read.rs`
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-mcp/src/tools/intent.rs`

### Files to inspect first

- `src/main/scryer/engine/drift-planner.ts`
- `src/main/scryer/engine/health-reporter.ts`
- `src/main/scryer/drift.ts`
- `src/main/scryer/sync.ts`
- `src/main/scryer/engine/source-router.ts`
- `src/main/scryer/engine/state-store.ts`
- `src/main/scryer/engine/schemas.ts`
- `src/main/scryer/engine/catalog.ts`

### Implementation scope

- Implement `ScryerDriftScopeDetector`, `ScryerDriftVerdictRecorder`,
  `ScryerDriftReconcilePlanner`, and `ScryerHealthReporter`.
- Add catalog rows, schemas, success payloads, error details, and upstream
  anchors for drift and health operations.
- Make first-run `drift.get` bootstrap sync and source-anchor baselines from
  current code state and return clean.
- Make `drift.flag` record reviewed semantic findings into planned state while
  leaving committed state unchanged.
- Route vagrant/stale finding anchors through `ScryerSourceRouter`.
- Make `drift.reconcile` advance global sync and anchor fingerprint baselines
  without proving review happened.
- Make health payloads include core observability fields and conditional
  evidence only when the supporting upstream evidence exists.

### Acceptance criteria

- [ ] `drift.get` reports boundary-owned changed scopes and never writes
  stale/vagrant flags or history events.
- [ ] First-run `drift.get` bootstraps declared baselines and returns clean.
- [ ] `drift.flag` writes planned verdicts atomically and uses source routing.
- [ ] `drift.reconcile` advances sync and anchor baselines but does not assert
  semantic correctness.
- [ ] `model.health` never records semantic drift verdicts or writes model
  meaning.
- [ ] Health maintenance writes are declared in catalog policy and failures
  follow required versus best-effort behavior.
- [ ] Tests cover no semantic verdict from detection, baseline bootstrap,
  planned-only verdict recording, reconcile behavior, and declared-only health
  writes.

### Blocked by

- Slice 1: Align Scryer Engine Codegen Contract Scaffolding
- Slice 2: Migrate Read Surface And Query Operations
- Slice 4: Implement Source Routing And Group Ownership Operations
- Slice 5: Implement Intent Authoring Operations

---

## Slice 7: Implement Atomic Container Generation

### Parent

- https://github.com/Nikolatesla-lj/orca/issues/23

### What to build

Preserve `scryer.container.fill` as one atomic generation primitive implemented
through `ScryerContainerGenerationPlanner`. It must validate one complete
container proposal, mint ids, create components/symbols/groups/source anchors,
derive or drop optional links, and write committed and planned state in one
state-store transaction.

### Operations

- `scryer.container.fill`

### Source docs to cite in the implementation

- `docs/orca-scryer-decision-map.md`
  - #21 "How Should Atomic Container Generation Migrate?"
  - #24 "How Should The 33-Operation Migration Be Implemented Safely?"
- `docs/prd/orca-scryer-operation-migration-work-set.md`
  - "Atomic Container Generation Decision"
  - "Success Payload Field Contracts"
  - "Canonical Error Code Registry"
  - "Minimum Operation Test Checklist"
- `docs/prd/orca-scryer-engine-catalog-foundation.md`
  - operation card for `scryer.container.fill`
  - "Catalog Policy Matrix"
  - "Schema Field Matrix"
  - "ID Minting Semantics"
  - "State Store Transaction Contract"
- `CONTEXT.md`
  - `Scryer Container Generation Planner`
  - `Scryer Generation Primitive`
- Upstream anchors:
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-mcp/src/tools/generation.rs`
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-core/src/build_edges.rs`
  - `/home/ljian/wspace/orca-scryer/scryer/crates/scryer-core/src/history.rs`

### Files to inspect first

- `src/main/scryer/engine/container-generation-planner.ts`
- `src/main/scryer/engine/id-minter.ts`
- `src/main/scryer/engine/group-planner.ts`
- `src/main/scryer/engine/source-router.ts`
- `src/main/scryer/engine/validators.ts`
- `src/main/scryer/engine/state-store.ts`
- `src/main/scryer/engine/catalog.ts`
- `src/main/scryer/engine/schemas.ts`

### Implementation scope

- Add catalog row, schema, success payload, error details, and upstream anchors
  for `scryer.container.fill`.
- Mark the operation as high-risk `generation_primitive`.
- Require the target to be an existing empty container.
- Use shared id-minter against committed state, planned state, and current batch
  reservations.
- Route generated source anchors through `ScryerSourceRouter`, writing committed
  state and mirroring planned state according to generation policy.
- Validate generated groups through group ownership validation.
- Derive links from `.scryer/.build_edges.json` where evidence is available.
- Drop optional invalid links and report them through `reports.droppedLinks`;
  do not reject the whole generation for optional link failures.
- Run shared validators against final committed/planned snapshots before
  durable writes.
- Do not refresh drift baseline or `model.baseline.scry`.

### Acceptance criteria

- [ ] Non-empty container target fails without writes.
- [ ] Missing target container fails with `not_found`.
- [ ] Generated committed and planned state write atomically; either both layers
  update or neither does.
- [ ] Generated components include at least one symbol.
- [ ] Generated symbols may have no responsibilities/properties when they still
  have valid source identity.
- [ ] Required proposal errors fail the whole operation; optional link problems
  are dropped and reported.
- [ ] Result shape includes `commit`, `summary`, `created`, `reports`, and
  `recommendedNextReads`.
- [ ] Structured warnings live in `meta.warnings`, not in `reports`.
- [ ] Tests focus on the planner seam plus thin pipeline smoke coverage.

### Blocked by

- Slice 1: Align Scryer Engine Codegen Contract Scaffolding
- Slice 3: Implement Structural Mutation Planner Operations
- Slice 4: Implement Source Routing And Group Ownership Operations
- Slice 5: Implement Intent Authoring Operations

---

## Slice 8: Retire Legacy Adapter Semantics Behind Engine Seams

Status: completed for the stable Architecture product path through #26-#28.
Remaining operation-family adapters continue through #35 after #31-#34 add the
missing executors.

### Parent

- https://github.com/Nikolatesla-lj/orca/issues/23

### What to build

Move remaining Architecture UI, IPC, CLI, agent runtime, and compatibility
callers behind the Native Scryer Engine seam. Product callers must express user
or agent intent, but Scryer semantics must live in engine modules and be reached
through `readView(...)` or `executeOperation(...)`.

### Source docs to cite in the implementation

- `docs/orca-scryer-decision-map.md`
  - #22 "How Do UI And Agent Runtime Move Behind The Expanded Engine?"
  - #23 "What Stays Out Of The Operation Migration?"
  - #24 "How Should The 33-Operation Migration Be Implemented Safely?"
- `docs/prd/orca-scryer-operation-migration-work-set.md`
  - "Adapter And Runtime Migration Decision"
  - "Out Of Scope Decision"
  - "Safe Broad Operation Migration Decision"
  - "Adapter Migration Mapping"
  - "UI Live Test Scenarios"
  - "Implementation Blueprint For Code Generation"
- `docs/prd/orca-scryer-engine-catalog-foundation.md`
  - "Current Code Migration Boundary"
  - "Dependency Direction"
  - "Legacy Adapter Field Mapping"
  - "Readiness Test Suite Map"
- `docs/adr/0025-use-deep-engine-modules-for-scryer-operation-migration.md`
- `docs/adr/0026-use-a-shared-scryer-read-surface.md`
- Upstream UI reference only:
  - `/home/ljian/wspace/orca-scryer/scryer/src/viewmodel.ts`
  - `/home/ljian/wspace/orca-scryer/scryer/src/App.tsx`
  - `/home/ljian/wspace/orca-scryer/scryer/src/diagramLayout.ts`

### Files to inspect first

- `src/main/ipc/architecture.ts`
- `src/main/ipc/architecture.test.ts`
- `src/cli/handlers/scryer.ts`
- `src/cli/specs/scryer.ts`
- `src/main/scryer/model-store.ts`
- `src/main/scryer/model-store-core.ts`
- `src/main/scryer/mcp-tools.ts`
- `src/main/scryer/drift.ts`
- `src/main/scryer/sync.ts`
- `src/renderer/src/components/architecture/**`
- `src/renderer/src/store/slices/architecture.ts`

### Implementation scope

- Route migrated IPC channels according to the operation-level mapping in the
  PRD:
  - `architecture:readModel` through `readView(...)` as renderer DTO migration
    lands.
  - `architecture:patchNodeData` through `scryer.node.update`.
  - `architecture:checkDrift` through `scryer.drift.get`.
  - `architecture:markSynced` through `scryer.drift.reconcile`.
  - `architecture:writeModel` and `architecture:writeModelDocument` only for
    generation/import/repair compatibility via `scryer.model.set`.
  - `architecture:callTool` as a temporary compatibility shim that normalizes
    old tool names into catalog operations, with no semantic fallback.
- Introduce the Architecture view adapter as a hard cutover so renderer code
  consumes `ArchitectureViewDto` instead of raw `ScryModel` or legacy
  `C4ModelData`. The DTO and renderer data fields follow upstream Scryer names:
  `nodes`, `links`, `groups`, `sourceMap`, and `boundaries`; do not keep
  `edges` as the architecture data field.
- Keep selected ids, expanded ids, layout positions, workspace view, diff glow,
  tabs, and session UI state outside `.scryer/model.scry`.
- Remove normal Architecture `flows` / `scenarios` support. Upstream Scryer 0.3
  has no Architecture flow model; do not keep `FlowScriptView` or flow
  extension state in the normal product path.
- Tighten normal Scryer runtime to a closed schema before the renderer cutover.
  Unknown fields in `model.scry` or `planned.scry` reject with structured
  `incompatible_model` details listing all unknown field paths.
- Demote `mcp-tools.ts` to a compatibility shim or remove semantic ownership
  for operations already cataloged.
- Move Scryer agent-run UI semantics behind `ScryerEditSessionController` over
  Orca runtime; do not duplicate generic process launch or terminal state.
- Keep Model Edit Lease tokens inside trusted main-process edit-session
  context. Renderer/preload DTOs and renderer operation inputs expose only
  token-free session status and completion-gate results.
- Add no-restricted-import tests or architecture ownership tests for migrated
  adapter files.

### Acceptance criteria

- [x] UI, IPC, CLI, and agent adapter tests prove migrated reads cross
  `readView(...)`.
- [x] Architecture renderer code no longer imports `C4ModelData`, `C4Node`,
  `C4Edge`, `C4NodeData`, `parseModelData`, or `serializeModelData`.
- [x] Architecture renderer normal reads use `architecture:readArchitectureView`;
  normal writes use intent/operation calls, not `readModelDocument` or
  `writeModelDocument`.
- [x] Closed-schema tests reject unknown top-level and core nested fields,
  including `flows`, `scenarios`, `edges`, `nodes[*].type`, `nodes[*].data`,
  `links[*].source`, and `links[*].target`.
- [x] UI, IPC, CLI, and agent adapter tests prove migrated writes cross
  `executeOperation(...)`.
- [x] Renderer DTO tests prove components render from DTO fields rather than
  domain model internals.
- [x] View-only state changes do not write `.scryer/model.scry`.
- [x] Semantic UI actions handle success payloads, `meta.warnings`,
  `recommendedNextReads`, domain errors, validation errors, and unexpected
  error envelopes.
- [x] Legacy model-store and `mcp-tools` semantic paths are gone for cataloged
  operations or reduced to pure shims.
- [x] A cataloged operation failure never falls back to the old implementation.

### Blocked by

- Slice 2: Migrate Read Surface And Query Operations
- Slice 3: Implement Structural Mutation Planner Operations
- Slice 4: Implement Source Routing And Group Ownership Operations
- Slice 5: Implement Intent Authoring Operations
- Slice 6: Implement Drift And Health Operations
- Slice 7: Implement Atomic Container Generation

---

## Slice 9: Prove Broad Migration Readiness With Parity, Ownership, And Live UI Gates

Status: partially completed. #29 proves the stable Architecture product path;
full operation readiness remains open for #35 after #31-#34 add executors for
the catalog-only operations.

### Parent

- https://github.com/Nikolatesla-lj/orca/issues/23

### What to build

Close the #16-#24 migration work set by adding the readiness gate tests and
fixtures that prove all cataloged operations use the Native Scryer Engine seam,
shared schemas, shared error/warning contracts, shared parity fixtures, adapter
ownership rules, and live UI behavior. This slice should not add new semantics;
it proves the migrated semantics are owned in the right modules.

### Source docs to cite in the implementation

- `docs/orca-scryer-decision-map.md`
  - #24 "How Should The 33-Operation Migration Be Implemented Safely?"
  - #22 "How Do UI And Agent Runtime Move Behind The Expanded Engine?"
  - #23 "What Stays Out Of The Operation Migration?"
- `docs/prd/orca-scryer-operation-migration-work-set.md`
  - "Safe Broad Operation Migration Decision"
  - "Adapter And Runtime Migration Decision"
  - "Out Of Scope Decision"
  - "Implementation Blueprint For Code Generation"
  - "Minimum Operation Test Checklist"
  - "Upstream Parity Fixture Format"
  - "Adapter Migration Mapping"
  - "UI Live Test Scenarios"
- `docs/prd/orca-scryer-engine-catalog-foundation.md`
  - "Upstream Parity Test Strategy"
  - "Implementation Readiness Gate"
  - "Readiness Test Suite Map"
  - "Test Plan"
- `docs/adr/0025-use-deep-engine-modules-for-scryer-operation-migration.md`
- `tests/e2e/AGENTS.md`

### Files to inspect first

- `src/main/scryer/engine/catalog.test.ts`
- `src/main/scryer/engine/pipeline.test.ts`
- `src/main/scryer/engine/architecture-ownership.test.ts`
- `src/main/scryer/engine/parity-fixtures.ts`
- `src/main/scryer/engine/parity-fixtures.test.ts`
- `src/main/ipc/architecture.test.ts`
- `src/cli/handlers/scryer.test.ts`
- `tests/playwright.config.ts`
- `tests/e2e/AGENTS.md`
- `tests/e2e/architecture-tab.spec.ts`
- `tests/e2e/architecture-human-checklist.spec.ts`
- `tests/e2e/helpers/orca-app.ts`

### Implementation scope

- Add parity fixture coverage for every migrated operation family, using the
  canonical directory fixture format.
- Add or update catalog completeness tests for operation ids, schemas, policy,
  risk, warning schema, error details, upstream anchors, and transport metadata.
- Add pipeline tests for success validation, error-detail validation, warning
  validation, undeclared error rejection, common error envelopes, lock/lease
  enforcement, and no legacy fallback for cataloged operations.
- Add architecture ownership tests so forbidden imports fail for engine modules,
  adapters, renderer code, `model-store`, and `mcp-tools`.
- Add Electron Playwright live human-operation tests with a seeded Scryer
  project under `tests/e2e/fixtures/scryer-project/` or through
  `tests/e2e/helpers/scryer-project.ts`.
- Add test-only seam spies that observe real calls to `readView(...)` and
  `executeOperation(...)`, and legacy bypass spies/restricted-import assertions
  for cataloged operations.

### Acceptance criteria

- [x] Every migrated operation family has at least one upstream parity or golden
  behavior fixture.
- [x] Catalog tests fail if any migrated operation lacks schemas, declared
  errors, policy, risk, warning validation, success validation, or upstream
  anchors.
- [x] Ownership tests fail if operation files own file IO, locks, source routing,
  id scanning, fold cleanup, result envelopes, or transport formatting.
- [x] Adapter tests fail if UI/IPC/CLI/agent callers bypass
  `executeOperation(...)` or `readView(...)` for cataloged operations.
- [x] No legacy fallback path exists for a cataloged operation.
- [x] Live UI tests open a seeded Scryer project, read through `readView(...)`,
  perform a representative semantic edit through visible controls, refresh via
  `recommendedNextReads`, render a domain error, and prove no legacy semantic
  write path was invoked.
- [x] Headless live specs cover ordinary overview/subtree/edit/error flows;
  headful specs are reserved only for real focus, drag, pointer capture, native
  menu, or OS-window behavior.

### Blocked by

- Slice 8: Retire Legacy Adapter Semantics Behind Engine Seams
