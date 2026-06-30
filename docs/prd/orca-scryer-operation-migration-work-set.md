# PRD: Orca Scryer Operation Migration Work Set

Status: partially implemented; default-model Architecture slice release gate closed, full operation parity open
Date: 2026-06-25

## Source

- Decision map tickets: `docs/orca-scryer-decision-map.md` #16-#24
- Foundation PRD: `docs/prd/orca-scryer-engine-catalog-foundation.md`
- Operation parity map: `docs/scryer-cli-tool-parity.md`
- Deep-module ADR: `docs/adr/0025-use-deep-engine-modules-for-scryer-operation-migration.md`
- Upstream read strategy anchors:
  - `scryer/crates/scryer-mcp/src/tools/read.rs`
  - `scryer/crates/scryer-mcp/src/helpers.rs`
  - `scryer/crates/scryer-mcp/src/instructions.rs`
  - `scryer/crates/scryer-mcp/src/types.rs`

## Implementation Status

This work set is partially implemented. Current code has the 33-operation
catalog contract, shared engine seam, and the stable Architecture product slice
behind `executeOperation(...)` and `readView(...)`. That slice has focused
engine, IPC, renderer, and Architecture e2e coverage. The stricter #30/#36
zero-partial release gate for the current Architecture product slice is now
closed and documented in `docs/orca-scryer-architecture-slice-audit.md`.

This document remains useful as the historical specification for full Scryer
operation parity, but it should not be read as proof that every operation below
is executable today. The current catalog still contains operation rows that fall
through to `unimplemented(...)`. Follow-up product-integration hardening through
#29, #31, and #36 have completed for the default-model and read-surface
release-critical paths; full operation parity continues through decision map
#32-#35.

- #25: reconcile linked docs with completed operation migration.
- #26: main-process legacy Scryer semantic fallback retired or reduced to shims.
- #27: stabilize `ScryerEditSessionController` and Completion Gate.
- #28: renderer-facing Architecture View Adapter hard cutover completed.
- #29: live UI intent and behavior coverage expanded and verified.
- #30: audit current executable slice and document catalog reality.
- #36: strict Architecture slice release gate gaps from the #30 audit closed.
- #31: read/query/rules/codebase executors and read-surface gate completed.
- #32: finish structural mutation executors.
- #33: finish health and drift-record executors.
- #34: finish atomic container generation.
- #35: prove remaining adapter and coverage gates.

## Problem Statement

At the time this PRD was written, the Native Scryer Engine catalog foundation
was in place for the first seven operations, and Orca still needed the remaining
upstream Scryer operation families planned, specified, and split into
implementation issues. The Architecture-facing subset has since been carried
through the engine seam and live product coverage. The full parity problem
statement remains active for catalog-only operations that still need executors,
adapter wiring, and tests.

## Scope Decision

This PRD covers the complete Scryer Operation Migration Work Set for decision
map tickets #16-#24. In the planning context, "complete" meant the remaining
operation families were specified and issue-ready together. In current code,
"complete" should only be used with a qualifier such as "default-model
Architecture main path" or "#31 read surface"; the stricter current-slice release
gate remains #36, and the remaining operation-family parity target is #32-#35.

The implementation rule remains relevant for future maintenance: changes should
proceed as vertical operation-family slices. Each task slice should carry real
operations through catalog contracts, zod schemas, pipeline policy, executors,
adapters, fixtures, and focused tests. Do not create horizontal slices that only
add shared infrastructure without proving user- or agent-visible operation
behavior.

## Operation-Family Slices

1. Read/query operations:
   `scryer.model.search`, `scryer.model.query`, `scryer.rules.read`,
   `scryer.codebase.read`, plus the Scryer Read Surface upgrade and any
   remaining `scryer.model.read` parity gaps. Current status: completed for
   #31 as a zero-partial read parity slice with engine executors, strict
   schemas, Orca CLI commands, golden payload tests, no-write fingerprints, and
   ownership tests.
2. Core structural writes:
   `scryer.model.set`, `scryer.node.set-subtree`, `scryer.node.delete`,
   `scryer.node.move`, `scryer.node.descope`, `scryer.responsibility.move`,
   and `scryer.link.update`. Current status: `model.set`, `node.delete`, and
   `link.update` are executable; `set-subtree`, `node.move`, `node.descope`,
   and `responsibility.move` remain open for #32.
3. Source and group ownership:
   `scryer.source.update`, `scryer.group.set`, `scryer.group.update`, and
   `scryer.group.delete`. Current status: executable for the Architecture
   product slice; full adapter/coverage gate continues in #35.
4. Intent writers:
   `scryer.person.add`, `scryer.system.add`, `scryer.container.add`,
   `scryer.component.add`, `scryer.group.add`, and `scryer.symbol.add`.
   Current status: executable for the Architecture product slice; full
   adapter/coverage gate continues in #35.
5. Drift and health:
   `scryer.drift.get`, `scryer.drift.flag`, `scryer.drift.reconcile`, and
   `scryer.model.health`. Current status: `drift.get` and `drift.reconcile`
   are executable; `drift.flag` and `model.health` remain open for #33.
6. Atomic generation:
   `scryer.container.fill`. Current status: open for #34.
7. Adapter retirement:
   Architecture UI, IPC, CLI, agent runtime bridge, and legacy compatibility
   callers cross the Native Scryer Engine seam through `executeOperation(...)`
   or `readView(...)`. Current status: Architecture stable path completed;
   remaining operation adapters and coverage continue in #35.

## Non-Goals

- Do not implement the remaining operations as one giant PR.
- Do not reintroduce Scryer MCP as an Orca product path.
- Do not migrate the Scryer Tauri shell, standalone provider UI, standalone
  docs/templates marketplace, or implicit pre-0.3 normal-runtime migration.
- Do not let operation files own file IO, locks, leases, result envelopes,
  history/baseline writes, source routing, or transport formatting.

## Slice Completion Definition

Each operation-family slice is complete only when it carries the included
operations through:

- catalog contract registration
- input, success result, error detail, and warning zod schemas
- executor behavior using canonical engine inputs
- state-store, diff/fold, id-minter, validators, source-router, history, or
  baseline integration where the operation policy requires it
- upstream parity fixtures or golden-state tests
- CLI command specs and handlers
- focused engine behavior tests
- representative adapter mapping tests

UI, IPC, and agent runtime callers migrate inside an operation slice only when
that slice touches an existing product path for the included operations. The
remaining Architecture UI, IPC, agent bridge, and legacy semantic owners move in
the final adapter-retirement slice.

#31 has a stricter read-surface completion gate. It is incomplete if any
included read operation still uses a `z.record` success placeholder, lacks an
exact golden payload assertion for upstream behavior, omits a no-write
fingerprint for `.scryer/model.scry` and `.scryer/planned.scry`, lacks
black-box CLI envelope coverage, breaks existing `readView(...)` or
`ArchitectureViewAdapter` tests, or constructs read payloads through
`mcp-tools.ts`, legacy C4 adapters, or ad hoc raw `.scryer` JSON reads instead
of catalog/pipeline executors. The only allowed read-side file effect is the
declared committed `model.read` baseline maintenance behavior.

## Read Surface Decision

The read/query slice must be described and implemented around the Scryer Read
Selector for model-state reads. `readView(...)` becomes a real Read Surface
because one deep engine module, not each adapter, owns the transformation from
canonical model state to agent-, CLI-, UI-, and test-facing model read payloads.

The Read Selector's external seam is small: it receives canonical
committed/planned `ScryModel` state plus a validated read request, and it returns
one validated model read payload. Its implementation owns the complexity behind
that seam:

- model overview, subtree, and full-model payloads
- text search payloads with exact/fuzzy match metadata
- structural query payloads with scope and hit-limit metadata
- read-mode selection guidance such as `recommendedNextReads`
- subtree size degradation into a child skeleton when detailed output would be
  too large

`scryer.rules.read` and `scryer.codebase.read` are still #31 read operations,
but they are sibling executors rather than Read Selector behavior: rules reads
load the Orca-owned rules asset, and codebase reads scan the project tree.

The Read Selector is an internal deep module, not a new product seam. Product
callers keep using `executeOperation(...)`; CLI handlers, IPC, agent callers,
and `ArchitectureViewAdapter` are adapters. They may map flags or renderer
needs to operation inputs and render standard envelopes, but they must not
assemble read payloads, run fuzzy search or query predicates, implement
subtree degradation, or read raw `.scryer` files. Operation executors stay thin:
they select the policy-loaded model layer, invoke the Read Selector, and return
the selector payload through the shared result envelope.

State-store only loads canonical model state. Read/query operation executors
only select the requested model read behavior and call the Read Selector. The
pipeline validates the selected payload schema before returning the shared
operation envelope. CLI, IPC, UI, agents, and tests consume the standardized
payloads; they must not construct overview, subtree, search, or query shapes
from raw model files.

Treat the `scryer.model.read` result shape from the foundation PR as
provisional. The first read/query task slice replaces it with the formal Read
Surface input/result model before implementing the remaining read/query
operations. Catalog input normalization may accept aliases when needed, but
engine and CLI payload fields preserve upstream Scryer names such as `overview`,
`nodeCount`, `internalLinks`, `externalLinks`, `contextNodes`,
`referencesForChildren`, `matched`, `nResp`, and `nProps`. Renderer-facing
DTOs may transform those fields only at the adapter boundary.

`scryer.model.read` uses canonical input
`{ view?: "overview" | "subtree" | "full"; node?: string; layer?: "plan" | "committed"; project?: string }`.
To preserve upstream ergonomics, omitted `view` defaults to `overview` when
`node` is absent and `subtree` when `node` is present. CLI supports
`--view full` and the convenience alias `--full`; both map to `view: "full"`.
`subtree` requires `node`; `overview` and `full` reject `node`; conflicting
`--full --node <id>` style input must return the standard `invalid_input`
envelope. Full reads stay explicit and available for Architecture rendering,
export, debug, fixtures, and direct user requests, but are not the default
first read.

Full reads return a minimal discriminated wrapper rather than a bare model:
`{ view: "full"; layer; version: "0.3"; nodeCount; linkCount; groupCount; model }`.
`recommendedNextReads` is scoped to `model.read` navigation payloads. Overview
may recommend subtree/search/query reads, degraded subtree reads may recommend
direct-child subtree reads, and subtree reads may recommend related context
targets. Search/query results already carry candidate ids, rules misses carry
guidance, and codebase reads carry entries; those payloads do not require
`recommendedNextReads` for #31.

The test surface follows the module seams. `read-selector.test.ts` owns exact
in-memory golden payloads for overview, subtree, explicit full reads, search,
query, caps, truncation, exact/fuzzy match metadata, and oversized-subtree
degradation. Operation tests own catalog, pipeline, schema validation,
standard envelopes, layer selection, committed-read baseline maintenance,
standardized errors, and read no-write fingerprints. Black-box CLI tests own
command specs, flag mapping, JSON envelopes, and exit codes; they should not
duplicate the selector's detailed fuzzy/query fixtures.

Search parity is defined by observable upstream behavior, not by reproducing
Rust scoring internals byte-for-byte. Terms are split on whitespace and ANDed
across `name`, `description`, `technology`, responsibility statements, and
property labels. Exact substring matches must rank above fuzzy matches; results
sort by descending score while preserving model order for ties; optional `kind`
filters by Scryer kind; cap is 50; and each result exposes upstream-style
`matched` entries with `field`, `value`, `match: "exact" | "fuzzy"`, and
`score`.

Query parity is limited to the upstream predicate language in #31. Supported
fields are string `kind`, `name`, `description`, and `technology`; boolean
`external`, `visual`, `empty`, and `vagrant`; number `responsibilityCount`,
`propertyCount`, and `childCount`; plus count aliases `responsibilities`,
`properties`, and `children`. Conditions are ANDed. Operators are `eq`/`ne` for
all field types, `contains` for strings, `gt`/`gte`/`lt`/`lte` for numbers, and
upstream-style `exists`/`absent` presence checks. Unknown fields, invalid
operators, type mismatches, and malformed predicates return `invalid_input`;
unknown `under` scope returns `not_found`; cap is 200. `empty` remains the
upstream empty-symbol semantic and must not mean "node has no children."

Read-operation failures use Orca's standard `ScryerOperationResult` envelope,
not upstream MCP prose. `invalid_input` covers malformed search, query, kind,
view, and view/node combinations; `not_found` covers missing subtree and
query-scope nodes; `io_error` covers codebase scan/path failures;
`incompatible_model` comes from existing state-store compatibility and
closed-schema checks; and `internal_error` covers Read Selector invariants or
success-schema validation failures. CLI `--json` prints the envelope unchanged;
non-JSON CLI output may be human-readable but exits non-zero for `ok:false`.

Rules and codebase read payloads are structured even though upstream MCP renders
text. `scryer.rules.read` returns a rules index when `topic` is absent, full
matching rule bodies when `topic` hits, and a miss payload with
`guidance: "choose_topic_from_index"` plus the index when no topic matches. It
must not return one preformatted text blob from the engine. `scryer.codebase.read`
returns a structured project-tree payload with `root`, ordered entries
(`path`, `name`, `kind`, `depth`, `markers`), and summary counts. CLI non-JSON
rendering may format those payloads as upstream-style text; JSON, engine, and
agent callers consume the typed structure.

