# PRD: Orca Native Scryer Engine First Slice

## Source

- Decision map: `docs/orca-scryer-decision-map.md`
- Operation parity and contract matrix: `docs/scryer-cli-tool-parity.md`
- Migration plan: `docs/orca-scryer-migration.md`
- UML gap analysis: `docs/orca-scryer-uml-gap-analysis.md`
- Domain glossary: `CONTEXT.md`
- Issue tracker: `Nikolatesla-lj/orca`
- PRD issue: https://github.com/Nikolatesla-lj/orca/issues/22

## Problem Statement

Orca already has a usable Architecture tab and a migrated Scryer-compatible model/tool layer, but the remaining Scryer behavior is still split across UI controller code, IPC handlers, storage helpers, drift/sync helpers, and a legacy MCP-shaped tool facade. That makes it hard for Codex, Claude Code, scripts, UI actions, and future Orca agent runs to rely on one exact Scryer state model.

The user needs Orca to migrate Scryer function semantics into a product-grade Orca-native TypeScript/Node implementation, not a Rust sidecar and not a partial copy of upstream source. The next implementation step must prove the Native Scryer Engine can own Scryer 0.3 model semantics, planned/committed layers, validation, lock/lease policy, operation contracts, and transport forwarding through one minimal semantic loop.

## Solution

Build the first slice of the Native Scryer Engine around seven operation contracts:

1. `scryer.model.read`
2. `scryer.model.validate`
3. `scryer.node.update`
4. `scryer.link.add`
5. `scryer.link.delete`
6. `scryer.plan.pending`
7. `scryer.plan.fold`

This slice establishes a single engine interface used by CLI, IPC, UI, agent runtime, drift/sync, and tests. The operation pipeline owns context validation, input validation, project resolution, authority checks, Model Edit Lease checks, model locks, layer reads/writes, declared side effects, validation, and the shared operation result envelope.

The first slice does not try to port every upstream Scryer capability. It proves the core loop that all later operations depend on: read a Scryer 0.3 model, edit planned state, inspect pending work, validate model state, fold implemented work into committed state, and expose the same behavior through Orca-native transports.

## Implementation Status

Completed on 2026-06-23 in commit `56f950f7f` (`Implement native Scryer engine first slice`).

Implemented first-slice operations:

1. `scryer.model.read`
2. `scryer.model.validate`
3. `scryer.node.update`
4. `scryer.link.add`
5. `scryer.link.delete`
6. `scryer.plan.pending`
7. `scryer.plan.fold`

The landed slice adds the Native Scryer Engine deep module under `src/main/scryer/engine/`, Orca-native CLI commands under `orca scryer ...`, IPC forwarding through `architecture:executeScryerOperation`, shared operation result envelopes, Scryer 0.3 model read/write behavior, planned/committed state, lock and lease checks, pending diff, fold baseline/history side effects, and focused engine/CLI/IPC tests.

Post-implementation verification on 2026-06-23 restored the full Vitest baseline:

- `corepack pnpm test`: 2029 test files passed, 20032 tests passed, 5 files skipped, 63 tests skipped.
- `corepack pnpm run tc`: passed.

Remaining migration work is outside this first slice: Architecture UI intent mapping to the engine seam, full `ScryerEditSessionController` lifecycle, completion gate UI/product state, and broader upstream operation coverage.

## User Stories

