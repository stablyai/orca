# Orca Domain Glossary

This glossary defines the project-specific language used while integrating Scryer capabilities into Orca. Design decisions, implementation plans, and research notes belong in ADRs or linked design assets, not here.

## Language

**Pipeline**:
An Orca-owned automation run that coordinates prepared work through planning, agent execution, review, merge, and verification.
_Avoid_: Script chain, ad hoc automation

**Pipeline Template**:
A reusable definition of the stages, prompts, task-source behavior, output expectations, and safety limits for a Pipeline.
_Avoid_: Prompt file, workflow snippet

**Pipeline Run**:
One execution of a Pipeline Template against a repository, branch, task source, and runtime configuration.
_Avoid_: Job, build, script run

**Pipeline PRD Work Set**:
A group of prepared task issues selected for one PRD-oriented Pipeline Run.
_Avoid_: Loose issue list, backlog slice

**PRD Candidate**:
A suggested PRD Work Set shown before launch so a user can select prepared work without reconstructing the issue query.
_Avoid_: Random recommendation, saved search

**Pipeline Iteration**:
One planning and execution cycle inside a Pipeline Run, including planning, dispatch, review, merge, and verification.
_Avoid_: Retry, loop pass

**Pipeline Task**:
One prepared work item selected by a Pipeline planner and tracked through its execution workspace and verification result.
_Avoid_: Generic issue, terminal tab

**Pipeline Recovery Report**:
A user-facing summary explaining why a previous Pipeline Run needs review before replacement work starts.
_Avoid_: Crash log, silent resume

**Task Source**:
The configured origin from which a Pipeline Run selects prepared work.
_Avoid_: Prompt text, manual checklist

**Dynamic Context**:
Prompt context produced by a declared command in a Pipeline Template.
_Avoid_: User-supplied shell command, arbitrary prompt interpolation

**Scryer Engine Parity**:
The requirement that Orca preserve upstream Scryer model behavior while adapting presentation and runtime ownership to Orca.
_Avoid_: Partial behavior clone, copied Scryer app

**Native Scryer Engine**:
The Orca-owned module that applies Scryer model semantics for Orca callers.
_Avoid_: Packaged Scryer sidecar, UI-owned model rules

**Native Scryer Engine Interface**:
The single Orca-internal interface through which product callers access Scryer model behavior.
_Avoid_: Direct state-file writes, duplicated caller-specific semantics

**Scryer Operation Catalog**:
The Orca-owned catalog of named Scryer operations available to product callers.
_Avoid_: Transport-owned tool registry, per-caller command list

**Scryer Operation Migration Work Set**:
The complete planned work package for migrating the remaining upstream Scryer operations into Orca-native engine contracts and task slices.
_Avoid_: One giant implementation PR, informal backlog, partial operation batch

**Scryer Operation Contract**:
The declared input, output, state-effect, authority, and error behavior for one Scryer operation.
_Avoid_: Transport-specific validation, undocumented operation behavior

**Scryer Foundation Interface Contract**:
The documented module seam rules that keep broad Scryer operation migration inside the Native Scryer Engine foundation.
_Avoid_: One-off operation files, caller-owned state semantics, undocumented dependency direction

**Scryer Schema Field Matrix**:
The field-level source for Scryer operation input and success schemas.
_Avoid_: Schema names without fields, operation-local schema inference

**Scryer Canonical Input Shape**:
The normalized operation input form passed from the pipeline to Scryer operation executors.
_Avoid_: Mixed aliases, executor-level input compatibility handling

**Scryer Operation Result Envelope**:
The shared success-or-failure result shape returned by Native Scryer Engine operations.
_Avoid_: Caller-specific result shapes, behavior encoded in prose output

**Scryer Operation Outcome**:
The internal executor return value containing a structured result, optional state changes, and optional validation findings.
_Avoid_: Executor-owned result envelope, executor-owned file write

**Scryer Executor Result**:
The internal executor success-or-expected-failure union returned before the pipeline creates the public operation result envelope.
_Avoid_: Expected failure as thrown exception, executor-owned envelope