`scryer.codebase.read` must stay a bounded modeling-context scan. It accepts
only project/workspace-contained paths, respects `.gitignore`, skips
dependency/build folders such as `.git`, `node_modules`, `dist`, `build`,
`out`, `.next`, `.turbo`, `target`, and `coverage`, and returns stable-sorted
entries. Depth and entry caps are part of the contract and must surface
`truncated: true` when applied. Marker detection is deterministic: manifests
include common package/build files such as `package.json`, `Cargo.toml`,
`pyproject.toml`, `go.mod`, `pom.xml`, and Gradle files; infrastructure includes
`Dockerfile`, `docker-compose.yml`, `fly.toml`, `.github/workflows/*`, and
Terraform files; environment templates include `.env.example`, `.env.sample`,
and `.env.template`.

No-write fingerprints are a #31 release gate. Plan-layer `model.read`, search,
query, rules reads, and codebase reads must not change `.scryer/model.scry`,
`.scryer/planned.scry`, `.scryer/history.jsonl`, `.scryer/.sync`,
`.scryer/.anchors.json`, `.scryer/.build_edges.json`, or
`.scryer/model.baseline.scry`. A committed `model.read` may refresh only
`.scryer/model.baseline.scry`; it must not mutate model truth or drift/history
sidecars.

Golden tests should use a small purpose-built Scryer 0.3 model, not a large
real project model. The fixture must cover hierarchy, an empty symbol, internal
and external links, groups, name/description/responsibility/property search
matches, sourceMap entries, and boundaries. Stress fixtures are separate and
generated for cap/degradation behavior: 51 search hits, 201 query hits, and an
oversized subtree. Stress tests assert cap/truncation/degradation outcomes, not
a full large golden payload.

#31 adapter scope is deliberately narrow. It does not add new renderer UI,
rules-browser UI, codebase-tree UI, Electron live workflows, or new agent
workflow/prompt behavior. It must keep existing generic operation adapters
usable: focused IPC/adapter coverage should prove #31 read operations can cross
the generic `executeScryerOperation` / `executeOperation(...)` path and return
standard envelopes. Full remaining product-surface and adapter coverage belongs
to #35.

CLI coverage is black-box through the real command dispatch path. Tests must
run commands for model read overview, subtree, and explicit full reads; model
search; model query through `--json-input -`; rules index and topic reads; and
codebase read. Assertions cover command availability, argument mapping,
parseable JSON stdout, operation ids, result shape, and non-zero exit for
invalid input. Handler-only, command-spec-only, or engine-mocked tests do not
satisfy #31.

Ownership tests should statically reject legacy or adapter imports in #31 read
implementation files. `model-read`, `model-search`, `model-query`,
`rules-read`, `codebase-read`, and `read-selector` must not import
`mcp-tools.ts`, model-store modules, legacy C4 adapters/types, renderer
modules, or CLI modules. Filesystem access is allowed only in `codebase-read`
or a private scan helper; rules asset access is allowed only in `rules-read`.

#31 may be implemented in phases, but it is not complete until every phase and
gate passes. The implementation order should be: Read Selector plus small and
stress fixtures; strict schemas; `model.read/search/query`, `rules.read`, and
`codebase.read` executors; CLI specs and handlers; selector, operation,
no-write, ownership, black-box CLI, and focused generic IPC tests; then
docs/status cleanup. Engine-only work, CLI-only work, or tests missing
no-write/ownership coverage remain partial. After #31 closes, full Scryer
operation parity is still open until #32-#35 close.

Organize the #31 PR as one vertical slice with logical commits: first
`docs: tighten #31 read parity gate`, then `feat: implement #31 read surface
executors`, then `feat: expose #31 read operations through CLI`. The first
commit contains only decision/PRD/parity documentation; the implementation
commits carry code and tests.

### Upstream Read Strategy To Preserve

Upstream Scryer uses drill-down reads rather than default full-model dumps. Orca
preserves that strategy through the Read Selector:

- A model read with no node returns overview, not the full model.
- Overview shows the tree down to components and excludes symbols,
  responsibility bodies, property bodies, link bodies, and source-map bodies.
- A node-scoped read returns detailed subtree data, including descendants with
  symbols, responsibilities, properties, internal links, external links with
  context nodes, `referencesForChildren`, source-map entries, and boundaries.
- Oversized subtree output degrades to a direct-child skeleton with approximate
  size and drill-down guidance.
- Search locates concepts with fuzzy, case-insensitive AND matching, paths,
  exact/fuzzy match metadata, and a top-50 cap.
- Query locates shapes with explicit predicates, optional subtree scope, paths,
  counts, and a 200-hit cap.
- Rules reads use index-then-topic drill-down. Codebase reads return an
  annotated directory tree when no model exists or codebase structure is the
  question.

### Read Mode Selection Policy

`overview` is the default read mode for `readView(...)`, `scryer.model.read`,
CLI read commands, and agent first reads. `subtree` is the normal detail path
after overview, search, query, health, drift, pending work, UI selection, or
user instruction identifies a target node. `search` and `query` are the locator
paths when the caller knows a concept or shape but not the node id.

`full` remains available for whole-model uses: export, backup, debug, golden
fixture comparison, legacy compatibility, cross-subtree restructuring that
cannot be answered from overview plus scoped reads, or a direct user request.
Do not require a `purpose`, `reason`, or approval field in the full-read input
contract. Full-read selection is an agent and adapter judgment guided by policy,
not a schema-enforced reason-code gate.

### Overview Payload Requirements

The overview payload is not a compressed full model. It is the navigation map
that lets an agent decide whether to use search, query, subtree, or explicit
full reads next. It must include:

- top-level metadata: selected `view`, selected `layer`, model `version`,
  `nodeCount`, `linkCount`, `groupCount`, and whether the payload was truncated
  or degraded
- a tree from roots through components, with symbols excluded as child nodes
- for each visible node: `id`, `name`, `kind`, `path` or breadcrumb,
  description where present, technology/external markers where present, child
  count, direct symbol count, responsibility count, property count, and group
  membership count where applicable
- coverage and navigation signals, such as whether the node has source anchors,
  boundaries, external links, stale/vagrant markers, hidden symbol descendants,
  or child nodes that can be drilled into
- `recommendedNextReads` or equivalent guidance for subtree, search, query, and
  explicit full reads

The overview payload must not include responsibility bodies, property bodies,
full symbol nodes, full link arrays, source-map bodies, or boundaries bodies.
Those belong to subtree or full reads.

The read/query slice must not modify write-operation semantics. Its refactor
boundary is the Read Surface, read-only operation contracts, shared read
schemas, CLI read commands, and view-adapter read mapping.

## Core Structural Write Decision

The core structural write slice must be described and implemented around a
Scryer Structural Mutation Planner. The operation catalog and pipeline still
own registration, policy, locks, leases, validation envelopes, and result
envelopes; the planner owns the model-level transformation from a requested
structural edit into a validated atomic mutation plan.

The planner's external seam is small: it receives loaded committed/planned
state plus one canonical structural mutation request, and it returns either a
structured failure or one complete commit plan for state-store. Its
implementation owns the complexity behind that seam:

- operation-specific structural semantics for set, subtree replacement, delete,
  move, descope, responsibility move, and link update
- whole-batch validation and atomicity
- structural hard-error versus warning classification
- candidate-model construction before any durable write
- ownership-preserving moves for nodes and responsibilities
- link endpoint identity and legality rules
- structural cleanup requests for links, groups, `sourceMap`, `boundaries`,
  stale markers, and vagrant markers

Operation executors express intent only. They must not own file IO, partial
write recovery, private orphan cleanup, link topology rules, source routing, or
fold cleanup. Adapters choose operations and provide canonical input; they must
not implement structural semantics outside the engine seam.

### Replacement Operations

`scryer.model.set` and `scryer.node.set-subtree` remain available to agents and
adapters, but they are high-risk structural replacement operations rather than
ordinary interactive edits. The operation registry should mark them with
`risk: "high"`, `operationClass: "structural_replacement"`, and write scopes
such as `whole_model` or `subtree`. Tool guidance must explain that they replace
large model regions and should not be the default path for small interactive
edits. Ordinary editing guidance should prefer typed or intent operations such
as intent add operations, node update/move/delete, responsibility move, and link
update.

Do not require `purpose`, `reason`, approval, audit, undo, redo, save, or
recovery storage for these operations in this work set. Agents choose whether a
structural replacement is the right tool, but every call still crosses
`executeOperation(...)`, catalog policy, zod input/result validation,
structural validators, locks/leases, state-store transaction commits, and the
shared result envelope.

Raw replacement payloads must separate structural hard errors from warnings.
Malformed JSON or object shape, missing or unsupported schema version, duplicate
ids, missing parents, invalid hierarchy, cycles, children under external nodes,
links with missing endpoints, self-links, illegal link topology, and
`sourceMap` or `boundaries` entries that reference unknown ids are hard errors.
Warnings may be returned without blocking when the model is structurally usable
but incomplete, such as empty symbols, missing descriptions, missing source
anchors, unmapped claims, or other quality findings.

### Planned Structural Semantics

`scryer.node.delete` and `scryer.node.descope` have different meanings.
`node.delete` is a planned deletion: it stages code-removal work in planned
state, and committed state must not pretend the code is gone until the deletion
is implemented and folded. `node.descope` is a model correction: code may remain,
but the model should stop representing it at that altitude; it writes planned
and committed state together where upstream semantics require that correction.

`scryer.node.move` is a structural move, not delete-and-recreate. The moved node
keeps its id, responsibilities, properties, descendants, and source anchors.
The planner validates the new parent, C4 hierarchy, cycles, external-parent
rules, old group membership cleanup, and resulting link legality. Orca is
stricter than upstream's "move, then validate" guidance: a move that would leave
illegal links should fail with structured validation details that identify the
links requiring update or deletion.

`scryer.responsibility.move` preserves the responsibility id and source anchors.
`sourceMap` ownership follows the responsibility id, not the old node. This
matches upstream `move_responsibilities`, which moves the same responsibility
object to the destination owner and relies on id-keyed `source_map`; fold later
commits the responsibility by id to the planned owner and keeps anchors in
lockstep.

`scryer.link.update` preserves endpoints. It may patch descriptive fields such
as `label` and `method`, but it must not accept `src` or `dst` as patchable
fields. Endpoint changes are relationship replacement and must be modeled as
explicit `scryer.link.delete` plus `scryer.link.add`, so the add path re-runs
endpoint existence and link-legality validation. This matches upstream's public
`update_links` shape.

### Atomicity And Cleanup

Batch structural writes are atomic. For operations that accept multiple items,
such as node moves, responsibility moves, link updates, deletes, and replacement
payloads, the planner validates the whole candidate mutation before state-store
commits anything. If any item is missing, illegal, malformed, or would leave the
model invalid, the operation returns a structured failure and the
committed/planned files remain unchanged.

Structural cleanup is shared engine behavior, not duplicated operation-local
deletion code. Validators detect orphan links, missing endpoints, invalid group
membership, illegal hierarchy, and source entries that point at unknown ids.
`source-router` owns single-home routing and removal of `sourceMap` and
`boundaries` entries when owning elements are deleted, replaced, moved between
layers, or folded. `diff/fold` owns cleanup while applying planned elements into
committed state, including deleted nodes, moved responsibilities, source
entries, stale markers, and vagrant markers. `state-store` owns transactional
persistence so cleanup and the semantic write commit together or not at all.

Tests for this slice must exercise the Structural Mutation Planner seam rather
than operation internals: delete versus descope, node identity preservation,
subtree preservation, responsibility anchor preservation, link endpoint
protection, batch atomicity, hard-error rejection, warning-with-commit behavior,
orphan cleanup, invalid group membership cleanup, sourceMap/boundaries cleanup,
and fold-time cleanup parity with the planned mutation.

## Source And Group Ownership Decision

The source/group ownership slice must keep source mapping ownership behind the
Scryer Source Router and group semantics behind the Scryer Group Ownership
Planner. These operations land together because they both attach secondary
ownership information to the model, but they are not one module internally.

### Source Router

`scryer.source.update` is the operation entrypoint for updating code-side
mapping, but it must not decide by itself whether a source entry belongs in
committed state or planned state.

The Source Router's external seam is small: it receives loaded
committed/planned state plus validated source update entries, and it returns a
commit plan plus any normalization warnings. Its implementation owns the
complexity behind that seam:

- responsibility source anchors keyed by responsibility id
- schema source anchors keyed by property-bearing node id
- boundary source globs keyed by node id
- single-home routing across committed and planned state
- clearing entries from the owning layer when locations or sources are empty
- removal of stale planned shadow entries when a committed element receives a
  committed-side mapping
- whole-symbol range normalization to symbol-only anchors

The routing rule preserves upstream Scryer behavior. If the target element
exists in committed state, its source entry is written to committed state and
removed from planned state. If the target element exists only in planned state,
its source entry is written to planned state. Fold later moves selected planned
source entries into committed state and deletes no-longer-needed planned
entries.