1. As an Orca user, I want Architecture tab edits to use the same Scryer semantics as agent commands, so that UI and agent changes do not drift apart.
2. As an Orca user, I want draft architecture edits to be stored as planned changes, so that intended work is not mistaken for implemented code.
3. As an Orca user, I want implemented architecture work to be folded explicitly into committed state, so that the model records what the code actually satisfies.
4. As an Orca user, I want Orca to refuse incompatible pre-0.3 Scryer models during normal runtime, so that old data is not silently misinterpreted.
5. As an Orca user, I want clear structured errors when a model is invalid or incompatible, so that I know what needs repair.
6. As an Orca user, I want the Architecture tab to reload cleanly after external Scryer operations, so that agent updates appear without manual file inspection.
7. As an Orca user, I want Scryer validation warnings to be visible without blocking valid draft edits, so that I can keep working while seeing model issues.
8. As an Orca user, I want a pending-work view, so that I can see what planned architecture changes still need implementation.
9. As an Orca user, I want fold operations to update committed model state, baseline, and history together, so that completion evidence is durable.
10. As an Orca user, I want illegal links to be rejected before write, so that diagrams do not accumulate invalid architecture relationships.
11. As an Orca user, I want link deletion to report missing ids separately from deleted ids, so that partial cleanup is understandable.
12. As an Orca user, I want model writes to be lock-protected, so that concurrent UI and agent writes do not corrupt model files.
13. As an Orca user, I want agent-owned edit sessions to block stale UI writes, so that an agent run cannot be overwritten by an old in-memory UI state.
14. As an Orca user, I want agent completion to go through a completion gate, so that process exit is not treated as product completion.
15. As a Codex agent, I want `orca scryer model read` to return structured JSON, so that I can inspect the architecture model deterministically.
16. As a Codex agent, I want `orca scryer node update` to write planned changes through the Native Scryer Engine, so that I do not need to edit `.scryer` files directly.
17. As a Claude Code agent, I want Orca-native Scryer commands to preserve upstream Scryer field meanings, so that prompts and tool calls remain semantically precise.
18. As a script author, I want complex write commands to accept stdin JSON, so that nested model updates do not require fragile shell quoting.
19. As a script author, I want every command to return the shared result envelope in JSON mode, so that success and failure can be handled without parsing prose.
20. As an Orca developer, I want one operation catalog, so that operation ids, input schemas, payload schemas, errors, state effects, and transport metadata are declared in one place.
21. As an Orca developer, I want one operation execution pipeline, so that each operation file only implements Scryer domain semantics.
22. As an Orca developer, I want operation-contract tests to drive behavior, so that CLI, IPC, and UI do not duplicate Scryer model logic.
23. As an Orca developer, I want the first seven contracts implemented before broad operation coverage, so that later operations inherit a proven foundation.
24. As an Orca developer, I want existing migrated Scryer storage, drift, sync, and UI code to be refactored behind the engine, so that previous migration work remains useful.
25. As an Orca developer, I want the old MCP-shaped facade to stop owning semantics, so that the product no longer depends on MCP as a Scryer runtime path.
26. As an Orca developer, I want Architecture UI model writes to call engine operations, so that direct writes cannot bypass planned/committed rules.
27. As an Orca developer, I want IPC handlers to forward engine envelopes unchanged, so that renderer behavior can rely on machine-readable errors.
28. As an Orca developer, I want CLI handlers to map arguments to operation input only, so that CLI ergonomics do not change engine semantics.
29. As an Orca developer, I want upstream Scryer Rust tests and handlers used as behavior anchors, so that Orca reimplements behavior without copying upstream implementation source.
30. As an Orca developer, I want first-slice tests to use temporary project directories, so that model files, locks, planned state, committed state, baseline, and history are verified as real filesystem effects.
31. As an Orca developer, I want the result envelope validated on every operation, so that callers cannot accidentally depend on ad hoc response shapes.
32. As an Orca developer, I want structured error codes for lock, lease, validation, illegal link, not found, incompatible model, and IO failures, so that UI and agents can react predictably.
33. As an Orca developer, I want render-only state kept outside `ScryModel`, so that ReactFlow layout, selection, expanded path, and runtime state do not pollute architecture truth.
34. As an Orca developer, I want retained flow-editor data treated as Orca extension state, so that upstream Scryer 0.3 `ScryModel` remains canonical.
35. As an Orca maintainer, I want the implementation to stay TypeScript/Node-native, so that packaging, Electron IPC, tests, and Orca runtime integration remain product-native.

## Implementation Decisions

- The Native Scryer Engine is the only owner of Scryer state semantics.
- The Native Scryer Engine must be a deep module, not a pass-through wrapper over storage, validation, and transport helpers.
- The Native Scryer Engine external interface is intentionally small: product callers use `executeOperation(...)` and `readView(...)`.
- Product callers must not acquire Model Edit Leases, run completion gates, call the state store, or write `.scryer` files directly.
- The engine uses upstream Scryer 0.3 `ScryModel` as the canonical model.
- Normal runtime does not auto-migrate pre-0.3 model files.
- The first implementation slice is the seven-operation minimal semantic loop.
- The highest implementation seam is `ScryerEngine.executeOperation(...)`.
- CLI, IPC, UI, agent runtime, drift/sync, and tests are transport callers over the same engine contracts.
- Transport adapters may normalize arguments and render envelopes, but they must not own Scryer state semantics.
- Each operation is declared by a typed contract containing operation id, input schema, success payload schema, allowed structured errors, reads/writes, lock policy, lease policy, validation policy, side effects, upstream parity anchors, and transport metadata.
- Every operation returns a shared `ScryerOperationResult<T>` envelope.
- Every operation receives explicit `ScryerOperationContext`.
- The operation execution pipeline owns cross-cutting behavior: contract lookup, context validation, input validation, project resolution, authority, Model Edit Lease, file lock, declared reads, declared writes, side effects, validation, and result envelope validation.
- Operation implementation files own only Scryer domain semantics.
- `ScryerStateStore` is an internal seam used by the operation pipeline. It hides `.scryer` paths, planned fallback, committed writes, atomic IO, baseline/history/anchor/build-edge effects, and lock ownership.
- `ScryerValidator` is an internal seam that classifies parse/version incompatibility, input errors, blocking structural errors, non-blocking warnings, and post-fold committed validation.
- `ScryerEditSessionController` owns Scryer model-edit session safety over Orca runtime integration, including Model Edit Lease lifecycle, completion gate execution, cancellation, crash cleanup, and visible handoff mapping.
- `ArchitectureViewAdapter` keeps renderer state shallow: it maps `ScryModel` to view data and maps UI intents to engine operations without becoming a second model semantics owner.
- Draft edits write planned state only.
- Fold operations reconcile planned work into committed state and update baseline/history side effects.
- Reads default to the planned layer and can explicitly read committed state.
- Engine contracts preserve upstream Scryer semantic field names such as `src`, `dst`, `node_id`, `responsibility_ids`, `link_ids`, `sourceMap`, and `boundaries`.
- Orca CLI commands use noun/verb style such as `orca scryer model read` and `orca scryer plan fold`.
- CLI aliases may normalize presentation fields before calling the engine, but aliases do not become engine contract fields.
- IPC forwards the shared envelope unchanged.
- UI renders failures by structured error code and details, not by parsing error text.
- Model writes are protected by a `.scryer` lock.
- Agent-owned edit sessions use Model Edit Lease enforcement.
- Agent completion uses a Completion Gate based on pending work and validation, not blind process exit.
- Existing migrated model-store, drift, sync, Architecture tab, source map, and operation-layer code should be refactored into or behind the Native Scryer Engine rather than discarded.
- The legacy MCP-shaped tool facade is allowed only as temporary refactor scaffolding and must not remain the semantic owner.
- Architecture tab persistent model state moves from legacy C4 shape to Scryer 0.3 model semantics.
- ReactFlow layout, selection, expanded path, active panel state, diff glow, follow-navigation, and runtime state remain outside `ScryModel`.
- Flow editor data, if retained, is Orca extension state and not part of the Scryer 0.3 model truth.
- Upstream Scryer remains the reference for behavior, schemas, state transitions, and parity tests, but Orca reimplements the product runtime in Orca-owned TypeScript/Node code.

