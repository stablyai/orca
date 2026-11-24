# Configurable task pipelines

Pipelines are an opt-in native workspace capability. Ordinary workspace creation does
not open a pipeline database. Initial pipeline admission supports local Git worktrees
only; remote, SSH, WSL and folder workspaces retain their ordinary creation paths.
The native engine, editor, run history and versioned CLI/RPC share one definition and
the same executor and source checks. The optional `task-pipelines` plugin contributes
legacy profiles and a panel; it is not the v2 engine or editor. A private assistant
catalog adapter is an external consumer, never a runtime dependency.

Pipeline SQLite transactions and file preparation run in a dedicated worker through
the existing worker request queue. A lost worker reply leaves the write's outcome
unknown; callers inspect or replay its exact receipt instead of repeating work.
Invocation binding is persisted before task handover. Unmanaged driving input into
a session with pending owner evidence records an invalidation intent before bytes
are sent. If delivery then fails, the conservative session-sync hold remains until
the owner reconciles it; the intent does not claim successful delivery.

## Definitions and completion

Published definitions are immutable. Edit a draft or copy a published definition,
validate it, and publish a new version. Presets (`single`, `implement-checks`,
`configurable-review`, `coding`, `research`) are editable starting points. No fixed
role list, review stage, reviewer model, or stage sequence is mandatory.

`evidenceSchema: review` specifies a result shape. It does not require independence.
Each agent stage separately selects `executor.session: {kind: fresh}` or
`{kind: reuse, groupId: ...}`. `independent: true` keeps that stage's session apart
from implementation context; independent stages may share a separate review group.
Model, surface, effort and permission compatibility are checked before reuse.
Sharing implementation context is self-review and is never labeled independent.

`workflow_complete` confirms the selected route finished, without certifying source
readiness. `reviewed_source` also requires current trusted checks, a clean commit,
the selected review outcomes and no remaining critical/important review findings.
Each `reviewRequirements` entry can select independence and freshness explicitly:

```json
{
  "stageId": "review",
  "acceptedOutcomeIds": ["approved"],
  "independent": false,
  "freshSession": false
}
```

This permits source readiness after shared-session self-review under those selected
requirements. A requirement with `independent: true` demands a separate session;
`freshSession: true` demands a fresh session. **Absent fields retain the legacy
`true`/`true` semantics.** Parsing does not materialize defaults or rewrite a saved
definition, and the pinned legacy definition digests remain unchanged.

Review readiness checks actual source bytes, the exact accepted visit and invocation,
native Dispatch settlement and clean commit identity. Source changes remove readiness.
Review refuses Git indexes with assume-unchanged or skip-worktree flags because Git
status alone cannot establish that their worktree bytes match a clean commit. Orca
does not change those flags. Native checks use trusted literal program/argv, never
stage prose or shell interpolation.

## Results, interruptions and recovery

New Chat invocations receive task scope and a short result contract, without worker
bookkeeping. Only the normal root turn opened by the exact accepted send can supply
a result. Another input, an unknown end, cancellation or a provider failure cannot
be promoted to approval. Terminal and existing unpinned active receipts retain their
attested submission protocol.

Control fields (`status`, `outcomeId`, typed `evidence`) stay separate from optional
`explanation`. Deterministic normalization moves only evidence annotations named
`verification`, `commit`, `notes` or `explanation` into explanation. It preserves their
JSON data, every finding and the declared outcome. Other schema errors remain holds;
there is no format-only agent rerun and no inferred approval. Structured provider
output is not requested without verified provider support.

`pipeline status --api-version 2` exposes `currentInvocation.responseObservation`:
the request/client message identities, root turn and final response row, bounded raw
text, its canonical fingerprint, truncation flag and precise validation issues.
The original blocks remain in the native journal under those identities. Quota,
cancellation, malformed result, transport uncertainty and source mismatch retain
separate categories; source mismatch can retain the provider category too.

`pipeline reconcile --api-version 2` inspects the existing invocation. It can recover
a normal pinned response after a source-read interruption, save the candidate, and
settle the exact Dispatch without another agent turn. Recovery rechecks current
source, clean review commit and the same response identity, and settles paused.
Owner gates remain gates. Pipeline and native Dispatch journals are separate,
recoverable writes, not one cross-database transaction. An uncertain native effect
remains held; `retry` cannot bypass it and creates a new visit only after definite
interruption or blocking is established.

## Findings and usage

Findings have stable IDs, retained across returns. A `findingUpdates` entry can report
`fixed`, `open` or `disputed` with a rationale; a dispute also cites its task
requirement. A fixed claim becomes `fixed_verified` only after current trusted checks
and a later accepted review. A dispute is acknowledged only by an explicit owner
gate accepting its candidate. Disappearance from a later response alone does not
remove a finding. `completionPolicy.findingPolicy: tracked` gates important retained
findings on those dispositions. `findingDisputes: owner_acknowledgment` (also the
absent-field default) requires that owner acceptance. The explicit `stage_rationale`
choice accepts requirement-citing disputes from accepted stages without owner gates;
owner acknowledgment remains separately reported. The configurable-review preset
selects this choice explicitly. An absent finding policy retains legacy latest-review
completion semantics. Status reports bounded summaries and explicit omissions;
complete evidence stays in the stage artifacts.

Visit usage reports journal-confirmed duration and available provider-reported root
turn tokens. Codex counters deduplicate repeated totals and use billable increments;
Claude result accounting replaces an earlier observation on replay. Uncached input,
cache read, cache write and output are separate; reasoning is a subset of output.
Helper usage may be unreported. Context-window estimates are not spend totals.
Missing measurements and USD without verified pricing remain unknown, never zero.

## Storage and compatibility

The pipeline journal component is version 3; engine, definition and public API stay
version 2. Opening a version 2 journal upgrades only the component marker and preserves
existing run/definition bytes. Unsupported component versions fail closed. New
optional accounting annotations are declared in wire and durable journal schemas.

Validate upgrades and restart/recovery in a separate background development profile.
Keep the old profile and a consistent pre-upgrade backup for rollback; do not point
an older application at a profile that wrote newer pipeline receipts or annotations.
Do not replace production or reuse active/unknown requests to test an upgrade.

CLI discovery starts with `orca pipeline describe --api-version 2 --json`; template
save/show/validate expose the same schemas. Mutation receipts and runtime/workspace
pins remain required. Reviewed external catalog entries use this same API under
their existing grants and executor confirmation, without a second tool-integration
step.