Source update failures must separate model-reference errors from source-quality
warnings. The operation must fail without writing when an input item references
a missing responsibility id, a missing schema node id, a schema node without
properties, a missing boundary node id, malformed locations or sources, or
conflicting updates for the same key in one request. The operation may commit
and return structured warnings when the referenced model object is valid but
the source anchor quality is imperfect: a line range covers the whole enclosing
symbol and is normalized to symbol-only, the anchor lacks a symbol, the file
pattern cannot be verified at update time, or a boundary glob looks broad or
narrow but still belongs to an existing node.

Operation executors express intent only: update these source anchors, schema
anchors, or boundaries. They must not own committed/planned routing, direct file
IO, lock handling, fold cleanup, whole-symbol normalization, or transport
formatting. Adapters and agents choose when to call `scryer.source.update`, but
they must not duplicate source ownership rules outside the engine seam.

Tests for this part of the slice must exercise the Source Router seam:
committed responsibility source updates write committed and clear planned
shadows; planned-only responsibility source updates write planned; schema
source entries require property-bearing nodes; boundary entries require node
ids; empty locations or sources clear entries; whole-symbol ranges normalize to
symbol-only anchors and return warnings.

### Group Ownership Planner

`scryer.group.set`, `scryer.group.update`, and `scryer.group.delete` must be
described and implemented around a Scryer Group Ownership Planner. A group is a
secondary organization axis inside `ScryModel`: it groups sibling nodes under a
parent node view to represent a package, module, feature area, deployment unit,
or ownership unit. It is not a node status field, not the primary parent-child
hierarchy, and not just a renderer overlay.

Group operations are semantic model edits and write planned state by default.
They do not use Source Router-style committed/planned routing and must not
perform committed-side writes in the ordinary operation path. Committed group
state changes through fold or an explicit future migration/import/repair policy,
not through default `group.set`, `group.update`, or `group.delete` calls.

v0.3 still uses a C4-style model hierarchy as its primary structure:
person, system, container, component, and symbol. `ScryModel` extends that
hierarchy with code symbols, responsibilities, source ownership, planned state,
folding, drift, and health semantics. Group operations must therefore preserve
the primary hierarchy while adding or changing the secondary grouping axis.

The Group Ownership Planner's external seam is small: it receives loaded
committed/planned state plus one canonical group mutation request, and it
returns either a structured failure or one complete commit plan for state-store.
Its implementation owns the complexity behind that seam:

- raw group replacement for generation-oriented `group.set`
- typed group patching for `group.update`
- group deletion without deleting member nodes
- same-level member validation
- parent-node anchored membership validation
- nested group parent validation
- group responsibility validation
- direct child-group detach when a group is deleted

`scryer.group.set` remains available, but it is a high-risk generation
primitive rather than the default path for ordinary group edits. It accepts raw
group JSON and may create or replace multiple groups, so it is appropriate for
codebase-to-model generation, parity fixtures, migrations, and repair work.
Tool guidance should steer ordinary agent edits toward typed group operations:
add a group with `scryer.group.add`, patch fields with `scryer.group.update`,
and remove a group with `scryer.group.delete`.

For `scryer.group.set`, Orca should enforce group structure more strictly than
upstream's current `set_groups` implementation while preserving upstream tool
intent. The planner must fail without writing when the raw JSON is malformed,
the group array is empty, group ids are duplicated in the same request,
`parentNodeId` is missing or unknown, a group has fewer than two members, a
member id is unknown, a member is not a direct child of `parentNodeId`, members
mix levels, `parentGroupId` points at an unknown group, nested group parentage
forms a cycle, or group responsibilities contain duplicate ids. The planner may
commit and return warnings for quality issues that do not break structure, such
as a missing description, missing group responsibilities, or an unrecognized
icon name.

`scryer.group.update` is patch-only. It may change `name`, `description`,
`memberIds`, and `responsibilities`, but it must not accept `parentNodeId` or
otherwise re-parent the group. This preserves upstream MCP behavior: replacement
members are validated against the group's existing parent node. If interactive
group re-parenting becomes necessary later, it should be an explicit
`scryer.group.move` operation with its own validation rather than hidden inside
ordinary update semantics. Migration or repair can use `scryer.group.set`.

Operation executors express intent only: set these groups, patch these group
fields, or delete this group. They must not own group membership rules, nested
group cleanup, direct file IO, lock handling, renderer layout behavior, or
transport formatting. Renderer group overlays are derived views of committed or
planned `ScryModel` group data and must not own group semantics.

Tests for this part of the slice must exercise the Group Ownership Planner
seam: `group.set` rejects malformed JSON and invalid members; `group.update`
patches only supplied fields; replacement membership requires existing sibling
nodes under the group's parent; mixed-level members fail; deleting a group does
not delete member nodes; direct child groups are kept and have `parentGroupId`
cleared; group responsibilities are preserved and validated.

## Intent Authoring Decision

The intent writer slice must be described and implemented around a Scryer
Intent Authoring Planner. These operations are Orca's preferred agent authoring
path for interactive modeling because callers provide intent, while the engine
turns that intent into valid planned `ScryModel` additions.

The planner's external seam is small: it receives loaded committed/planned
state plus one canonical authoring request, and it returns either a structured
failure or one complete commit plan for state-store. Its implementation owns
the complexity behind that seam:

- node id minting through the shared `ScryerIDMinter`
- group id minting through the shared `ScryerIDMinter`
- responsibility id minting across node-owned and group-owned responsibilities
  through the shared `ScryerIDMinter`
- parent existence and parent-kind validation
- fixed node kind selection from the operation and parent level
- responsibility construction from plain authoring statements
- container boundary update intents from `boundaryDir`
- symbol responsibility source update intents from `sourceFile`, symbol name, and
  optional line ranges
- symbol schema source update intents for property-bearing symbols
- planned-state authoring and result payload construction

The planner must not implement its own id scanning logic. It uses the shared
Scryer ID Minter with committed state, planned state, and current batch
reservations so a multi-item request cannot mint duplicate node, group, or
responsibility ids. Ordinary intent add operation inputs must not accept
caller-supplied ids. Import, migration, and repair flows that need preserved ids
belong to explicit replacement or repair operations, not the normal intent
authoring path.

Ordinary intent add operation inputs must not accept caller-supplied `kind`.
The operation name fixes the model element being created: `scryer.person.add`
and `scryer.system.add` create top-level nodes, `scryer.container.add` creates a
container under a system parent, `scryer.component.add` creates a component
under a container parent, and `scryer.symbol.add` creates a symbol under a
component parent. `scryer.group.add` creates a group rather than a node; its
`parent_id` must identify an existing node and its members must be direct
children of that parent. Inputs that try to express a different kind belong to
replacement, import, or repair operations, not intent authoring.

Intent add validation must separate structural failures from quality warnings.
The planner must fail without writing when `items` is empty, a name is blank, a
required parent id is missing, a parent id does not exist, a parent kind does
not match the operation, `group.add` has fewer than two members, a group member
is missing or not a direct child of the group parent, `symbol.add` has a blank
`sourceFile`, a symbol has neither responsibilities nor properties, or a symbol
property label is blank. If `boundaryDir` is provided but trims to an empty
string, treat it as absent rather than as a hard error.

The planner may commit and return warnings for model-quality gaps that do not
break structure: missing descriptions, missing responsibilities on
non-symbol nodes or groups, missing technology, skipped blank responsibility
statements, incomplete responsibility line ranges, source patterns that cannot
be verified at authoring time, and absent `boundaryDir`.

Multi-item intent add operations are atomic. The planner validates and plans
the full batch before state-store writes anything. If any item has a hard
error, no node, group, responsibility, `sourceMap` entry, or boundary from the
request is committed. Warnings do not block the batch, but they must be returned
in the validated operation result.

Successful intent add results must return a structured summary, not prose that
agents or adapters need to parse. The result includes an `added` list with each
new element's minted `id`, `kind`, `name`, parent id or parent node id,
responsibility ids, symbol property labels where applicable, source keys, and
boundary keys. The result also includes validated warnings and
`recommendedNextReads` so agents can inspect the affected subtree without
reading the full model. Intent add results must not return the full model.

Responsibility inputs must preserve upstream altitude rules. Person, system,
container, component, and group add operations accept plain `string[]`
responsibilities because those responsibilities describe architecture or
business altitude and should not be tied to line ranges. `scryer.symbol.add`
accepts `Array<string | { statement, line?, endLine? }>` so symbol-level
responsibilities can carry line-precise source anchors. `line` and `endLine`
affect source anchoring only; they do not change responsibility meaning. Intent
add operations must not accept responsibility directives. Directives are
user-authored constraints or later edits, not the ordinary agent authoring path.

The `external` field is accepted only by `scryer.system.add` and
`scryer.container.add`, matching upstream intent writer behavior. Person,
component, symbol, and group add inputs must reject `external`; expanding
external semantics to other model kinds requires a separate model decision.

Source and boundary data produced by intent authoring must still cross the
Scryer Source Router. The planner may derive boundary updates from
`boundaryDir`, responsibility source updates from `sourceFile` plus symbol name
and optional line ranges, and schema source updates for property-bearing
symbols. It must not directly own the committed/planned destination rule for
those entries. Because newly authored elements exist only in planned state, the
Source Router normally writes these entries to planned state; centralizing the
rule keeps intent authoring, explicit `scryer.source.update`, fold, and cleanup
consistent.

Operation executors express intent only: add these persons, systems,
containers, components, groups, or symbols. They must not own id minting,
parent/kind hierarchy rules, responsibility construction, source-map or boundary
side effects, direct file IO, lock handling, result payload shaping, or
transport formatting. Adapters and agents should prefer typed intent operations
over `scryer.model.set` and `scryer.node.set-subtree` for ordinary interactive
modeling.

## Drift And Health Decision

The drift/health slice must preserve the upstream separation between scope
detection, semantic verdict recording, reconcile baselines, and health
observability. `scryer.drift.get` is not a semantic verdict. It is a detector
that tells agents which code-owned model scopes need review.

### Drift Scope Detector

`scryer.drift.get` must be described and implemented around a Scryer Drift
Scope Detector. The detector's external seam is small: it receives canonical
model state, project file metadata, and the persisted reconcile anchor, and it
returns stable changed scopes. Its implementation owns the complexity behind
that seam:

- reading `.scryer/.sync` reconcile anchor state
- first-run sync bootstrap so a never-reconciled model does not report the
  whole project as drifted
- mtime-based changed-file detection after the reconcile timestamp
- git changed-file refinement when the sync anchor includes a commit
- untracked-file inclusion for dirty worktrees
- boundary ownership lookup using the most-specific owning node
- per-node reconcile overrides for dismissed subtrees where supported
- stable scope ordering and changed-file lists

The detector must not judge whether a responsibility, property, or node is
semantically wrong. A changed file means "review this scope", not "the model is
wrong". The detector must not write `vagrant`, `stale`, `staleProposal`, history
events, or source anchors. Those decisions belong to `scryer.drift.flag` after
an agent or user has reviewed the changed code.

If no sync baseline exists, `scryer.drift.get` bootstraps the sync state and
source-anchor baseline from the current code state, then returns clean/no drift.
This avoids reporting the whole project merely because there is no prior
baseline. The bootstrap is a declared maintenance write, not a semantic verdict
and not proof that the model is correct.

The detector should preserve upstream internal support for per-node reconcile
overrides in `SyncState.nodes` and scope calculation. However, #20 exposes only
the upstream-compatible global `scryer.drift.reconcile` operation. Do not add a
public `reconcile-node` or partial reconcile operation in this slice; that would
require a separate product decision about review tracking and user/agent
workflow.

### Drift Verdict Recorder

`scryer.drift.flag` must be described and implemented around a Scryer Drift
Verdict Recorder. The recorder's external seam is small: it receives loaded
planned state plus reviewed drift findings, and it returns either a structured
failure or a complete planned-state commit plan with history events. Its
implementation owns the complexity behind that seam:

- take-code findings as vagrant responsibilities
- take-code data findings as vagrant properties
- take-model findings as stale responsibilities
- changed-but-not-gone findings as stale proposals
- stale data fields by node id and property label
- whole-node stale markers for removed backing code
- routing undescribed behavior to the finest owning node
- minting vagrant node chains for unmodeled code when requested
- source anchor update intents for vagrant findings
- history events that record "took code" or "took model" verdicts

Source anchors produced by `scryer.drift.flag` must still cross the Scryer
Source Router. The recorder may derive anchors for vagrant responsibilities,
vagrant properties, and minted vagrant nodes, but it must not directly own the
committed/planned destination rule for those `sourceMap` entries. Because newly
flagged vagrant facts exist in planned state, the Source Router normally writes
their anchors to planned state.

The recorder must produce one atomic planned-state commit plan for semantic
verdict changes. If any hard error is found, no vagrant responsibility,
vagrant property, vagrant node, stale flag, stale proposal, or source anchor
from the request is committed. History events are sidecar maintenance records:
attach them to the same transaction when state-store supports transactional
sidecars; otherwise write them after the planned commit as best-effort
maintenance writes. History write failures should return warnings without
rolling back a successful planned verdict commit. The write order must prevent a
history event from being recorded when the planned verdict did not commit.