**Scryer Error Mapper**:
The engine module that converts executor, pipeline, state-store, and unexpected failures into `ScryerOperationError` and `ScryerOperationResult`.
_Avoid_: Operation-local error envelope creation, adapter-owned error taxonomy

**Scryer State Commit Plan**:
The pipeline-generated durable write plan that state-store commits after catalog policy validation.
_Avoid_: Operation-local file write, implicit side effect

**Scryer Source Router**:
The engine module that routes `sourceMap` and `boundaries` entries to their single durable home: committed state for committed elements, planned state for planned-only elements, with stale shadow entries removed.
_Avoid_: Duplicated source entries, operation-local layer routing, adapter-owned source ownership

**Scryer Model Hierarchy**:
The C4-style primary hierarchy inside `ScryModel`: person, system, container, component, and symbol. v0.3 extends this hierarchy with code symbols, responsibilities, source ownership, and planned/committed state rather than replacing it with an unrelated model.
_Avoid_: Legacy C4 model, flat code graph, symbol-only model

**Scryer Group**:
A secondary organization axis that groups sibling nodes inside a parent node view, such as a package, module, feature area, deployment unit, or ownership unit. It does not replace node parentage.
_Avoid_: Node status, parent-child hierarchy, renderer-only overlay

**Scryer Group Ownership Planner**:
The engine module that validates and plans group set, update, delete, nesting, membership, responsibilities, and direct child-group detach behavior before state-store commits.
_Avoid_: Operation-local group rules, UI-owned group semantics, direct group file write

**Scryer Intent Authoring Planner**:
The engine module that turns typed authoring intent into valid planned `ScryModel` additions, including id minting, parent validation, responsibility creation, source anchors, boundaries, and commit plans.
_Avoid_: Agent-authored model JSON, operation-local id minting, adapter-owned authoring rules

**Scryer Drift Scope Detector**:
The engine module that reports which boundary-owned model scopes need semantic review because code changed since the last reconcile anchor. It does not decide whether the model is semantically wrong.
_Avoid_: Drift verdict, stale flag writer, code-change-is-model-error

**Scryer Drift Verdict Recorder**:
The engine module that records reviewed code-vs-model findings into planned state as vagrant or stale model facts, including source anchors and history events.
_Avoid_: Raw file-change detector, automatic semantic judgment, committed-side verdict write

**Scryer Drift Reconcile Baseline**:
The persisted sync anchor and source-anchor fingerprint baseline used by later drift checks to ignore already-reviewed code changes and report only newer changes.
_Avoid_: Semantic correctness proof, hidden review record, stale/vagrant verdict

**Scryer Health Reporter**:
The engine module that derives model observability reports from model state, source anchors, drift flags, and link evidence, with only declared maintenance writes for upstream-compatible bootstrap or re-anchor behavior.
_Avoid_: Semantic drift verdict writer, ordinary model edit, hidden health side effect

**Scryer Container Generation Planner**:
The engine module that turns one complete container modeling proposal into an atomic committed/planned model generation plan, including minted components, symbols, groups, source anchors, derived links, and generation reports.
_Avoid_: Incremental intent-call assembly, agent-authored ids, half-filled container subtree

**Scryer Policy Branch**:
A catalog-declared flat policy selected from validated input before authorization, lease, read/write, validation, and side-effect checks.
_Avoid_: Hidden mode checks inside operation files, input-granted permission

**Scryer Operation Registry**:
The machine-readable operation table that declares what each Scryer command is, how risky it is, what it may write, and which runtime policies apply.
_Avoid_: Prompt-only command list, scattered operation rules, adapter-owned policy

**Scryer Data Checker**:
The runtime validation rules that verify Scryer operation inputs, outputs, warnings, and error details have the expected shape.
_Avoid_: Trusting agent JSON, unchecked result payload, prose-only validation

**Scryer Tool Guidance**:
The human- and agent-facing command description that explains when a Scryer operation should be used and which safer alternatives to prefer.
_Avoid_: Hidden tool semantics, prompt-only safety, runtime policy