## Testing Decisions

- The primary test seam is the Native Scryer Engine interface, not CLI, IPC, or renderer internals.
- Good tests assert external behavior: operation input, result envelope, structured errors, model files touched, planned/committed state, baseline/history side effects, lock/lease behavior, and validation warnings.
- Operation-contract tests should be written before or alongside each first-slice operation.
- Operation-contract tests replace shallow tests that duplicate storage, validation, lock, or transport internals once the engine seam covers the same behavior.
- First-slice tests should use temporary project directories with real `.scryer` files.
- State-store tests should use local-substitutable filesystem fixtures and assert observable file effects through the engine when possible.
- Validator tests may cover pure taxonomy directly, but model validity behavior must also be observable through engine operation results.
- Agent-run-bridge tests should use an in-memory Orca runtime adapter for lease and completion-gate behavior.
- Contract tests should cover `scryer.model.read`, `scryer.model.validate`, `scryer.node.update`, `scryer.link.add`, `scryer.link.delete`, `scryer.plan.pending`, and `scryer.plan.fold`.
- Error tests should cover incompatible model, invalid input, missing nodes/links, illegal links, lock busy, lease required, validation failed, and IO failure where practical.
- Fold tests should verify committed state, planned remaining work, baseline refresh, and history append.
- Pending tests should verify diffs between committed and planned state.
- CLI tests should verify command-to-operation mapping, JSON envelope output, non-zero failure exit, and stdin JSON input for complex writes.
- IPC tests should verify forwarding of the engine envelope and absence of duplicated Scryer semantics in IPC handlers.
- UI tests should verify that Architecture actions call the engine path and that renderer behavior responds to structured errors.
- Architecture view tests should verify view derivation and intent mapping, not planned/committed semantics.
- Regression tests should preserve existing migrated behavior for Architecture tab reload, source map opening, drift report, sync cancellation, and agent done handling while the backing engine changes.
- Upstream Scryer Rust handlers, request structs, and handler tests are behavior anchors for expected semantics, but tests should be native Orca TypeScript tests.
- Transport tests must not reimplement the full domain test matrix; they verify mapping and rendering around the engine seam.
- Live or e2e coverage should prove a command-line Scryer update refreshes the Architecture tab and that an agent-owned edit cannot be overwritten by stale UI state.

## Out of Scope

- Full migration of every upstream Scryer operation.
- Scryer MCP as an Orca product path.
- Packaged Rust Scryer sidecar runtime.
- Direct copying of upstream Scryer implementation source into Orca product runtime.
- Automatic pre-0.3 model migration during normal open/read.
- A complete pre-0.3 import command.
- Pixel-perfect Scryer UI replication.
- Scryer standalone Tauri shell.
- Scryer standalone AI provider settings.
- Scryer docs app or template marketplace.
- Full drift, health, source update, group, intent-writer, and container-fill operation coverage beyond what the first slice needs.
- Stage-level retry or broad agent automation redesign.

## Further Notes

The implementation should treat the current decision map as complete for this phase. New decisions should be added only if the first-slice work reveals a concrete blocker that is not already covered by the ADRs or linked design assets.

This PRD is ready to be split into implementation issues. The first issue should establish the engine interface, operation catalog shape, shared result envelope, operation context, and operation pipeline. Subsequent issues can land the seven operations and then transport adapters.