The recorder must not detect changed files, perform semantic code analysis by
itself, advance reconcile anchors, compute health rollups, or write committed
state. It records a reviewed verdict into planned state so the user or agent can
later adopt, reject, re-implement, drop, or reword the finding through the
normal planning and fold flow.

### Drift Reconcile Baseline

`scryer.drift.reconcile` must preserve upstream reconcile semantics. It advances
the global drift reconcile baseline by writing `.scryer/.sync` with the current
time and current git commit when available, then refreshes the source-anchor
fingerprint baseline. Future `scryer.drift.get` calls compare against this new
baseline so already-reviewed code changes do not keep resurfacing as old drift.

`scryer.drift.reconcile` does not prove semantic correctness and does not verify
that review actually happened. It also does not record stale or vagrant
verdicts. In this work set, do not require reviewed scope ids in the input and
do not introduce durable review-state tracking. Tool guidance must make the
contract explicit: callers should run reconcile only after reviewing every
scope returned by `scryer.drift.get` and recording any findings with
`scryer.drift.flag`. If a caller skips a scope and reconciles anyway, that old
change is considered reviewed for future drift detection.

### Health Reporter

`scryer.model.health` must be described and implemented around a Scryer Health
Reporter. Health is a read/report operation that derives observability output
from model state, source anchors, vagrant/stale flags, anchor observations, and
link evidence. It is not a semantic drift verdict and must not write planned or
committed model meaning.

For upstream compatibility, health may perform declared maintenance writes:
sync-state bootstrap when no reconcile anchor exists, source-anchor fingerprint
baseline bootstrap, and silent re-anchor of moved-but-unchanged symbols when the
anchor checker can repair anchors deterministically. The operation catalog must
mark this as a read/report operation with maintenance writes rather than a pure
read or a semantic write. It may write `sync_state`, `anchor_baseline`, or
source-anchor reanchor maintenance data; it must not write stale/vagrant
verdicts, planned semantic edits, committed semantic edits, or drift history
events.

Health payloads should separate core observability from conditional evidence.
Core fields must include whole-model totals, scoped node own counts, scoped node
subtree counts, child subtree summaries where a node scope is requested,
vagrant and stale counts, anchorable/anchored/unmapped counts, anchor
observations, and `recommendedNextReads` for affected subtrees. Conditional
fields should be present only when the supporting evidence exists: link audit
and unmodeled code edges require build edge evidence, edge graph status reports
whether that evidence was available, reanchored counts require an anchor check,
and boundary dark files require a modelable source-file inventory. Missing
conditional evidence is reported as absent or unavailable; it is not guessed and
does not turn health into a write failure.

## Atomic Container Generation Decision

`scryer.container.fill` must be preserved as an atomic generation operation and
described around a Scryer Container Generation Planner. This operation is not a
macro over `component.add`, `symbol.add`, `group.add`, and link operations. It
accepts one complete semantic proposal for one existing container, validates the
proposal, mints every required id, resolves request-local keys, derives source
anchors and links, and returns one complete committed/planned commit plan.

The operation registry must mark `scryer.container.fill` as a high-risk
generation primitive, not as an ordinary interactive edit. Its catalog metadata
should declare `risk: "high"`, `operationClass: "generation_primitive"`, and
write scopes for both committed and planned model state, plus declared
best-effort history sidecar writes. Tool metadata, JSON schema descriptions,
CLI help, and agent-facing guidance must say that this operation is for initial
code-to-model generation of an empty container. They must also say not to use
it for small edits, not to use it to regenerate an existing component subtree,
not to provide real model ids, and not to recover from failure by decomposing
the request into many intent operations. These metadata rules guide callers and
adapters; durable safety still comes from schema validation, planner
validation, final model validation, and state-store transaction policy.

The planner's external seam is small: it receives loaded committed/planned
state plus one canonical container generation proposal, and it returns either a
structured failure or an atomic generation plan with minted ids, dropped-link
reports, derived-link counts, source keys, group ids, and recommended next
reads. Its implementation owns the complexity behind that seam:

- full proposal validation before any durable write
- id minting through the shared `ScryerIDMinter`
- request-local component and symbol key resolution
- component and symbol subtree generation under the target container
- group creation through shared group ownership validation
- source anchor generation for responsibilities and property-bearing symbols
- deterministic link derivation from `.scryer/.build_edges.json`
- shared link legality validation for derived and optional links
- optional cross-boundary link placement and non-fatal drop reports
- final assembled-model validation before commit
- committed/planned write planning
- best-effort born/history sidecar events

The planner must not implement operation-local id scanning. It uses the shared
Scryer ID Minter seeded from committed state, planned state, and current batch
reservations. The proposal may use request-local component and symbol keys for
references inside the request, but it must not supply real node, group, or
responsibility ids. Request-local keys do not become model ids, and any local
key that conflicts with an existing model id is a hard error.

Groups in a container generation proposal must reuse the Scryer Group Ownership
Planner's validation rules without giving that module separate durable write
authority. The Container Generation Planner resolves request-local component
keys to the generated component ids and asks the group ownership logic to
validate the proposed group fragment: member keys must resolve, groups must
have at least two members, members must be at the same level, duplicate members
are rejected, and generated group responsibilities must not introduce duplicate
responsibility ids. The resulting group fragment is returned to the container
generation commit plan and written only by the `scryer.container.fill`
transaction. This keeps group semantics in one module while preserving
container generation as one atomic operation.

The target must be an existing node of kind `container` and it must not already
have component children. Filling an already-modeled component subtree is a hard
error. This operation is initial atomic generation for an empty code-bearing
container, not subtree replacement. Regenerating or repairing a previously
filled container requires an explicit future regenerate/repair operation or a
high-risk structural replacement path such as `scryer.node.set-subtree`.

Generation validation intentionally differs from ordinary `scryer.symbol.add`.
Each proposed component must include at least one symbol because a filled
container is code-bearing. Each symbol must have a non-empty local key,
non-empty name, non-empty source file, valid line range when provided, and a
unique `(sourceFile, name)` assignment within the proposal. A generated symbol
may have no responsibilities and no properties. This preserves upstream behavior
and avoids forcing agents to fabricate responsibility text for thin wrappers,
re-exports, UI leaves, entry points, or other real definitions that may later be
folded, pruned, or enriched.

Source anchors produced by container generation still cross the Scryer Source
Router. However, `scryer.container.fill` has a generation policy that differs
from ordinary intent authoring: the generated subtree represents code that
already exists and is written to committed and planned state together. The
Source Router must therefore plan anchors for generated responsibilities and
property-bearing symbols into committed state and mirror them into planned state
so both layers stay aligned. Operation-local code must not duplicate sourceMap
layer routing.

Optional links are non-fatal generation hints. Proposal structure errors such
as a missing target container, wrong target kind, non-empty component subtree,
duplicate keys, component without symbols, missing source file, or invalid line
range reject the whole operation. Optional link placement errors do not: unknown
src/dst, self-links, duplicate links, illegal topology, and unplaceable
cross-boundary links are dropped and returned in a structured `droppedLinks`
report. Derived links come from `.scryer/.build_edges.json`; missing build-edge
cache, ambiguous source locations, or unresolvable endpoints are skipped rather
than guessed or treated as write failures. The result must include
`reports.edgeGraphStatus` so callers can tell whether low link counts mean
there was no dependency evidence or the dependency evidence was unavailable.
Use machine-readable statuses such as `available`, `missing`, `stale`, `empty`,
and `partially_unresolved`.

Generated links must reuse the same link legality rules used by structural
link operations. `scryer.container.fill` may derive links from build-edge
evidence and may accept optional cross-boundary link hints, but it must not own
a separate copy of endpoint, self-link, duplicate-link, level, or topology
rules. The shared link validation/planning logic returns the legal link
fragments and the rejected optional link reports. The final durable write still
belongs only to the `scryer.container.fill` transaction. Illegal required
structural state remains a hard error; illegal optional links are dropped and
reported in `droppedLinks`.

After the planner assembles the proposed committed/planned result, it must run
the shared model validators against the final model snapshots that would be
written. This is a second gate after request validation. Request validation
proves the proposal is well-formed; final snapshot validation proves the
generated subtree, groups, links, source anchors, and preserved surrounding
model still satisfy engine invariants together. A final snapshot validation
failure is a hard error and prevents all durable writes.

Committed and planned model updates must be represented as one state-store
transaction. The planner returns a commit plan that writes the generated subtree
and mirrored source anchors to both layers together. If either layer cannot be
written, neither layer changes. The planned update must preserve existing
planned-only enrichment outside the generated subtree while appending the
generated components, symbols, links, groups, and source anchors. Id minting
must scan committed state, planned state, and current batch reservations so the
generated committed subtree cannot collide with planned-only ids. The operation
must not refresh `model.baseline.scry`, matching upstream behavior.

Born/history events are sidecar maintenance records. Attach them to the same
transaction when state-store supports transactional sidecars; otherwise write
them after the committed/planned transaction as best-effort maintenance writes.
History write failures should return warnings without rolling back a successful
generation commit, and history must not be recorded if the model transaction
fails.

Successful container generation results must return a compact structured
summary, not the full model and not prose that agents must parse. Use this
shape:

- `commit`: whether committed state was written, planned state was mirrored, and
  whether the baseline was refreshed. For this operation, `baselineRefreshed`
  is false.
- `summary`: counts for components, symbols, groups, derived links, dropped
  links, and source anchors.
- `created`: compact id maps for generated components, symbols, and groups.
  Components include `id`, request-local `key`, `name`, `responsibilityIds`,
  and `symbolIds`. Symbols include `id`, request-local `key`, `name`,
  `parentComponentId`, `responsibilityIds`, `propertyLabels`, and `sourceKeys`.
  Groups include `id`, `name`, `memberIds`, and `responsibilityIds`.
- `reports`: structured `droppedLinks`, `edgeGraphStatus`, and warning counts
  or evidence summaries. Structured warning objects still live in
  `ScryerOperationResult.meta.warnings`.
- `recommendedNextReads`: normally a subtree read for the generated container.

The result must not include full node bodies, full source-map bodies, raw build
edge cache data, or the full model. `created` is preferred over `minted` because
the result describes generated model elements, not only id allocation.

Tests for this slice should treat the Scryer Container Generation Planner
interface as the main behavior surface. Planner tests should cover id minting
against committed and planned ids, request-local key resolution, empty-container
requirements, component/symbol validation, group validation reuse, source-router
planning, derived link handling, optional link drop reports, final snapshot
validation, result summary shape, and baseline non-refresh behavior. Engine
pipeline tests should stay thinner: prove the catalog metadata, zod
input/result validation, operation result envelope, error mapping, and
state-store transaction path connect correctly for success and representative
failure cases. Adapter, CLI, IPC, and UI tests should not duplicate planner
behavior; they should verify transport conversion only when a transport is
touched.

`scryer.container.fill` must not refresh `model.baseline.scry` and must not
advance the drift reconcile baseline. This preserves upstream behavior: atomic
container generation writes committed and planned model state, but baseline
refresh remains an explicit build, reconcile, or maintenance behavior outside
this operation. The result should report `commit.baselineRefreshed: false`.

Agents must not assemble `scryer.container.fill` by issuing many intent calls or
raw structural writes. Splitting the operation would leak ordering, rollback,
id collision, source anchor, group, and link derivation complexity to callers
and would leave containers vulnerable to half-generated subtrees.

## Adapter And Runtime Migration Decision

All product callers must cross the Native Scryer Engine seam through
`readView(...)` or `executeOperation(...)`. UI, IPC, CLI, agent runtime, tests,
and compatibility adapters may decide what user or agent intent to express, but
they must not own Scryer model semantics. They must not directly mutate
`ScryModel`, mutate legacy `C4ModelData` as if it were the domain model, choose
committed versus planned write layers, route source anchors, compute group/link
legality, fold planned state, update drift baselines, or format domain failure
payloads. Those rules belong behind the engine interface.

This makes adapters intentionally shallow. A read adapter converts a
`readView(...)` result into the transport shape a caller needs. A write adapter
converts user or agent intent into canonical operation input and passes it to
`executeOperation(...)`. Transport-specific concerns such as renderer selection
state, expanded paths, layout state, CLI flags, IPC channel names, and agent
handoff display data stay outside `ScryModel` and outside engine domain
modules.

Legacy storage helpers such as the existing model-store path may remain only as
temporary compatibility scaffolding while callers are migrated. They must not be
wrapped and kept as the long-term semantic write path. If a UI action changes
Scryer meaning, the adapter must translate that action into a canonical catalog
operation input and call `executeOperation(...)`. Keeping direct helper writes
behind an adapter would still bypass catalog policy, zod validation, result
envelopes, state-store transactions, source routing, group/link legality,
diff/fold rules, drift baseline policy, and structured error mapping.

CLI and IPC adapters must reuse the operation catalog's operation names,
input schemas, success schemas, warning schemas, error-detail schemas, and
`ScryerOperationResult` envelope. They may expose transport-specific syntax
such as flags, JSON stdin, IPC channel names, progress events, or exit-code
mapping, but those surfaces must normalize into catalog input before execution
and format the standard engine result after execution. They must not define
parallel command contracts or transport-only result shapes for the same Scryer
operation.