**Scryer Structural Replacement Operation**:
A high-risk write operation that replaces the whole model or a whole node subtree in one call.
_Avoid_: Ordinary edit, default agent editing path, small patch operation

**Scryer Generation Primitive**:
A high-risk write operation that creates a large model structure from one complete proposal and must be used only for declared generation, fixture, migration, or repair flows.
_Avoid_: Ordinary small edit, caller-assembled operation sequence, hidden partial generation

**Scryer Deterministic Runtime Services**:
Injected clock and request-id providers used to make engine behavior and tests reproducible.
_Avoid_: Direct Date/random calls in operation or state-store code

**Scryer Transport Metadata**:
Adapter mapping data that describes how CLI, IPC, UI, agent, system, or test adapters expose an operation.
_Avoid_: Authorization policy, caller identity, hidden transport permission

**Scryer Engine Dependencies**:
The injectable catalog, state-store, error-mapper, clock, and request-id adapters used to create a Scryer Engine instance.
_Avoid_: Ambient singletons, hard-coded test hooks

**Scryer Shared Result Type**:
A reusable structured success payload used by multiple Scryer operations or adapters.
_Avoid_: Repeated nested success payload, operation-local complex result shape

**Scryer Read Surface**:
The shared read facade and result model used by Scryer read/query operations and product view adapters.
_Avoid_: `model.read` alias, operation-local read shape, `view: unknown`

**Scryer Read Selector**:
The Native Scryer Engine module that turns canonical `ScryModel` state into standardized overview, subtree, full-model, search, query, rules, and codebase read payloads.
_Avoid_: CLI-generated read views, UI-owned model interpretation, agent-parsed raw model JSON

**Scryer Read Mode Selection Policy**:
The shared rules that make overview the default read, subtree the normal drill-down read, and full-model reads explicit global or compatibility reads.
_Avoid_: Implicit full model dump, adapter-specific read choice, agent convenience fallback

**Scryer Overview Payload**:
The compact model map that gives callers enough ids, counts, paths, coverage signals, and next-read guidance to navigate the model without reading the full model first.
_Avoid_: Thin summary, lossy navigation, compressed full model

**Scryer Operation Context**:
The Orca runtime context that identifies who is invoking a Scryer operation and from which project/session.
_Avoid_: Implicit caller identity, ambient process authority

**Scryer Minimal Semantic Loop**:
The smallest operation slice that proves read, validate, draft edit, pending work, and fold behavior together.
_Avoid_: Broad operation inventory before core writes work

**Scryer Contract Matrix**:
The compact table that records the first operation contracts and drives implementation and tests.
_Avoid_: Implementation-first behavior, scattered contract notes

**Scryer Operation Execution Pipeline**:
The shared execution path that applies an operation contract consistently for every caller.
_Avoid_: Per-caller project resolution, operation-specific lock or lease rules

**Scryer State Store**:
The Native Scryer Engine module that owns durable Scryer model state access and transaction-level commits for Orca.
_Avoid_: Direct `.scryer` file access, operation-owned file writes, per-file writes from operation executors

**Scryer Semantic Write**:
A Scryer engine write that changes the model intent expressed by planned or committed Scryer state.
_Avoid_: Maintenance write, auxiliary file update

**Scryer Maintenance Write**:
A Scryer engine write that updates supporting state without changing model intent.
_Avoid_: Semantic edit, hidden model change

**Scryer Source Mapping Routing**:
The rule that decides whether a `sourceMap` or `boundaries` entry is written to committed state or planned state based on where the target model element exists.
_Avoid_: Optional source side effect, duplicated source mapping

**Scryer Fold**:
The engine behavior that applies selected planned element changes to committed Scryer state after the corresponding code work is complete.
_Avoid_: Generic save, direct commit, operation-local commit logic

**Scryer ID Minting**:
The engine behavior that assigns new Scryer ids from committed state, planned state, and current batch reservations.
_Avoid_: Caller-generated ids, committed-only id scan, operation-local id counters

