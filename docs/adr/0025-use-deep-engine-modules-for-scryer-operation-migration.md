# Use deep engine modules for Scryer operation migration

The Native Scryer Engine migrates all 33 upstream Scryer operations through a small set of deep modules instead of distributing state, fold, id, error, and adapter behavior across operation files. `catalog`, `pipeline`, `state-store`, `diff/fold`, `id-minter`, validators, error mapping, and adapters each own one class of cross-cutting behavior so operation implementations can focus on Scryer domain changes while preserving upstream parity.

This keeps planned/committed state semantics, multi-file write policy, best-effort maintenance warnings, fold behavior, id collision avoidance, structured errors, and adapter migration testable at stable engine seams.

The operation catalog is implemented from a complete 33-operation contract
matrix: each operation declares capability, risk, lock, lease, transports,
reads, semantic writes, maintenance writes, side effects, schema names,
operation-specific errors, and upstream behavior anchors.

The implementation borrows upstream behavior seams, not upstream source shape.
Upstream anchors include `ModelRef` path ownership, full-cycle model locking,
planned fallback, `commit_element` fold semantics, `diff.rs` element identity,
`validate.rs` link legality, `update_source_map` single-home source mapping,
boundary ownership, drift scoping, health rollups, build-edge evidence, id
minting, and best-effort history/baseline writes. Orca centralizes these seams
behind catalog, pipeline, state-store, validators, diff/fold, id-minter, and
adapters because upstream MCP handlers call them directly and Orca has multiple
product entry points.

Operation schemas are implemented from a field-level schema matrix, not inferred
inside operation files. The matrix preserves upstream request field names,
declares Orca structured success payloads, and centralizes shared nested input
types for zod validation.

Engine inputs have one canonical field name per field. Catalog input schemas may
accept upstream serde aliases for compatibility, but the pipeline normalizes
them before execution, rejects conflicting alias/canonical values, and never
passes alias spellings into operation executors.

The engine also enforces a canonical model boundary. Internal modules operate on
`ScryModel` 0.3 and canonical operation inputs only. Legacy `C4ModelData`,
renderer data, CLI flag objects, and alias-shaped request objects must be
explicitly converted at adapter or catalog input boundaries. Reused field names
such as `nodes`, `groups`, `sourceMap`, `parentId`, and `memberIds` are not
renamed globally; their safety comes from type/module boundaries and explicit
mapping at the engine seam.

The Engine Foundation Interface Contract fixes dependency direction. Product
callers enter through `engine/index.ts`; the pipeline executes catalog
contracts; state-store owns `.scryer/*` IO and locks; operation files receive
loaded state plus narrow services and never import state-store, adapters,
renderer code, or legacy C4 model shapes. Readiness tests map each foundation
rule to named test suites before broad operation migration.

Operation executors have one return shape: `ScryerExecutorResult<TResult>`.
They return either a successful `ScryerOperationOutcome<TResult>` or a
structured expected failure. They do not construct commit plans, envelopes,
request ids, timestamps, or file writes. The pipeline is the only module that
maps executor failures through `error-mapper`, converts successful
`ScryerStateChanges` into a `ScryerStateCommitPlan`, validates that plan against
the resolved catalog policy, and passes it to state-store. Unexpected thrown
exceptions map to `internal_error`; expected domain failures such as
`not_found`, `illegal_link`, and `validation_failed` are not modeled as
exceptions.

Mixed-mode operations use catalog policy branches. For example,
`scryer.plan.fold` has explicit `manual` and `agent_completion` branches; the
pipeline chooses one flat policy from validated input before authorization,
lease, read/write, validation, and side-effect checks. Operation files may use
the mode as domain input, but they do not decide whether agent-run context or a
completion-gate lease is required.

Complex success payloads use shared result types. Read views, validation
results, pending/fold results, intent added-item results, health reports, drift
scope results, and generation results get one zod schema each and are composed
by operation success schemas instead of being redefined per operation.

Simple success payloads also use shared field names. Counts are named
`updatedCount`, `deletedCount`, `writtenCount`, `movedCount`, or
`removedCount`; generated id arrays use `addedIds`; intent add results use
`addedItems`; tolerated missing requested ids use `missingIds`. Operation-local
fields such as `{ updated }`, `{ deleted }`, `{ written }`, or `{ added }` are
not accepted in the engine contract.

`source-router` is the single-home routing module for `sourceMap` and
`boundaries`. It returns routing decisions and complete committed/planned
snapshots; it does not perform durable writes.

Structured errors use one shared taxonomy. Operation contracts reference error
codes from that taxonomy, and the pipeline validates each error detail object
against the shared zod schema before returning it to callers.

`ScryerOperationResult<TResult>` is the only public operation envelope.
`error-mapper` owns conversion from executor failures, pipeline failures,
state-store failures, and unexpected exceptions into that envelope. This mirrors
upstream's distinction between MCP tool error results and outer transport
errors, while replacing upstream text messages with structured Orca errors.

Transport metadata is adapter mapping only. Authorization still comes from the
resolved catalog policy's transport allow-list. Missing metadata means an
adapter is not exposed in the current batch; it does not grant or revoke
authority.

Validators are a shared engine boundary, not operation-local checks. They emit
structured `ScryerValidationFinding` values, preserve upstream's distinction
between committed-model warnings and write-blocking guards, and let operation
policy decide whether a finding remains informational or becomes
`validation_failed`.

`state-store` is the durable persistence boundary. Operation executors return
state changes only; the pipeline validates those changes against the catalog,
then `state-store` commits primary writes transactionally and converts
best-effort maintenance failures into structured warnings.

The engine takes deterministic runtime services. Production uses real time and
request-id generation; tests inject fixed `clock` and request-id factories so
history, baseline metadata, health timestamps, drift reconciliation, request
ids, and parity fixtures are reproducible.

`diff/fold` is the element-level committed-change boundary. It owns fold behavior
for nodes, links, groups, properties, responsibilities, sourceMap/boundary
ownership cleanup, and stale/vagrant marker resolution so those rules are tested
once and reused by every operation that closes planned work.

`id-minter` is the only module that creates new Scryer ids. It scans committed
state, planned state, and current batch reservations; preserves upstream
`node-N`, `resp-N`, `group-N`, and endpoint-deterministic link id formats; and
keeps raw set operations in validation-only mode instead of rewriting supplied
ids.

Upstream parity is proved through fixture and golden-state tests. Those tests
compare structured operation results and durable Scryer state, reference the
upstream behavior anchors they cover, and deliberately avoid source-code
similarity or Rust/MCP text-message comparisons.

Parity fixtures load through a zod-validated fixture loader rather than ad hoc
file reads. Architecture ownership is checked by a Vitest static import scanner
using the TypeScript compiler API so forbidden dependency direction fails before
operation behavior tests can hide the seam violation.

The 33-operation implementation is gated by foundation readiness. The catalog,
pipeline contract checks, state-store transaction behavior, validators,
id-minter, diff/fold, and parity fixture harness must be green before broad
operation-family migration begins; later missing cross-cutting rules go back
into those modules instead of being patched into individual operation files.