`ScryerEditSessionController` must reuse Orca's native agent runtime instead of
owning process launch, terminal state, account state, model/effort selection,
generic run status, completion detection, or orchestration context. Its
interface should expose Scryer model-edit intent to Orca runtime and then
translate runtime outcomes back into Scryer follow-up work. The Scryer-specific
controller keeps only model edit lease binding, completion-gated fold
coordination, lease cleanup on cancellation or crash, visible handoff mapping,
post-run pending checks, post-run validation checks, and conversion of agent
outcomes into engine reads or catalog operations. This preserves the earlier
agent-run decision while keeping runtime mechanics out of Scryer domain
modules.

`mcp-tools.ts` must be demoted from semantic owner to temporary compatibility
adapter. During migration it may keep old tool entrypoints, fixture hooks, or
compatibility call shapes only by normalizing them into catalog operation input
and calling `executeOperation(...)` or `readView(...)`. It must not directly
read or write `.scryer/*`, choose write layers, manage state-store commits,
route source anchors, validate group/link legality, update drift or fold
baselines, or format domain failure details. Once product callers no longer
need the old entrypoints, remove it or keep only a pure shim with no Scryer
domain implementation.

`ArchitectureViewAdapter.readView(...)` must return a UI-specific
`ArchitectureViewDto` rather than exposing raw `ScryModel` or legacy
`C4ModelData` to the renderer. This is a hard cutover, not a compatibility
alias. `ScryModel` remains the domain model for architecture facts, and the DTO
is a projection of engine read results into renderer-ready data. Naming follows
`ArchitectureView` plus upstream semantic names: `ArchitectureViewNode`,
`ArchitectureViewLink`, `ArchitectureViewGroup`,
`ArchitectureViewResponsibility`, `ArchitectureViewProperty`,
`ArchitectureViewSourceLocation`, and `ArchitectureViewBoundarySource`.
Fields follow upstream Scryer 0.3 JSON semantics: `nodes`, `links`, `groups`,
`sourceMap`, `boundaries`, `responsibilities`, `properties`, `parentId`,
`memberIds`, `src`, and `dst`. Do not use `edges`, `C4ModelData`, `C4Node`,
`C4Edge`, or `C4NodeData` in Architecture renderer code.

The DTO may include renderer-needed derived facts such as tree rows,
selected-node details, source-map display rows, boundary display rows, group
display data, drift indicators, pending/fold summaries, validation diagnostics,
and recommended next reads. It must not include durable UI-only state such as
selection, expanded paths, active view mode, viewport, layout positions,
measured sizes, tab/session state, diff glow animation state, undo/redo stack,
form drafts, or agent runtime state. A read request may include current
selection so the adapter can return temporary `selectedDetails`, but the
adapter does not own long-lived UI state.

This follows upstream Scryer v0.3's split between model data and view data.
Upstream `ScryModel` contains only `nodes`, `links`, `groups`, `sourceMap`, and
`boundaries` as architecture model fields; it does not persist selected item,
expanded tree paths, workspace view, diagram focus, viewport, node positions, or
Architecture flows/scenarios as model fields. Upstream Scryer 0.3 has no
Architecture `flows` model. Orca should preserve the same rule: view state may
be remembered in Orca UI storage or adapter-local cache when useful, and layout
may be derived or cached for rendering, but none of it is Scryer domain truth
and it must not be written into `.scryer/model.scry`.

Normal Scryer 0.3 runtime uses a closed schema. Engine state-store reads and
writes for `.scryer/model.scry` and `.scryer/planned.scry` must reject unknown
fields instead of ignoring them. Top-level allowed fields are `version`,
`nodes`, `links`, `groups`, `sourceMap`, and `boundaries`; Node/Link/Group and
nested Responsibility/Property/Source/Boundary objects should also reject
unknown fields. Unknown fields return structured `incompatible_model` errors
with `reason: "unknown_fields"` and aggregated dot/bracket paths such as
`flows`, `nodes[0].type`, and `links[0].source`. UI and CLI surface that error
envelope directly; logs are only supplementary.

Do not consider old model compatibility in this cutover. There is no implicit
import, migration, fallback, old `flows`/`scenarios` tolerance, `edges -> links`
conversion, or `C4ModelData -> ScryModel` normal-runtime conversion. If a future
product requirement needs old-project support, it belongs in a separate
explicit import/migration feature, not in the normal Architecture runtime.

Implementation order for #28 is hard cutover: first tighten engine/state-store
closed-schema validation; second add `ArchitectureViewAdapter` and
`architecture:readArchitectureView`; third hard-cut renderer reads to
`ArchitectureViewDto`; fourth hard-cut renderer writes to intent/operation
calls through `executeOperation(...)`; fifth add ownership tests that forbid
Architecture renderer imports of legacy C4 model types and normal edit calls to
`readModelDocument`/`writeModelDocument`. Scryer agent-run work has already
been routed through Orca's native agent runtime via `ScryerEditSessionController`,
an in-process application service that coordinates Scryer edit-session safety
only. It leaves process launch, terminal/account state, generic run status,
cancellation, crash/done detection, and log streaming in Orca's native agent
runtime. The controller
keeps only lease binding, completion-gated fold coordination,
cancellation/crash cleanup, visible handoff mapping, and post-run
pending/validation checks in the Scryer-specific layer.
Finally, demote `mcp-tools.ts` to a thin compatibility adapter and retire its
semantic implementation; keep compatibility scaffolding only until every
product caller has crossed the engine seam.

Tests for this slice should include adapter ownership checks. They must prove
that UI write intents call `executeOperation(...)` rather than model-store write
helpers, CLI and IPC adapters use catalog operation names and schemas rather
than parallel command contracts, `ArchitectureViewAdapter.readView(...)`
returns a view DTO rather than raw `ScryModel`, `mcp-tools.ts` only normalizes
legacy input before crossing the engine seam, and `ScryerEditSessionController`
uses an Orca runtime adapter/mock rather than starting or supervising processes
itself. Adapter tests should verify conversion, seam calls, and transport
formatting. Source routing, group/link legality, drift, fold, id minting, and
state-store transaction semantics should remain covered by engine module tests
rather than duplicated in adapter tests.

`ScryerEditSessionController` is a deep module: renderer callers should learn
only the edit-session actions and returned status, not the lease-token
lifecycle. The lease token stays inside main-process trusted context and may be
attached only to `ScryerOperationContext` by the controller or trusted adapters.
Renderer/preload DTOs, DOM state, logs, prompts, and generic renderer operation
inputs must not expose, persist, or accept `leaseToken`. `beginAgentEditSession`
and `readEditSession` return token-free session identity/status; agent
completion and optional fold go through `completeAgentEditSession(...)`, which
resolves the matching token internally before calling the Native Scryer Engine.

`ScryerEditSessionController` implementation tickets:

| Ticket | Slice | Scope |
| --- | --- | --- |
| #27A | Controller skeleton + gate evaluator | Add `src/main/scryer/edit-session-controller.ts` and focused tests for `evaluateCompletionGate(...)`: no changes -> `nothing_to_fold`, foldable changes with warnings -> `fold_allowed`, blocking validation -> `fix_validation`, unknown pending kind -> `manual_review`, destructive valid change -> foldable with risk, conflicting lease -> blocked. |
| #27B | Lease store + engine policy tests | Add `src/main/scryer/edit-lease-store.ts`; acquire/release the shared Scryer lease sidecar (`scryerPaths(...).leasePath`, currently `.scryer/.model-edit-lease.json`); wire active lease reads into engine write policy; prove semantic writes require the matching token while reads, validate, pending, prompt prep, and view-only state do not. |
| #27C | Agent runtime minimal integration | Inject a small agent-run interface (`getRunStatus`, `onRunFinished`); acquire lease on begin; release on done/cancel/crash; run completion gate on done; call `scryer.plan.fold` only for `foldPolicy: "when_gate_passes"` when the gate passes. |
| #27D | IPC/UI gate status + live coverage | Add begin/complete/cancel/read edit-session IPC channels with token-free renderer DTOs; render a `CompletionGateResult` DTO; keep UI buttons as intent only; prove renderer operations cannot pass `leaseToken`; prove live agent done -> gate result -> no legacy write bypass. |

The completion gate checks planned state, but it must not require
`pending.total === 0`. Planned changes are expected after an edit session.
Gate pass means pending changes are foldable and validation has no blocking
finding. Warning findings and destructive-but-valid changes may fold, but the
DTO must surface warning/risk details. `pending.total === 0` maps to
`nothing_to_fold`, not failure. Force fold is an explicit human action through
`executeOperation("scryer.plan.fold", ...)`, not an agent-controlled override.

## Out Of Scope Decision

The 33-operation migration must stay focused on the Orca-native Scryer Engine,
catalog, shared engine modules, and adapters. It must not become a migration of
the entire upstream Scryer application. The following are explicitly out of
scope for normal operation migration:

- Scryer MCP server as a product path
- Scryer Tauri shell
- standalone provider/settings UI
- standalone docs/templates marketplace
- implicit pre-0.3 model migration during normal engine reads
- audit, undo, redo, save, or recovery storage
- Rust sidecar runtime
- transport-specific hidden operation semantics

Audit, undo, redo, save, and recovery storage are not planned Scryer features,
not merely deferred implementation details. The engine foundation should not
reserve interfaces, storage files, transaction hooks, or adapter flows for them.
Reconsidering them would require a separate future PRD that changes product
scope.

Scryer MCP server is fully excluded as an Orca product path. Upstream MCP tools
may remain behavior references for operation semantics and tool guidance, but
Orca must not run the upstream Scryer MCP server, expose it as a supported
Scryer integration path, or reserve parallel MCP-specific command contracts
beside the Native Scryer Engine catalog. Agent access to Scryer capabilities
must come through Orca-native adapters over `readView(...)` and
`executeOperation(...)`, not through a second MCP runtime.

The upstream Scryer Tauri shell, provider/settings UI, and docs/templates
marketplace are fully excluded from this migration. They are app surfaces, not
engine operation semantics. Orca may build its own settings, template, or
documentation surfaces later, but #16-#24 must not migrate or embed the
upstream shell, settings UI, marketplace, routing, or release model. This work
set remains limited to the engine catalog, shared engine modules, and Orca
adapters.

Rust sidecar runtime is also fully excluded from the Orca Scryer Engine product
path. Upstream Rust code remains a behavior reference for semantics and parity
fixtures, but Orca must not ship a Scryer Rust sidecar, call Rust as the runtime
implementation, or reserve dual-runtime seams in the operation catalog,
state-store, validators, schemas, error mapper, or adapters. The runtime engine
for this work set is Native TypeScript/Node only.

This work set does not plan compatibility with old Orca or Scryer model files.
Normal `model.read` and `readView(...)` reject incompatible model versions and
unknown fields rather than silently converting files. The failure is a
structured `incompatible_model` domain error with detected/expected version or
unknown-field details. It must not modify the model file, write baseline state,
write planned or committed state, create compatibility sidecars, or recommend a
normal-runtime migration fallback.
migration set.

## Safe Broad Operation Migration Decision

The 33-operation migration must be implemented through deep Native Scryer
Engine modules, not through one-off operation files that each rediscover state,
id, fold, validation, source, error, and adapter rules. Operation files should
stay thin. They receive catalog-validated input, call the appropriate planner,
reporter, router, validator, or shared engine module, and return a standard
operation result. They must not own file IO, lock or lease policy, path
resolution, result envelopes, history or baseline writes, source routing,
transport formatting, id scanning, fold cleanup, or ad hoc validation messages.

The shared module split is the implementation authority:

- `catalog` and `pipeline` own operation registration, policy, zod input
  validation, zod result validation, warning validation, and error-detail
  validation.
- `state-store` owns all durable `.scryer/*` IO, transaction-like primary
  commits, declared sidecar writes, and best-effort maintenance warnings.
- `id-minter` owns upstream id formats and mints against committed state,
  planned state, and current batch reservations.
- `source-router` owns single-home `sourceMap` and `boundaries` routing across
  committed and planned layers.
- `validators` own model invariants, semantic paths, warning-versus-blocking
  classification, and structured validation findings.
- `diff/fold` owns planned-to-committed fold behavior for nodes, links, groups,
  responsibilities, properties, source entries, stale flags, and vagrant
  markers.
- `error-mapper` owns conversion from expected domain failures and unexpected
  exceptions into the public operation envelope.
- adapters own transport conversion only and cross `executeOperation(...)` or
  `readView(...)`.

This keeps the external operation interface small while concentrating complex
implementation behind stable seams. Adding a new operation should normally mean
declaring catalog metadata and schemas, wiring a thin operation executor, and
adding focused module tests. It should not introduce a new private IO path, id
scanner, validation vocabulary, source routing rule, fold rule, or result shape.

Implementation order should follow dependency maturity rather than the raw
upstream tool list. First stabilize the catalog, pipeline, state-store,
schemas, error-mapper, id-minter, validators, source-router, and diff/fold
modules. Then migrate read/query operations to prove the read surface and
adapter view shape. Then migrate structural, source, group, and intent writes
to prove write planning, id minting, source routing, validation, and state-store
transactions. Then migrate drift, health, and atomic container generation,
because they compose several earlier modules. Finally migrate UI, CLI, IPC,
agent-run, and compatibility adapters plus any remaining operation coverage.
This order prevents early operations from hard-coding temporary rules that must
later be extracted into shared modules.