**Scryer Error Taxonomy**:
The stable set of structured engine error codes and zod-validated detail schemas used instead of parsing upstream-style human text.
_Avoid_: English error parsing, caller-specific exception text, operation-local error detail shapes

**Scryer Validation Finding**:
A structured Scryer model issue reported by validators as either informational output or a write blocker.
_Avoid_: Free-form validator text, operation-local warning shape

**Scryer Validation Policy**:
The operation contract rule that decides which validator findings are reported as warnings and which findings block a write.
_Avoid_: Ad hoc write guard, hidden validation rule

**Scryer Parity Test**:
A behavior test that proves Orca's TypeScript implementation matches upstream Scryer semantics for the same model state or operation scenario.
_Avoid_: Source similarity check, implementation-copy test

**Scryer Parity Fixture**:
A test case that stores a Scryer project state, an operation request, upstream behavior anchors, and expected structured results or model files.
_Avoid_: Snapshot-only test, copied upstream unit test body

**Scryer Parity Fixture Loader**:
The zod-validated test helper that loads parity cases and rejects malformed fixture metadata before behavior comparison.
_Avoid_: Ad hoc fixture file reads, unchecked golden schema

**Scryer Golden State**:
The expected Scryer files or structured result used by a parity fixture to prove behavior equivalence.
_Avoid_: Raw upstream text output, incidental snapshot

**Scryer Implementation Readiness Gate**:
The foundation test checkpoint that must pass before Orca expands from Scryer engine infrastructure into broad operation-family migration.
_Avoid_: Informal TODO list, operation-by-operation readiness guess

**Scryer Legacy Fallback**:
A hidden old implementation path that runs after a cataloged engine operation fails.
_Avoid_: Engine failure rescue path, dual semantic implementation

**Scryer Architecture Ownership Test**:
The static import test that enforces allowed dependency direction across engine modules, adapters, renderer code, and legacy scaffolding.
_Avoid_: Runtime-only seam enforcement, manual import review

**Scryer Contract Field Semantics**:
The rule that Scryer model and operation fields keep upstream Scryer meaning even when Orca changes command names.
_Avoid_: Renaming Scryer semantic fields for presentation style

**Orca Scryer Command**:
An Orca CLI command that invokes a Scryer operation through the Native Scryer Engine.
_Avoid_: Separate Scryer tool server, prompt-only instruction

**Scryer Engine Structured Error**:
A machine-readable failure reported by a Native Scryer Engine operation.
_Avoid_: String parsing, UI-only exception text

**Orca-native Shell**:
The Orca-owned product surface through which users and agents access Scryer capabilities.
_Avoid_: Embedded upstream app shell, independent Scryer runtime

**Scryer Agent Run Semantics**:
The upstream Scryer behavior for model-building, filling, preview repair, variation, drift, progress, and cancellation.
_Avoid_: Raw Codex process ownership, UI-only automation

**Orca Execution Adapter**:
An Orca-owned adapter that runs Scryer agent work through Orca's agent runtime while preserving Scryer Agent Run Semantics.
_Avoid_: Scryer-owned process launch, thin shell wrapper

**Scryer Agent Run Bridge**:
The Orca module that starts, observes, and cancels Scryer agent runs without exposing launch mechanics to product callers.
_Avoid_: Direct UI-to-agent launch coupling

**Model Edit Lease**:
An Orca runtime claim that decides who may write Scryer model state while an agent-owned edit is active.
_Avoid_: Visual-only lock, best-effort write suppression

**Scryer Draft Edit**:
A planned model change that expresses intended architecture work before code is known to satisfy it.
_Avoid_: Implemented fact, direct committed edit

**Scryer Planned Deletion**:
A draft edit that says modeled code should be removed, but the committed model should not change until the code removal is complete and folded.
_Avoid_: Immediate committed deletion, model-only correction, descope

**Scryer Structural Move**:
A draft edit that changes where an existing model node lives while preserving its identity and subtree.
_Avoid_: Delete-and-recreate move, reminted ids, source anchor loss