Parity fixtures should compare structured behavior, not implementation shape or
human-facing wording. They should assert operation success/error envelope
fields, committed and planned `.scryer` file results, warning and error detail
codes, semantic paths, structured details, diff/fold output state,
sourceMap/boundary ownership, and illegal-input failure classification. They
should not compare Rust source code, MCP natural-language tool messages,
request ids, timestamps, absolute paths, JSON key order, or non-semantic
wording. The goal is parity with upstream Scryer semantics, not parity with
upstream implementation language or transport text.

Mixed engine/legacy behavior paths are allowed only as short-lived
compatibility during migration. A not-yet-migrated old entrypoint may continue
to use legacy scaffolding until its operation is cataloged. Once an operation
is registered in the Native Scryer Engine catalog, all product callers for that
operation must route through `executeOperation(...)` or `readView(...)`. The
same operation must not keep both an engine semantic implementation and a
legacy semantic implementation. Engine failure for a cataloged operation must
not fall back to the old implementation; it must return the standard
`ScryerOperationResult` error envelope. Readiness checks for this work set must
verify that adapters do not bypass the engine seam, cataloged operations have no
legacy fallback path, and legacy semantic paths are either gone or reduced to
pure shims that normalize into catalog input and format catalog results.

UI refactor readiness needs a more detailed test gate because the UI is where
legacy model semantics are easiest to accidentally preserve. The UI gate should
include these focused tests:

- `ArchitectureViewAdapter.readView(...)` contract tests: it calls the engine
  read surface with a valid selector, maps engine read payloads into a
  UI-specific `ArchitectureViewDto`, preserves stable ids and references,
  exposes renderer-needed data, uses `links` rather than legacy `edges`, and
  does not return raw `ScryModel` or legacy `C4ModelData` as the renderer
  contract.
- View-state separation tests: selected item, expanded ids, workspace view,
  diagram focus, layout positions, viewport, diff glow state, undo/redo stack,
  form drafts, and agent runtime state live in Orca UI/view state or derived
  DTO/cache, not in
  `.scryer/model.scry`. Changing these view-only values must not call
  `executeOperation(...)`, state-store, or model-store writes.
- UI write-intent tests: representative add, update, move, delete, link, source,
  group, intent, drift, and generation actions normalize user intent into
  catalog operation input and call `executeOperation(...)`. They must handle
  success payloads, warnings, `recommendedNextReads`, domain errors, validation
  errors, and unexpected-error envelopes without parsing ad hoc text.
- Legacy bypass tests: migrated UI modules must not import or call legacy
  model-store semantic write helpers, direct filesystem writes, or `mcp-tools`
  semantic helpers. Enforce this with explicit unit tests, dependency tests, or
  lint/no-restricted-import rules where practical.
- Closed-schema tests: normal Scryer runtime rejects unknown fields in
  `model.scry` / `planned.scry`, including legacy `flows`, `scenarios`,
  `edges`, `refPositions`, `startingLevel`, renderer `nodes[*].data`,
  `nodes[*].type`, `links[*].source`, and `links[*].target`. Errors aggregate
  field paths in `incompatible_model.details.fields`.
- Removed-flow tests: Architecture renderer has no `flows` mode, does not import
  `FlowScriptView` for normal Architecture UI, and does not read or write
  `flows` / `scenarios`.
- IPC bridge tests: renderer-to-main Scryer calls use catalog operation names
  and standard engine result envelopes. IPC handlers may translate transport
  details, but they must not define independent Scryer result shapes or own
  validation/failure semantics. Renderer-facing IPC must not expose edit-lease
  tokens or accept `leaseToken` from renderer operation calls; trusted main
  process code resolves any active token before calling the engine.
- Renderer DTO tests: renderer components render from DTO fields, not domain
  model internals; they preserve UI state across compatible refetches, clear
  stale selections when the target id disappears, and display engine warnings
  and domain errors without mutating model state.
- Agent-run UI tests: Scryer agent actions use `ScryerEditSessionController` and
  Orca runtime adapter/mock, reflect model edit lease state, block conflicting
  writes while a lease is active, expose only token-free lease status to
  renderer code, and clean up UI lease state on completion, cancellation, or
  crash.
- Focused end-to-end smoke tests: opening an architecture view reads through
  `readView(...)`, performing a representative UI write crosses
  `executeOperation(...)`, the UI refreshes through `recommendedNextReads`, and
  no legacy semantic write path is invoked.
- Live human-operation tests: use the existing Electron Playwright e2e harness
  (`pnpm run test:e2e`, `tests/playwright.config.ts`) to drive real UI controls
  with pointer and keyboard interactions rather than calling store actions
  directly. These tests should cover a seeded Scryer project opening the
  Architecture/Scryer view, selecting and expanding nodes, switching wiki versus
  diagram views, performing a representative edit through visible controls,
  seeing warnings or domain errors rendered in the UI, refreshing through
  `recommendedNextReads`, and verifying no legacy semantic write path was used.
  They should assert user-visible DOM state and resulting engine-owned model
  effects, not merely Zustand store values. View-only interactions must not
  change `.scryer/model.scry`; semantic edits must cross IPC into
  `executeOperation(...)`; reads must cross `readView(...)`. Use headless
  Playwright by default and reserve headful specs for interactions that depend
  on real focus, drag, or pointer capture.

These UI tests should prove ownership and integration, not duplicate engine
module behavior. Source routing, group/link legality, drift/fold semantics,
id minting, and state-store commits stay covered by engine module tests; UI
tests prove the renderer and transport layers no longer implement those rules.

## Implementation Blueprint For Code Generation

This work set is ready for implementation only when the design decisions above
are translated into small, explicit code-generation inputs. The purpose of this
blueprint is to prevent implementation agents from inferring module interfaces,
catalog rows, error codes, fixture shapes, or adapter ownership from prose.
Implementation issues may refine internal helper names during coding, but they
must preserve the public seams, exported module roles, ownership rules, and
failure modes below.

### Normative Language

Use these words consistently in implementation issues and code review:

| Term | Meaning for implementation |
| --- | --- |
| `must` | Required behavior. Tests must cover it before the slice is complete. |
| `must not` | Prohibited behavior. If the implementation contains it, the slice fails review. |
| `should` | Default requirement. A slice may diverge only when the issue explicitly records the exception and why it is still compatible with catalog policy. |
| `may` | Permitted behavior. It must not change catalog policy, public result shape, state ownership, or adapter responsibility. |
| `future` | Out of scope for the current slice. Do not add placeholder storage, hidden hooks, or unused interfaces for it. |
| `temporary` | Allowed only until the named operation is cataloged. Once cataloged, callers must cross `executeOperation(...)` or `readView(...)`. |

When a sentence conflicts with a catalog row, the catalog row and zod schemas
win. When a catalog row conflicts with a decision in this PRD, update the PRD
and catalog together before implementing.

### Deep Module Interface Drafts

Each deep engine module should expose a small planning or reporting interface.
The caller supplies already-loaded state and validated canonical input. The
module returns structured data, expected failures, warnings, or commit plans. It
does not read or write files, acquire locks, refresh baselines, create public
operation envelopes, or format transport output. The state-store and pipeline
remain the only modules that commit durable writes and wrap public results.

The optional fields on `ScryerLoadedState` do not mean planners may lazily load
missing files. The catalog declares required reads; the pipeline and state-store
must load those reads before calling a planner. If a planner is invoked without
state required by its catalog policy, that is an engine contract violation. It
returns an expected internal failure that the error mapper converts to
`internal_error` with `reason: "policy_violation"` or the closest existing
internal contract reason. The planner must not compensate by reading files
directly.

Stable public module files and exports:

| File | Public exports | Private implementation only |
| --- | --- | --- |
| `src/main/scryer/engine/read-selector.ts` | `ScryerReadSelector`, `createScryerReadSelector`, read selector input/result types | Ranking helpers, compaction helpers, text matching internals |
| `src/main/scryer/engine/structural-planner.ts` | `ScryerStructuralMutationPlanner`, `createScryerStructuralMutationPlanner`, structural input/result types | Tree traversal helpers, cleanup helpers, candidate mutation builders |
| `src/main/scryer/engine/source-router.ts` | `ScryerSourceRouter`, `createScryerSourceRouter`, source routing input/result types | Layer lookup helpers, key normalization helpers |
| `src/main/scryer/engine/group-planner.ts` | `ScryerGroupOwnershipPlanner`, `createScryerGroupOwnershipPlanner`, group input/result types | Cycle detection helpers, member-level classifiers |
| `src/main/scryer/engine/intent-planner.ts` | `ScryerIntentAuthoringPlanner`, `createScryerIntentAuthoringPlanner`, intent input/result types | Responsibility construction helpers, item normalizers |
| `src/main/scryer/engine/id-minter.ts` | `ScryerIDMinter`, `createScryerIDMinter`, id inventory/reservation types | Format counters, collision scanning internals |
| `src/main/scryer/engine/drift-planner.ts` | `ScryerDriftScopeDetector`, `ScryerDriftVerdictRecorder`, `ScryerDriftReconcilePlanner`, factory functions, drift input/result types | Git/file mtime comparison helpers, scope ranking internals |
| `src/main/scryer/engine/health-reporter.ts` | `ScryerHealthReporter`, `createScryerHealthReporter`, health input/result types | Rollup helpers, optional evidence collectors |
| `src/main/scryer/engine/container-generation-planner.ts` | `ScryerContainerGenerationPlanner`, `createScryerContainerGenerationPlanner`, generation input/result types | Proposal normalization helpers, build-edge matching helpers |

These file names are the code-generation target. An implementation slice may
split private helpers into subdirectories, but callers and tests should cross
the public module interfaces above.

Use these drafts as the initial interface target:

```ts
type ScryerLoadedState = {
  project: ScryerProjectContext
  committed?: ScryModel
  planned?: ScryModel
  sync?: ScryerSyncState
  anchorBaseline?: ScryerAnchorBaseline
  buildEdges?: ScryerBuildEdgeGraph
  projectTree?: ScryerProjectTree
}

type ScryerPlannerSuccess<TResult> = {
  result: TResult
  commitPlan?: ScryerStateCommitPlan
  warnings?: ScryerOperationWarning[]
}

type ScryerPlannerResult<TResult> =
  | { ok: true; value: ScryerPlannerSuccess<TResult> }
  | { ok: false; failure: ScryerExpectedFailure }

interface ScryerReadSelector {
  select(input: ScryerReadSelectorInput, state: ScryerLoadedState): ScryerPlannerResult<ScryerReadView>
}

interface ScryerStructuralMutationPlanner {
  plan(input: ScryerStructuralMutationInput, state: ScryerLoadedState): ScryerPlannerResult<ScryerStructuralMutationResult>
}

interface ScryerSourceRouter {
  plan(input: ScryerSourceRoutingInput, state: ScryerLoadedState): ScryerPlannerResult<ScryerSourceRoutingResult>
}

interface ScryerGroupOwnershipPlanner {
  plan(input: ScryerGroupMutationInput, state: ScryerLoadedState): ScryerPlannerResult<ScryerGroupMutationResult>
}

interface ScryerIntentAuthoringPlanner {
  plan(input: ScryerIntentAuthoringInput, state: ScryerLoadedState): ScryerPlannerResult<ScryerIntentAuthoringResult>
}

interface ScryerIDMinter {
  reserve(input: ScryerIDReservationInput, inventory: ScryerIDInventory): ScryerPlannerResult<ScryerIDReservationResult>
}

interface ScryerDriftScopeDetector {
  detect(input: ScryerDriftGetInput, state: ScryerLoadedState): ScryerPlannerResult<ScryerDriftGetResult>
}

interface ScryerDriftVerdictRecorder {
  plan(input: ScryerDriftFlagInput, state: ScryerLoadedState): ScryerPlannerResult<ScryerDriftFlagResult>
}

interface ScryerDriftReconcilePlanner {
  plan(input: ScryerDriftReconcileInput, state: ScryerLoadedState): ScryerPlannerResult<ScryerDriftReconcileResult>
}

interface ScryerHealthReporter {
  report(input: ScryerHealthInput, state: ScryerLoadedState): ScryerPlannerResult<ScryerHealthReport>
}

interface ScryerContainerGenerationPlanner {
  plan(input: ScryerContainerFillInput, state: ScryerLoadedState): ScryerPlannerResult<ScryerContainerFillResult>
}
```

The interface rule is more important than the exact type names. If an
implementation wants to add another public method, it must first prove that the
behavior cannot fit behind the existing `select`, `plan`, `reserve`, `detect`,
or `report` shape. Keep internal helper seams private to the module unless two
real adapters or callers need to vary them. The pipeline maps planner warnings
into `ScryerOperationResult.meta.warnings`; operation payload schemas must not
duplicate those warning objects.

### Catalog Matrix Requirements

The runtime catalog remains the executable contract matrix. The detailed
operation and schema matrix already lives in
`docs/prd/orca-scryer-engine-catalog-foundation.md`; implementation slices must
update that matrix and `src/main/scryer/engine/catalog.ts` together. Do not
create a second competing operation list in operation files, CLI specs, IPC
handlers, or UI metadata.