**Scryer Responsibility Move**:
A draft edit that moves an existing responsibility to a new model owner while preserving the responsibility id and its source anchors.
_Avoid_: Copy-and-delete responsibility, reminted responsibility id, orphaned source anchor

**Scryer Link Update**:
A draft edit that changes a link's descriptive fields while preserving the connected endpoints.
_Avoid_: Endpoint repoint, delete-and-add shortcut, hidden relationship replacement

**Scryer Atomic Batch**:
A multi-item operation that either validates and commits every requested item together or writes nothing.
_Avoid_: Partial success write, best-effort batch mutation, caller-repaired half state

**Scryer Structural Hard Error**:
A validation failure that would make Scryer model state structurally invalid or unsafe for engine reads, writes, diff, fold, or routing.
_Avoid_: Cosmetic warning, quality note, best-effort cleanup

**Scryer Structural Cleanup**:
The shared engine behavior that removes or repairs derived relationships and source ownership records after model elements are deleted, replaced, moved, or folded.
_Avoid_: Operation-local orphan cleanup, duplicated sourceMap deletion, stale group membership

**Scryer Structural Mutation Planner**:
The Native Scryer Engine module that turns requested structural writes into validated atomic mutation plans before state-store commits them.
_Avoid_: Operation-local mutation orchestration, partial batch writes, adapter-owned structural semantics

**Scryer Model Correction**:
A model change that says the code is already right and the model should catch up.
_Avoid_: Future implementation work, ordinary draft edit

**Scryer Drift Verdict**:
A decision that resolves a drift observation by adopting, rejecting, re-implementing, dropping, or rewording it.
_Avoid_: Raw drift detection, automatic code truth

**Scryer Completion Gate**:
The Orca check that decides whether an ended Scryer agent run has actually closed its model work.
_Avoid_: Blind agent-done commit, prompt-only success

**Background Scryer Run**:
A non-interactive Orca execution mode for Scryer agent work.
_Avoid_: Hidden interactive terminal, mandatory visible session

**Visible Agent Handoff**:
A mode where Orca opens or resumes a visible agent session so a human can inspect, continue, or redirect Scryer work.
_Avoid_: Default automation path, required terminal for every run

**Scryer CLI Command Surface**:
The Orca command set that lets agents, scripts, and humans invoke Scryer operations.
_Avoid_: External product tool server, one-off shell wrappers

**Scryer Operation Parity**:
The requirement that upstream Scryer agent-facing capabilities have equivalent Orca operations and commands.
_Avoid_: Best-effort subset, behavior redesign

**Scryer Semantic Reimplementation**:
The migration approach that preserves upstream Scryer behavior while writing Orca-owned implementation code.
_Avoid_: Direct source copy, behavior redesign

**Scryer 0.3 Model**:
The upstream Scryer architecture model vocabulary Orca treats as canonical.
_Avoid_: C4ModelData shadow model, flow data in Scryer model truth

**Scryer Canonical Model Boundary**:
The Native Scryer Engine boundary where only `ScryModel` 0.3 and canonical operation inputs are accepted as domain data.
_Avoid_: Mixed C4ModelData/ScryModel objects, cross-boundary object spread, legacy field compatibility inside engine modules

**Scryer Legacy Adapter Mapping**:
The explicit conversion from existing Orca architecture model shapes into Native Scryer Engine model or view shapes.
_Avoid_: Implicit object spread, renderer-owned model semantics, global field renaming

**Orca Scryer View State**:
The Orca-owned state describing how a user is currently viewing a Scryer model.
_Avoid_: Architecture truth, persisted Scryer model field

**Orca Scryer Extension State**:
Project-local Orca-owned data for product features that are not part of the Scryer model.
_Avoid_: Scryer model extension field, hidden model migration

**Scryer Render Cache**:
Regenerable display data derived from a Scryer model for drawing the Architecture tab.
_Avoid_: Canonical layout model, architecture semantics