Every catalog row must have these fields before an operation is considered
implementation-ready:

| Field | Meaning |
| --- | --- |
| `operationId` | Canonical Orca operation name such as `scryer.group.update`. |
| `inputSchema` | Zod schema for canonical engine input after adapter normalization. |
| `successSchema` | Zod schema for `ok:true` result payload. |
| `warningSchema` | Zod schema for warning objects returned with success. |
| `errorDetailSchemas` | Stable detail schema for every declared domain error code. |
| `capability` | Read, plan authoring, fold, generation, correction, drift, or health capability. |
| `risk` | `normal`, `high`, or `destructive`; generation primitives must be marked high-risk. |
| `reads` | Declared state reads such as committed, planned, sync, anchors, project tree, rules, or build edges. |
| `semanticWrites` | Declared committed/planned writes, or empty for pure reads. |
| `maintenanceWrites` | Declared baseline, history, sync, or anchor-baseline side effects. |
| `lock` and `lease` | Runtime concurrency policy selected before execution. |
| `planner` | Shared module used by the thin operation executor. |
| `warningsAllowed` | Whether warning findings may return with success. |
| `upstreamAnchors` | Upstream files/functions used as behavior reference. |
| `transportMetadata` | CLI/IPC/UI/agent exposure metadata only; not authorization policy. |

An operation slice is not complete if its catalog row is registered but its
schema row, expected error details, warning schema, planner owner, write policy,
or upstream anchors are still implicit.

### Minimum Operation Test Checklist

Every migrated operation must have a small, operation-specific checklist before
coding starts. The checklist should be placed in the implementation issue and
mirrored by focused tests. At minimum, each operation needs:

- schema rejection for malformed input and unsupported legacy aliases
- one success case that asserts the structured success payload
- one expected domain failure that asserts stable `code`, `path`, and `details`
- write-policy proof: committed, planned, sidecar, or no-write behavior matches
  the catalog row
- warning behavior where warnings are allowed, including proof that warnings do
  not block writes
- no-partial-write behavior for hard failures and atomic batches
- result-schema validation failure mapped to `internal_error`
- no legacy fallback for cataloged operations
- one parity or golden-state case when the behavior is cross-cutting

Family-specific minimums:

| Family | Additional required checks |
| --- | --- |
| Read/query | Default overview, subtree drill-down, explicit full, not-found, truncation/hidden-count hints, and adapter use of Read Selector output. |
| Structural writes | Identity preservation, parent/hierarchy validation, cleanup of links/groups/source entries, warning-versus-hard-error split, and atomic batch rollback. |
| Source/group | Single-home source routing, committed versus planned target ownership, group sibling-level membership, child group detach on delete, and no renderer-owned group semantics. |
| Intent writers | Shared id minting, operation-fixed kind, parent-kind validation, source/boundary side effects through Source Router, structured `added` summary, and no caller-supplied ids for ordinary adds. |
| Drift/health | No semantic verdict from drift get, first-run baseline bootstrap, planned-only verdict recording, reconcile baseline advancement, and declared-only health maintenance writes. |
| Container fill | Empty-container precondition, committed/planned atomic write, generated ids from shared minter, generated source anchors, derived-link handling, dropped optional links, and no drift baseline refresh. |
| Adapters | Input normalization only, standard envelope handling, no model semantics, no direct state-store/model-store write for migrated operations, and no legacy fallback path. |

For example, `scryer.group.update` should prove successful patching of
`name`, `description`, `member_ids`, and responsibilities; rejection of
`parentGroupId` or other re-parenting attempts; rejection of mixed-level
members; warning success for non-blocking quality findings; planned-state-only
write behavior; and no partial planned write after a hard error.

### Canonical Error Code Registry

The public `ScryerOperationError.code` registry stays small and stable. Detailed
operation reasons belong in zod-validated `error.details.reason`, in
`error.fieldErrors[*].code`, or in `validation_failed.findings[*].code`. Do not
promote every domain reason into a new public `error.code`.

Canonical public error codes:

| Public code | Use |
| --- | --- |
| `invalid_input` | Input failed zod validation or alias normalization. |
| `invalid_context` | Operation context is malformed, missing trusted caller state, or outside the workspace. |
| `incompatible_model` | Model data cannot be treated as Scryer 0.3 state. |
| `io_error` | Required file or project IO failed. |
| `lock_busy` | Required state lock cannot be acquired. |
| `lease_required` | A write is blocked because an active edit lease exists and trusted operation context lacks the matching internal lease token. |
| `operation_not_found` | Operation id is not registered in the runtime catalog. |
| `internal_error` | Engine contract violation or unexpected exception. |
| `not_found` | Requested project, node, link, group, responsibility, property, source entry, boundary, rule topic, or agent run does not exist. |
| `illegal_link` | Link endpoint relationship is invalid. |
| `validation_failed` | Shared validators found blocking model or operation invariants. |
| `agent_run_required` | Operation mode requires trusted active agent-run context. |

Ambiguous names are not allowed:

| Do not use | Use instead |
| --- | --- |
| `incompatible_model_version` | `incompatible_model` with `details.expectedVersion` and `details.actualVersion`. |
| `lock_conflict` | `lock_busy`. |
| `lease_conflict` | `lease_required` with `details.reason`. |
| `operation_not_cataloged` | `operation_not_found`. |
| `legacy_fallback_forbidden` | No runtime fallback path should exist; tests should fail the adapter. If detected by a guard, return `internal_error` with `reason: "policy_violation"`. |

Domain reason codes must still be stable and schema-validated. Use them inside
`details.reason`, `fieldErrors[*].code`, or validation finding `code`:

| Reason family | Stable reason codes |
| --- | --- |
| Structure | `duplicate_id`, `missing_parent`, `invalid_hierarchy`, `invalid_layer`, `cycle_detected`, `cannot_move_root`, `cannot_reparent_to_descendant`, `replacement_scope_invalid`, `delete_target_not_found`. |
| Link | `link_not_found`, `link_endpoint_not_found`, `link_endpoint_immutable`, `duplicate_link`, `self_link`, `ancestor_descendant`, `same_level_reference`. |
| Source | `source_target_not_found`, `source_target_ambiguous`, `source_conflict`, `boundary_target_not_found`, `whole_symbol_range_normalized`. |
| Group | `group_not_found`, `group_member_not_found`, `group_member_level_mismatch`, `group_parent_not_found`, `group_cycle_detected`, `group_reparent_forbidden`. |
| Intent | `caller_supplied_id_forbidden`, `caller_supplied_kind_forbidden`, `invalid_parent_kind`, `blank_name`, `blank_property_label`, `symbol_identity_required`. |
| Drift and generation | `drift_scope_not_found`, `reconcile_baseline_write_failed`, `empty_generation_target_required`, `generation_proposal_invalid`, `required_link_invalid`, `vagrant_responsibility_move_forbidden`. |

Warnings are always returned as `ScryerOperationResult.meta.warnings`; operation
payloads must not carry a second `warnings` array. If a payload needs to show
evidence, it may include structured reports such as `droppedLinks`,
`edgeGraphStatus`, `normalizedWholeSymbolRanges`, or warning counts. Warning
codes must be added to the shared `ScryerOperationWarningCode` union and warning
zod schema before use:

| Warning code | Use |
| --- | --- |
| `maintenance_write_failed` | Best-effort maintenance side effect failed after the primary result. |
| `missing_description` | Element lacks a useful description. |
| `missing_responsibility` | Element lacks modeled responsibility text where that is a quality issue. |
| `missing_source_anchor` | Element has no source anchor yet. |
| `unverified_source_pattern` | Source pattern was accepted but not proven against the filesystem. |
| `broad_boundary_glob` | Boundary glob is broad enough to need later refinement. |
| `whole_symbol_range_normalized` | Whole-symbol line range was normalized to a symbol-level anchor. |
| `empty_symbol` | Symbol is structurally valid but thin or empty. |
| `missing_technology` | Node lacks technology metadata where expected. |
| `unknown_icon` | Group icon or presentation hint is unknown and ignored. |
| `optional_link_dropped` | Optional generated link was invalid and skipped. |
| `edge_graph_missing` | Build-edge evidence was unavailable. |
| `edge_graph_ambiguous` | Build-edge evidence was present but ambiguous. |

If an implementation discovers a new failure or warning class, update this
registry, `types.ts`, zod schemas, and focused tests before using it in an
operation.

### Success Payload Field Contracts

Every `ok:true` operation returns its operation-specific payload in
`ScryerOperationResult.result`. Cross-operation warnings live only in
`ScryerOperationResult.meta.warnings`. Payloads may include counts, ids,
reports, summaries, and `recommendedNextReads`; they must not require callers to
parse prose.

Shared read hint shape:

```ts
type ScryerRecommendedNextRead = {
  operationId: 'scryer.model.read' | 'scryer.model.search' | 'scryer.model.query'
  input: Record<string, unknown>
  reason: string
}
```

Required payload shapes for broad migration:

| Result type | Required fields | Optional fields | Notes |
| --- | --- | --- | --- |
| `ScryerReadView` | `view`, `layer`, payload-specific fields | `recommendedNextReads` for overview/subtree navigation payloads | Explicit full reads return `{ view: "full"; layer; version; nodeCount; linkCount; groupCount; model }` and do not need `recommendedNextReads`. |
| `ScryerSearchResult` | `query`, `hits`, `results`, `truncated` | - | Results include id, kind, path, score, and upstream-style `matched`; candidate ids are the next read targets. |
| `ScryerQueryResult` | `hits`, `results`, `truncated` | - | Results include id, kind, name, path, `nResp`, `nProps`, and optional empty-symbol flag; candidate ids are the next read targets. |
| `ScryerAddedItemsResult` | `added`, `counts`, `recommendedNextReads` | `sourceKeys`, `boundaryKeys` | `added` entries include minted ids, kind, name, parent ids, responsibility ids, property labels, and group ids where relevant. |
| `ScryerStructuralMutationResult` | `changed`, `counts`, `recommendedNextReads` | `removed`, `moved`, `detachedGroups`, `normalized` | Use for model/subtree set, move, delete, descope, responsibility move, and link update summaries. |
| `ScryerSourceRoutingResult` | `updatedCount`, `routes`, `normalizedWholeSymbolRanges` | `clearedKeys`, `recommendedNextReads` | `routes` records committed versus planned ownership; warning objects remain in `meta.warnings`. |
| `ScryerGroupMutationResult` | `changedGroups`, `counts`, `recommendedNextReads` | `detachedChildGroups` | Group delete reports deleted group id and detached child group ids. |
| `ScryerDriftGetResult` | `clean`, `scopes`, `baseline`, `recommendedNextReads` | `bootstrapped`, `changedFilesSummary` | It reports scope evidence only; it is not a semantic verdict. |
| `ScryerDriftFlagResult` | `recorded`, `counts`, `recommendedNextReads` | `historyEventIds` | Writes planned semantic verdicts; history remains sidecar evidence. |
| `ScryerDriftReconcileResult` | `baseline`, `reconciledAt`, `scopeCount` | `anchorFingerprintCount` | Does not claim semantic correctness. |
| `ScryerHealthReport` | `scope`, `totals`, `coverage`, `anchors`, `stale`, `vagrant`, `recommendedNextReads` | `roots`, `children`, `linkAudit`, `edgeGraph`, `reanchoredCounts`, `boundaryDarkFiles` | Conditional evidence fields appear only when supporting evidence exists. |
| `ScryerContainerFillResult` | `commit`, `summary`, `created`, `reports`, `recommendedNextReads` | - | `reports` includes `droppedLinks`, `edgeGraphStatus`, and evidence summaries, not warning objects. |

Each schema must define required and optional fields explicitly. If a field is
not meaningful for an operation, omit it instead of returning `null` unless the
schema says `null` has semantic meaning.

### Upstream Parity Fixture Format

Use the parity fixture layout from the foundation PRD as the target structure.
The current `src/main/scryer/engine/parity-fixtures.ts` loader reads a single
flat `case.json` file for first-slice bootstrap tests. Before adding broad
operation fixtures, upgrade that loader so `loadParityFixture(path)` accepts the
canonical case directory path and returns resolved paths for `project/` and
`expected/`. It may keep flat-file support only for existing bootstrap tests;
new parity fixtures must use the directory format below.

```text
src/main/scryer/engine/__fixtures__/upstream-parity/
  <operation-id>/
    <case-name>/
      case.json
      project/
        .scryer/model.scry
        .scryer/planned.scry
        .scryer/model.baseline.scry
        .scryer/.sync.json
        .scryer/.anchors.json
        .scryer/.build_edges.json
      expected/
        result.json
        model.scry
        planned.scry
        warnings.json
        sidecars.json
```

`case.json` should have a small, zod-validated shape:

```json
{
  "operationId": "scryer.group.update",
  "upstreamCommit": "abcdef1",
  "upstreamAnchors": ["crates/scryer-mcp/src/tools/misc.rs::update_group"],
  "input": {},
  "context": {},
  "expected": "success",
  "orcaDifferenceReason": "Orca returns structured envelopes instead of MCP text output."
}
```

Compare normalized operation results, stable error and warning codes,
semantic paths, selected result details, and the declared `.scryer` file
outputs. Ignore or scrub request ids, timestamps, absolute paths, temp
directories, JSON key order, and non-semantic wording. Preserve Scryer ids,
element order where semantic, sourceMap keys, boundaries, stale flags, vagrant
markers, and generated link ids. Fixture tests must read cases through the
parity fixture loader, not through ad hoc file reads. The loader contract for
new fixtures returns the parsed case metadata plus resolved paths for
`project/`, `expected/result.json`, and any declared expected state files. A
test that directly opens `project/.scryer/model.scry` without going through the
loader is testing past the fixture seam and should fail review.

### Adapter Migration Mapping

Adapters should be migrated with an explicit file mapping so semantic ownership
does not drift back into UI, IPC, CLI, or compatibility shims.

| Area | Current files | Target role |
| --- | --- | --- |
| Engine seam | `src/main/scryer/engine/index.ts`, `catalog.ts`, `pipeline.ts`, `state-store.ts` | Own `executeOperation(...)`, `readView(...)`, catalog policy, result envelopes, state commits, and contract validation. |
| IPC | `src/main/ipc/architecture.ts` | Keep existing channels where product compatibility requires them, but route migrated reads/writes through `readView(...)` or `executeOperation(...)`. Do not import legacy semantic helpers for cataloged operations. |
| CLI | `src/cli/handlers/scryer.ts`, `src/cli/specs/scryer.ts` | Normalize flags/payloads into catalog input and format `ScryerOperationResult`; do not define separate command semantics. |
| Legacy storage | `src/main/scryer/model-store.ts`, `src/main/scryer/model-store-core.ts` | Not part of normal Scryer 0.3 Architecture runtime after #28. No new semantic behavior after an operation is cataloged; normal Architecture renderer must not call these paths. |
| Legacy MCP shim | `src/main/scryer/mcp-tools.ts` | Thin compatibility adapter or removable shim. It may normalize old entrypoints into engine operations; it must not remain a parallel Scryer MCP product path. |
| Legacy drift/sync helpers | `src/main/scryer/drift.ts`, `src/main/scryer/sync.ts` | Move drift detection, reconcile, and health semantics into engine drift/health modules; retain only adapter glue where needed. |
| Shared legacy types | `src/shared/scryer/model-types.ts` | Not part of the Architecture renderer after #28 hard cutover. Keep only if unrelated legacy tools still require it; normal Scryer runtime must not depend on it. |
| Renderer Architecture UI | `src/renderer/src/components/architecture/**` | Render `ArchitectureViewDto` and express user intent. Do not import `C4ModelData`, `C4Node`, `C4Edge`, `C4NodeData`, mutate `ScryModel`, sourceMap, groups, links, fold state, or drift state directly. |
| Renderer state | `src/renderer/src/store/slices/architecture.ts` and workspace session files | Own selected ids, expanded ids, layout/view state, tabs, and session UI data only. Semantic writes cross IPC into the engine. |

Operation-level IPC target mapping:

| Current IPC channel | Target status | Engine target |
| --- | --- | --- |
| `architecture:readArchitectureView` | Add as the primary Architecture renderer read seam. | Calls `ArchitectureViewAdapter.readView(...)`, which calls engine `readView(...)` and returns `ArchitectureViewDto`. |
| `architecture:executeArchitectureIntent` | Add as the primary Architecture renderer write-intent seam where useful. | Normalizes UI intent into catalog operation input and calls `executeOperation(...)`; may return operation result plus recommended `readArchitectureView` request. |
| `architecture:executeScryerOperation` | Keep as the primary migrated IPC seam. | Passes canonical operation id/input to `executeOperation(...)` and returns `ScryerOperationResult`; renderer input must not include `leaseToken`. |
| `architecture:readModel` | Remove from normal Architecture renderer path. | Legacy/non-Architecture callers only if still needed; normal Architecture reads use `readArchitectureView`. |
| `architecture:readModelDocument` | Remove from normal Architecture renderer path. | Legacy/non-Architecture callers only if still needed; normal Architecture reads must not expose `ScryModel` or `C4ModelData`. |
| `architecture:writeModel` | Remove from normal Architecture renderer path. | Raw model replacement is not a normal edit path. |
| `architecture:writeModelDocument` | Remove from normal Architecture renderer path. | Raw document replacement is not a normal edit path; Architecture UI writes use intent/operation calls. |
| `architecture:patchNodeData` | Migrate to semantic node patching. | `scryer.node.update`. |
| `architecture:checkDrift` | Migrate. | `scryer.drift.get`. |
| `architecture:markSynced` | Migrate. | `scryer.drift.reconcile`. |
| `architecture:beginSync` | Migrate when `ScryerEditSessionController` lands. | Controller begin path plus lease setup; renderer receives token-free session identity/status only. |
| `architecture:cancelSync` | Migrate when `ScryerEditSessionController` lands. | Controller cancellation path plus lease cleanup; renderer does not supply lease token. |
| `architecture:finishSync` | Migrate when `ScryerEditSessionController` lands. | Controller completion gate plus `scryer.plan.fold` only where selected and allowed; controller supplies any matching lease token internally. |
| `architecture:callTool` | Temporary compatibility shim only. | Normalize old tool names into catalog operations such as read/query, node/link/group/source/intent, drift/health, and generation; remove semantic fallback as operations migrate. |
| `architecture:prepareInitialModelPrompt` | Keep as prompt adapter until replaced by generation flow. | May use `readView(...)` for context; must not write model files. |
| `architecture:prepareNodeFillPrompt` | Keep as prompt adapter until `container.fill` UI is migrated. | `readView({ mode: "subtree", node })` for context; eventual write path is `scryer.container.fill`. |
| `architecture:prepareAdvisorPrompt` | Keep as prompt adapter. | `readView(...)` with overview/subtree/full only when needed; no semantic writes. |
| `architecture:watchModel` | Keep as notification plumbing. | Watch engine-owned `.scryer` files and emit UI refresh events; no model semantics. |
| `architecture:listModels`, `architecture:createModel`, `architecture:saveModelAs`, `architecture:deleteModel`, `architecture:listTemplates`, `architecture:migrateGlobalModel`, `architecture:writeMcpConfig`, `architecture:isSyncing`, `architecture:hasPreSyncSnapshot` | File/workspace/prompt compatibility until a separate model-management design replaces them. | Not ordinary Scryer semantic operations in #16-#24; must not bypass engine semantics for cataloged operations. |

Each adapter migration issue should include import tests or no-restricted-import
rules for the files it touches. For cataloged operations, a test must fail if
the migrated adapter calls the old semantic implementation after an engine
failure.

### UI Live Test Scenarios

The UI refactor needs live human-operation tests in addition to unit tests. Use
the existing Electron Playwright harness and write specs that interact through
visible controls. The first live tests should cover these scenarios:

1. Open a seeded project and create or open an Architecture/Scryer tab. Assert
   the visible overview is loaded through `readView(...)`, not direct
   model-store reads.
2. Select and expand a node from the visible tree or canvas. Assert subtree
   data appears, selection/expanded state persists across compatible refreshes,
   and `.scryer/model.scry` is unchanged by view-only interaction.
3. Perform one representative semantic edit through visible controls, such as
   adding a component, adding a link, or updating source anchors. Assert IPC
   calls `executeOperation(...)`, the UI renders warnings or success state, and
   refresh follows `recommendedNextReads`.
4. Trigger one expected domain error from the UI, such as illegal link endpoint
   or invalid group membership. Assert the standard error envelope is rendered
   without changing model files.
5. Exercise a Scryer agent-run or lease state if the touched slice includes
   agent UI. Assert conflicting writes are blocked while a lease is active and
   UI lease state clears on completion, cancellation, or crash.
6. Run a legacy bypass assertion for the same flow: the test should fail if the
   migrated UI path invokes `model-store`, `mcp-tools`, or direct filesystem
   writes for a cataloged operation.

These live tests must assert user-visible DOM state and engine-owned model
effects. Store-only assertions are allowed as supporting checks, not as the
primary proof.

Live test fixture design:

| Fixture concern | Required design |
| --- | --- |
| Seeded project location | Add a small seeded Scryer project under `tests/e2e/fixtures/scryer-project/` or create it through a helper in `tests/e2e/helpers/scryer-project.ts`. It must include reviewable `.scryer/model.scry`, `.scryer/planned.scry`, and only the sidecars needed by the scenario. |
| Project isolation | Each test copies the seeded project into the per-test repo/user-data location before launch. Tests must not mutate the shared fixture directory. |
| Engine seam spy | Add a test-only main-process hook or IPC spy that records calls to `readView(...)` and `executeOperation(...)` by operation id, request id, and normalized input. The spy must observe the real app path; it must not replace the engine implementation for live tests unless the test is explicitly an adapter unit test. |
| Legacy bypass proof | Add spies or restricted-import assertions for `model-store`, `mcp-tools`, and direct `.scryer/*` filesystem writes on migrated workflows. A cataloged operation test fails if the legacy path is invoked after, before, or instead of the engine seam. |
| DOM proof | Assertions target visible labels, tree rows, selected state, warning/error surfaces, and refreshed model content. Store snapshots are supporting evidence only. |
| Model-file proof | After semantic edits, read `.scryer` files from the isolated test project and assert engine-owned state effects. After view-only interactions, assert `.scryer/model.scry` is byte-for-byte unchanged. |
| Headless default | Run overview, subtree, simple edit, error rendering, and no-legacy-bypass specs headless by default in `pnpm run test:e2e`. |
| Headful-only cases | Reserve headful specs for behavior that depends on real focus, drag, pointer capture, native menus, or OS-level window behavior. Headful specs must be tagged or named so they can be run separately. |

### Implementation Issue Slice Template

Do not hand a future agent only this PRD and ask for a broad implementation.
Create implementation-ready issues from the following template:

```md
## Target

- Operation family:
- Operations:
- Primary deep module:
- Dependent modules:

## Files To Inspect First

- docs/orca-scryer-decision-map.md
- docs/prd/orca-scryer-operation-migration-work-set.md
- docs/prd/orca-scryer-engine-catalog-foundation.md
- src/main/scryer/engine/**
- upstream Scryer files named in the catalog row

## Implementation Scope

- Add or update catalog rows:
- Add or update zod schemas:
- Add or update public module file/export:
- Add or update canonical error/detail/warning codes:
- Add or update success payload fields:
- Add or update planner/router/reporter module:
- Add thin operation executors:
- Add parity or golden fixtures:
- Update adapters and IPC channel mappings:

## Acceptance Criteria

- Catalog row complete.
- Schemas validate input, success result, warnings, and error details.
- Public module interface lives in the file named by the blueprint and does not
  expose private helper seams.
- Operation success payload follows the required field contract and puts
  warning objects only in `meta.warnings`.
- Operation executor has no private IO, id scanning, source routing, fold rule,
  result envelope, or transport formatting.
- Shared module tests cover success, expected failure, warnings, atomicity, and
  no partial writes.
- Adapter tests prove calls cross `executeOperation(...)` or `readView(...)`.
- Cataloged operation has no legacy fallback path.

## Verification

- corepack pnpm exec vitest run --config config/vitest.config.ts src/main/scryer/engine/*.test.ts src/main/scryer/engine/**/*.test.ts
- corepack pnpm exec vitest run --config config/vitest.config.ts src/main/scryer/model-store.test.ts src/main/scryer/mcp-tools.test.ts src/main/ipc/architecture.test.ts
- corepack pnpm run tc:node
- git diff --check

## Forbidden

- Do not copy upstream Rust implementation source into Orca runtime.
- Do not add operation-local file IO or state semantics.
- Do not add a second catalog or transport-specific operation contract.
- Do not preserve legacy fallback for a cataloged operation.
- Do not broaden scope into audit, undo, redo, save, recovery storage, MCP
  server, Tauri shell, provider UI, or template marketplace.
```

Suggested issue slices:

| Slice | Target | Depends on |
| --- | --- | --- |
| Read surface implementation | `ScryerReadSelector`, read/query/rules/codebase operations, `model.read` result upgrade | Foundation catalog and state-store |
| Structural planner implementation | `model.set`, `node.set-subtree`, `node.delete`, `node.move`, `node.descope`, `responsibility.move`, `link.update` | Read surface and validators |
| Source/group ownership implementation | `ScryerSourceRouter`, `ScryerGroupOwnershipPlanner`, source/group operations | Structural planner and source routing tests |
| Intent authoring implementation | `ScryerIntentAuthoringPlanner`, typed add operations, id-minter hardening | Source/group ownership and id inventory |
| Drift/health implementation | drift detector, verdict recorder, reconcile planner, health reporter | Source routing, validators, state-store maintenance writes |
| Container fill implementation | `ScryerContainerGenerationPlanner`, build-edge link derivation, generated summaries | Intent, group, source, id-minter, validators |
| Adapter retirement implementation | UI, IPC, CLI, agent bridge, legacy shim retirement | Operation families migrated |
| Readiness gate implementation | ownership tests, parity fixture coverage, live UI smoke tests, no-fallback checks | All prior slices |
