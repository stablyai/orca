# Cmd+J typed-query ranking

Status: proposed design, reviewed against the current implementation. This is
not a description of behavior already shipped.

This contract orders typed-query entity results in Cmd+J and the tab-bar
omnibox. It leaves empty-query Recent ordering, matching acceptance,
normalization, typo distance, evidence isolation, and task-URL routing intact,
except for the explicitly described restoration of elided fields and correction
of proof-dependent omnibox eligibility below.
Settings/action section leadership remains a separate policy.

The defect: old titles starting with `atlas` beat recently active titles such
as `Clarify Atlas action items`. The existing comparator compares whole-query
placement before activity, so it never reaches the timestamps. The reference
fixture is at the end.

## Decision

Use one relevance order and one recency policy at every entity-result entry
point. Keep field roles and destination eligibility explicit. Prefer a complete
destination, literal word-boundary proof, and the row's own identity before
using activity to distinguish comparable matches. Let placement decide within
an age bucket.

Do not add a weighted score, a special agent-tab boost, or an assignment solver.
Remove the proposed mixed-field band and token-count/field-hop penalties: they
create global assignment trade-offs without a motivating fixture. A mixed
title/path proof and a path-only proof share the secondary tier. This makes the
remaining semantics both explainable and computable without enumerating token
assignments.

## Ordering contract

Compare these keys lexicographically; lower wins except where marked:

```text
1. semantic      destination, recovery, wordMatch, coverage, strength
2. ageBucket     recent activity before older activity
3. placement     whole-query prefix before later word boundary before other
4. timestamp     newer first
5. position      existing surface-specific position preferences
6. identity      stable, source- and host-qualified identity
```

Recency cannot override an unequal semantic key. “A title always beats a path”
is too broad: an exact path destination beats an ordinary title hit, and a
literal path hit beats a title that requires a typo or compact recovery.
A word-boundary path hit also beats an incidental mid-word title substring.

All numeric keys must be finite and all comparison directions explicit. Use a
fixed code-unit order for final identities, with collision-safe tuple encoding;
locale collation can consider distinct strings equal. Typed results
must have a rank, including snippet fallbacks and recognized task URLs. Null
ranks belong to the empty-query path, not this comparator.

### Semantic keys

| Key           | Values, best first                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `destination` | 0 recognized destination; 1 whole eligible field equality; 2 ordinary structured match; 3 snippet fallback |
| `recovery`    | 0 every token has literal proof; 1 at least one token needs `compact` or `typo`                            |
| `wordMatch`   | 0 every token has exact, prefix, or boundary-substring proof; 1 needs literal-substring, compact, or typo  |
| `coverage`    | 0 primary only; 1 needs secondary or alias; 2 needs container; 3 needs supporting evidence                 |
| `strength`    | Worst token strength, using the table below                                                                |

For ordinary matches, recovery, wordMatch, coverage, and strength are the
**maximum** of the chosen per-token values. Coverage describes the least direct
field needed to prove all tokens. Secondary and alias fields have the same coverage value, but
aliases are ineligible for whole-field destination promotion.

`wordMatch` separates deliberate word-boundary matches from incidental
mid-word substrings before comparing field roles. For `atlas`, a path
`/notes/atlas/` beats title `megatlascope`; title `Atlas planning` still beats
that path. It groups exact words and prefixes together so title identity still
decides between those comparable forms. Recovery comes first: a literal
substring still beats a typo. If any token forces recovery, `wordMatch` is 1
for every such assignment and introduces no additional recovery penalty.

| Strength | Token qualities               |
| -------- | ----------------------------- |
| 0        | `field-exact`, `word-exact`   |
| 1        | `field-prefix`, `word-prefix` |
| 2        | `boundary-substring`          |
| 3        | `literal-substring`           |
| 4        | `compact`                     |
| 5        | `typo`                        |

Field start and later word start are placement, not different strengths. Thus
`atl` against `atlas...` and `Clarify Atlas...` has equal strength, just as
`atlas` does. This fixture stays ordered while typing; it is not a promise of
prefix-extension stability for every query, since tokenization and exact
field equality can legitimately change relevance.

There is no `containerOnlyTokens`, `fuzzyTokenCount`, `fieldHopCount`, or
`fieldStartTokens` ordering key. Diagnostics may still count them. For example,
one typo and two typos with otherwise equal semantics are resolved by recency,
not by an additional penalty. Add a key only with a concrete failing fixture
and an account of how candidate selection preserves its optimum.

### Exact destinations

Recognized destinations are:

- Existing parsed task-URL matches, using the existing provider-aware routing.
- A **single-token query** (the complete normalized query, before token
  deduplication) that exactly matches a compatible sigilled numeric
  identifier field: for example `#123` or `!123`, with the existing sigil gate.
  A plain number, partial identifier, or `#123 migration` is not promoted by
  this rule. Every token in a multi-token query must still be covered normally.

`#123 #123` therefore gets ordinary matching, not identifier promotion, even
though query preparation deduplicates its tokens. Require complete normalized
field equality, identifier kind `number`, and the compatible sigil; a compact
match or an identifier embedded in a longer field is insufficient.

Identifier promotion requires positive identifier proof; it must not depend on
that proof being the _only_ match. Adding `#123` to the title cannot demote an
existing recognized identifier. A short identifier can name several rows;
provider and host ownership still apply, and recency may break their ties.

Whole-field equality means the complete normalized query equals a visible
field explicitly marked `destinationEligible: true` and that field can
independently prove every token under the existing matcher rules. Eligibility
is independent of primary/secondary coverage; it is never inferred from role
or text. Alias, container, repository, host-label, and evidence equality do not
qualify. Equality candidates take assignments and highlights from the
qualifying field. Detect them before ordinary candidate pruning.

Builders mark rendered entity titles/display names, file paths, page URLs, and
a worktree's own branch label eligible. A tab's containing branch is not its
destination. Repository and host labels remain searchable secondary fields
for worktrees, including in multi-token queries, but equality cannot promote
all members of that scope. Eligibility does not promise uniqueness: two tabs
can have the same title and two repositories can have a `main` branch.

Do not remove a secondary field merely because its text is contained in another
field: a discarded relative path may itself be an exact destination. Exact
normalized duplicates may share indexing only if role, destination eligibility, and the
rendered proof remain available. Remove the current `dedupeSecondaryTexts` substring
elision. This deliberately restores acceptance as well as ranking: title
`foobar` with secondary `bar` currently rejects the single-letter query `b`,
but the restored secondary field legitimately accepts it as a prefix. Preserve
per-field acceptance rules, not the accidental candidate set caused by elision.
Exact duplicate sharing must also preserve matching profiles: a title and path
with the same text do not necessarily allow the same token qualities.

Recognized results use `qualityClass: exact-intent`. Whole-field equality keeps
the token-derived quality class, usually `exact-visible`. The section-leadership
functions are unchanged, but the selected proof can change their inputs; their
outcomes need regression tests. Quality describes the winning rendered proof,
not the best quality of an unselected assignment. For query `atlas sprint`, a
tab titled `atlas` in worktree `atlas sprint` can select the complete container
phrase for better placement: its class is `exact-evidence`, even though the
mixed title/container alternative would be `exact-visible`. Section leadership
may change in this case; taking the best quality across rows does not restore
that unselected proof. This is an explicit consequence of keeping quality tied
to rendered proof. Coverage is not a replacement for
`PaletteResultQualityClass`.

Recognized task-URL results and snippet fallbacks use named rank constructors,
not fabricated bands or `MAX_SAFE_INTEGER` penalties. Their remaining semantic
keys and placement are neutral zero values: `destination` already puts them
before or after ordinary matches. Sigilled identifier results use the same
recognized-destination rank. Recognition requires its actual proof to be
rendered, including supporting evidence when applicable.

## Field roles

Declare roles at visible-field builders; never infer them from field IDs,
separators, URL syntax, tab type, or execution host.

```ts
type PaletteFieldRole = 'primary' | 'secondary' | 'alias' | 'container'

type PaletteVisibleFieldSemantics = {
  role: PaletteFieldRole
  destinationEligible: boolean
}
```

| Document                     | Primary                  | Secondary                                            | Alias        | Container                                       |
| ---------------------------- | ------------------------ | ---------------------------------------------------- | ------------ | ----------------------------------------------- |
| Workspace tab                | Rendered tab title       | File paths                                           | Type aliases | Worktree, branch, repository, workspace label   |
| Browser page                 | Page title               | Formatted and raw URL                                | None         | Worktree, branch, repository, browser workspace |
| Simulator tab                | Rendered simulator title | None                                                 | Type aliases | Worktree, branch, repository, workspace label   |
| Worktree or folder workspace | Display name             | Branch when present, repository, rendered host label | None         | None                                            |

Supporting evidence is identified by `evidenceId` and always has coverage 3.
Require a role on visible sources; evidence sources need no fictitious visible
role. Derive the old `isContainer` check from visible role for quality-class
calculation. Keep the rule that a proof uses at most one supporting-evidence
unit; tokens from two different reviews or issues cannot be combined.

A composite `repo/branch` candidate keeps both constituent hits. Its recovery,
wordMatch, coverage, and strength are their maxima. It has container coverage for a tab,
but secondary coverage for a worktree. Do not hardcode all composites as
container matches.

For literal, non-equality matches with equal wordMatch, primary coverage beats
secondary coverage regardless of age. A word-boundary worktree display-name
match therefore leads ordinary branch/repo-only word matches. Mixed
primary/secondary and secondary-only matches tie on coverage;
strength, recency, and placement decide between them. These are product choices,
not conclusions established by the reference fixture alone.

## Candidate selection and placement

Reuse `matchPaletteField` and collect its existing token/field matches once.
Keep the field identity, ranges, and composite hits. Do not keep just one
candidate per role: an equally strong candidate in another field may be the
complete phrase witness. Avoid re-matching fields for every evidence unit.

Consider the visible-only scope and each visible-plus-one-evidence-unit scope
separately. A scope is viable only if every token has a candidate. For an
ordinary assignment, minimize the four semantic keys in order:

```text
remaining = candidates for each token within this scope
for key in [recovery, wordMatch, coverage, strength]:
    optimum = max over tokens(min over remaining candidates(candidate[key]))
    discard candidates whose key is greater than optimum
choose a remaining candidate per token using a stable field/composite order
```

This is a bottleneck calculation, not a greedy role choice. Each token can
choose independently inside a fixed evidence scope. Every retained candidate
respects the earlier thresholds, and at least one token forces each threshold.
Therefore the resulting assignment has the lexicographically minimal semantic
rank. No Cartesian product of token choices is needed.

Placement has only three values:

| Placement | Required witness                                                                    |
| --------- | ----------------------------------------------------------------------------------- |
| 0         | Complete normalized query is a prefix of one used visible field                     |
| 1         | Complete normalized query starts at a later word boundary in one used visible field |
| 2         | Otherwise, including distributed token proofs and evidence-only phrases             |

To qualify for placement 0 or 1, **all tokens must be assigned to that field**.
Evaluate one complete-field assignment per qualifying visible field alongside
the ordinary assignment; reuse its collected token matches. Compare semantic
rank, then placement, then stable proof identity. Whole-field equality is also
a complete-field candidate, with the earlier destination key. A composite does
not manufacture a concatenated field for phrase placement. Test every occurrence
of the complete phrase for a later word boundary; the first substring occurrence
may be mid-word. Keep the existing per-token occurrence selection: phrase
placement witnesses a field, not necessarily the precise highlighted occurrence.

This avoids scanning unrelated fields for a better position or optimizing an
arbitrary set of used fields. Token highlights come from the winning proof;
match acceptance and the existing per-field occurrence selection stay intact.
There is no separate contiguous-substring tier: a mid-word phrase and a
distributed proof tie on placement after their semantics tie.

Across evidence scopes, choose the best semantic/placement pair and use stable
proof identity for a tie. A document's assignments share its timestamp, so
assignment selection never needs the clock or row position.

### Carry the complete proof to the row

The current `PaletteTabMatch.secondary` and `typeAlias` are singular, and
`firstIndexed` discards the other assigned fields. Retaining more candidates
without changing this adapter can rank a row on proof the user cannot inspect.
Carry every selected secondary/alias field and its own ranges through the
engine result. Reuse the existing secondary-text and accessible alias treatment;
when several strings are required, preserve all of them in the row's accessible
explanation and an inspectable detail using existing UI primitives. Never apply
ranges from one path/URL representation to another without an offset mapping.

For example, an editor may need `src/main.ts` for query token `src/main.ts`
and `/home/me/project/src/main.ts` for token `/home/me`. Both assignments must
survive conversion to the displayed result. Do not restrict matching to one
secondary field to fit the current result shape: that would change acceptance
and invalidate the independent-token optimization. Complete-field equality and
placement must display the qualifying representation, even if another secondary
string normally has display priority.

## Recency

A search evaluation captures one `nowMs` and passes it through every source
search and merge. Store normalized activity and its bucket on prepared ranking
inputs, not in the cached text document. Query preparation currently carries
only text and tokens; add an explicit search context rather than letting each
engine independently call `Date.now()`.

The owner of a surface evaluation captures this context for the committed
(deferred) query and relevant input snapshot. If one source changes and the
context advances, re-prepare age keys for **all** rows entering that merge,
including results retained by another source's `useMemo`. Include the context in
ranking memo dependencies; cached token proofs can remain reusable. Capturing
one clock only for newly searched sources still mixes incompatible buckets.
Reopening the surface starts a fresh evaluation. Do not resample time on an
unrelated render or introduce a dependency cycle between worktree ranking and
the context owner.

Preserve the existing agent-status snapshot policy while the surface is open;
this ranking change does not subscribe search to every agent-output update.
Recency means activity available in that surface's input snapshot. Same-query
reordering tests should change an input that actually invalidates that snapshot,
not assume continuous agent-status updates are consumed.

Typed-result age badges must use the same normalized activity and evaluation
`nowMs` as ranking, including an unknown timestamp's absent badge. The current
open-session `paletteNowMs` and raw worktree timestamps are not interchangeable
with these ranking inputs. Keep empty-query age behavior outside this change.

For live and retained agent entries, reuse `agentStatusEvidenceObservedAt` from
`src/shared/agent-status-freshness.ts` before normalization. It selects the
reader's receipt clock for mirrored evidence and the authority observation for
local evidence. `collectLiveMetadata` currently uses `updatedAt`, which can be
on a different host's clock or restamped by a replay. A slow remote clock can
make new work appear days old; future-time clamping alone cannot fix this.
Do not stamp activity on reconnect, query evaluation, or receipt of unchanged
cached evidence. Preserve the existing observation/replay contract. Older or
sleeping records without a reader-clock observation retain the documented
best-effort timestamp treatment; do not invent a fresh local timestamp for them.

For each candidate timestamp, treat absent, zero, negative, or non-finite values
as unknown. Clamp finite future timestamps to `nowMs` before both bucketing and
exact comparison. This bounds clock-skew effects without claiming to correct
remote clocks. Resolve a row's activity as the maximum of its valid sources.
Validate individual agent timestamps before reducing them: the current
`maxAgentActivityAt` accepts positive infinity, which can mask valid activity
if normalization happens only after the maximum. Unknown rows use timestamp
key 0 and an explicit unknown bucket; require a finite positive `nowMs` in the context.

| Row                          | Activity sources                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Workspace tab                | Agent activity, tab focus, tab creation                                                        |
| Browser page                 | Page creation; also browser workspace unified-tab focus **only for its currently active page** |
| Simulator tab                | Tab focus, tab creation                                                                        |
| Worktree or folder workspace | Its own `lastActivityAt`                                                                       |

Do not use worktree-wide PTY activity as a fallback for a tab. Background output
on one tab must not refresh every tab in that worktree. Agent activity remains
a deliberate signal, so an output-producing agent can rank ahead of an editor
that has not been focused recently.

Browser recency is a **lossy proxy**, not persisted page-focus history. The
current schema has workspace-tab focus, not per-page focus. Switching the
active page can move the workspace focus proxy to that page; the previous page
falls back to creation even if it was used recently. This change accepts that
limitation. Accurate per-page history is a separate lifecycle/persistence
change, not something this renderer-only comparator can promise.

| Bucket  | Age `nowMs - timestamp`        |
| ------- | ------------------------------ |
| 0       | `[0, 1 hour)`                  |
| 1       | `[1 hour, 24 hours)`           |
| 2       | `[24 hours, 7 days)`           |
| 3       | `[7 days, 14 days)`            |
| 4       | `[14 days, 21 days)`           |
| …       | Subsequent seven-day intervals |
| Unknown | After every known-age bucket   |

For known ages of at least seven days, use
`3 + floor((ageMs - sevenDaysMs) / sevenDaysMs)`. The weekly tail has no
terminal catch-all bucket: an 8-day match beats an 80-day match before
placement when semantics tie. Represent unknown explicitly (for example,
`ageBucket: null`) and compare it after any known bucket; never use infinity
or a fixed numeric sentinel that a valid old timestamp could exceed.

Within a bucket, placement beats timestamp. Across a boundary, even a
one-second difference can decide before placement: ages `59:59.5` and
`60:00.5` fall in different buckets. In the weekly tail, rows almost seven days
apart can share a bucket. Buckets express age classes, **not a minimum meaningful time
difference between two rows**. The thresholds are an initial policy supported
by the fixture, not a proven optimum.

Do not replace buckets with a pairwise “within one hour means tied” comparator:
that relation is not transitive and can produce sorting cycles with placement.

The comparator never reads a clock. No timer re-sorts an idle list just because
a bucket edge passes. Re-evaluation after query or source changes may capture
a new `nowMs`; all its source searches and merges must share it. With fixed
query, rows, non-future timestamps, and positions, clock-only changes can affect
ordering only at bucket edges. Future-clamped rows are an explicit exception:
two future stamps initially tie at `nowMs`; when the clock passes the earlier
stamp, their timestamp keys can separate within bucket 0. Test this transition.
Timestamp updates, changed matches, and changed positions can also reorder rows. Exact timestamp is still a recency signal, just a later
one.

## Consumer integration

Implement a common semantic/recency/placement comparison and reuse it in:

- `comparePaletteTabResults` for each tab engine;
- `comparePaletteRankedItems` for the merged Open Tabs list and typed worktrees;
- `searchOpenTabs` for the tab-bar omnibox.

The comparison keys are shared; only the position suffix may differ. Proof
eligibility remains surface-specific as described below. Cmd+J retains its existing current-tab,
current-worktree, and list-position rules. The omnibox retains workspace,
browser, simulator source preference **as a position tiebreak after timestamp**,
then its existing score. Remove its independent title tiers. Putting band or
source before semantic rank lets a workspace typo beat an exact browser
destination and reinstates inconsistent ranking.

Preserve the omnibox's source/ownership eligibility and four-row result limit,
with one slot reserved for an eligible selection when required below.
Its current `isNameOnlyMatch` also excludes any winning proof with worktree or
repository ranges, including mixed title/container proofs. That predicate is
coupled to candidate selection and cannot safely remain a post-sort filter.

For the omnibox, find the best admissible proof without worktree/repository
fields or composites requiring those fields. Do not exclude every container
role: branch and browser-workspace-label matches are currently allowed. A row
with an admissible title/path proof remains eligible even if its best unrestricted
Cmd+J proof uses excluded fields. If structured matching succeeds only through
excluded fields, keep the existing exclusion; do not turn that exclusion into a
new snippet-fallback opportunity. This is a deliberate correction of accidental
proof-dependent eligibility, not a new text-matching rule.

Sort before truncation; do not truncate per source under an incompatible
comparator. Preserve access to eligible results beyond the cutoff for selection
retention. Cross-surface order parity applies to the unpinned ranking where both the eligible rows
**and their admissible proofs** agree. A four-row omnibox cannot display the
full Cmd+J fixture, and its restricted proof can legitimately rank differently
from Cmd+J's unrestricted proof.

The final identity must include source and execution host, using existing
host-identity helpers. Bare worktree IDs can repeat across hosts. Apply this
when constructing ranking inputs. Do not assume every workspace has a branch
or local filesystem path.

Qualification at the comparator is insufficient if a prior join already borrowed
another host's text or activity. Audit `AgentMetadataTabIndex` and its collectors
(currently tab ID plus bare worktree ID), editor `openFilesById`, and browser
workspace/page joins. Resolve ownership before collecting match text, snippets,
or timestamps, using existing ownership helpers. Test colliding worktree IDs
with independently owned children; where child-ID uniqueness is required, prove
that invariant at ingestion instead of assuming a qualified suffix repairs it.

Carry that ownership through selection and activation. The same-ID fixture must
open the selected host's entity, not merely sort two distinguishable rank keys.
Audit the tab/page activation adapters and any bare-ID lookup they use. This is
a bounded integration requirement, not a broad selection-ID migration: reuse
existing host-qualified identities and host-fenced lookup paths, and fix any
collision exposed by the supported fixture before claiming cross-host parity.

Section ordering remains separate: these keys order entities within their
sections, not settings, actions, and worktrees in one universal flat list.
The existing leading-section preview and trailing-section allocation remain.
A worktree section may therefore precede a stronger individual Open Tabs row.

### Selection during result updates

Distinguish automatic selection from a deliberate user choice. Preserve each
surface's existing automatic-selection behavior: the omnibox follows its best
available result until the user navigates, including replacing an automatically
selected file action when a deferred tab match arrives. Cmd+J retains its
existing selected identity on same-query updates. Query changes clear retained
selection using the existing immediate/deferred reset lifecycle. Preserve the
omnibox's network-action guards; automatic selection is not permission to arm
a newly promoted network action.

After deliberate keyboard navigation or a non-activating pointer selection,
retain the selected host-qualified identity across same-query activity updates
and late source arrivals. An automatic selection already retained by Cmd+J
receives the same cutoff protection. A passive hover or programmatic selection
callback must not establish a new user pin. Selection retention affects display
allocation, never semantic rank or section leadership.

Resolve the selected entity against the complete eligible result set before
truncation. Being outside a cutoff is not removal. For a positive section cap
`K`, if the retained entity falls below the top K, display the top K-1 plus
that entity, in comparator order. The omnibox still displays at most four tab
results; Cmd+J uses the same rule for its current section cap, initially 50.
Apply section retention before its preview/remainder split, update overflow
counts from the actual displayed set, and keep the selected row in view.
Selections in other sections do not reserve a tab-result slot. This is an
explicit exception to displaying the strict top K, not a rank boost.

Use the entity's current proof and activation target from the new evaluation,
not a cached row object. If it closes, leaves the search scope, or no longer
has an admissible match, release retention and use the existing missing-selection
fallback with its activation guards. Closing/reopening or changing the query
also releases retention; merely moving #4 to #5 or #50 to #51 does not.

Keep all eligible sorted candidates available inside the search/controller
pipeline and apply retention at the final display boundary. Existing callers
without a retained selection still receive the ordinary top four. The live-query
recheck in `open-tab-search-retention.ts` must use the same field eligibility and
current host-qualified ownership. It may reject stale rows but must not establish
a pin or treat a rank cutoff as loss of eligibility.

Keep the existing quality-class leadership rules, but compute the best quality
across each section's eligible matches before display truncation. The current
`use-worktree-jump-palette-sections.ts` inspects only each section's first row;
a semantic-first order no longer guarantees that row has the best quality
class. Reuse `bestPaletteQualityRank` across the candidates. Test that a later
`exact-visible` row still prevents a weaker settings/action intent from leading.

## Rollout and implementation map

Land one coherent renderer change. Do not ship a temporary `secondaryOnly`
heuristic and a second competing rank object. The old best-visible-candidate
selection and substring field deduplication can already have discarded the
proof needed by a new comparator; changing sort keys alone is insufficient.

- `palette-match/indexed-field.ts`, `palette-document.ts`: visible roles,
  explicit destination eligibility, and
  named semantic/placement rank; explicit recognized and fallback constructors.
- `palette-match/tab-document.ts`, `worktree-palette-document.ts`, and evidence
  builders/composer: roles, preserved exact-field eligibility, source types.
- `palette-match/match-quality.ts`: wordMatch/strength mapping, role-derived container
  classification; retain the quality-class API.
- `palette-match/match-document.ts`: collected candidates, threshold selection,
  complete-field witnesses, provider-compatible identifier proof.
- `palette-match/palette-query.ts` and search entry points: explicit shared
  search context without tying cached text indexes to time.
- `palette-match/tab-match.ts`, `cmd-j-section-leadership.ts`,
  `components/tab-bar/open-tab-search.ts`: shared rank prefix, position suffix,
  activity propagation, deterministic identity before final limiting.
- `components/use-worktree-jump-palette-sections.ts`: derive best quality over
  section candidates independently of their new entity ordering.
- `workspace-tab-palette-results.ts`, `browser-palette-page-entries.ts`,
  `simulator-palette-search.ts`: the activity-source policy and creation fallback.
- `components/use-worktree-jump-palette-open-tabs.ts`: supply worktree activity
  and **pass `unifiedTabsByWorktree` into the browser builder**, including its
  memo dependencies. The current caller omits this optional argument.
- `components/tab-bar/open-tab-search-entries.ts`: audit the same browser-focus
  argument and shared search context. Fixing the builder alone is insufficient.
- `worktree-palette-task-url-result.ts`, `workspace-tab-agent-snippet-match.ts`:
  explicit special ranks; keep existing acceptance/routing.
- `palette-match/tab-match.ts`, tab engine result adapters, and Cmd+J/omnibox
  row renderers: retain and expose every selected secondary/alias proof.
- `components/tab-bar/open-tab-search.ts`: pass explicit field eligibility into
  candidate selection; remove the proof-dependent worktree/repository postfilter.
- `workspace-tab-agent-metadata.ts`: reader-clock agent observation, finite
  activity reduction, and ownership-preserving metadata collection.
- Workspace/browser entry builders and tab/page activation adapters: audit
  ownership at joins and target lookup, before comparator identity construction.
- Surface controllers and ranking memos: own a shared evaluation context and
  refresh every merged row's age keys when it changes.
- `components/use-worktree-jump-palette-selection-lifecycle.ts`,
  `components/use-worktree-jump-palette-sections.ts`, and
  `components/cmd-j/palette-section-render-cap.ts`: preserve selected eligible
  entities across cap crossings before section layout and selection-ID derivation.
- `components/tab-bar/TabBarCreateEntry.tsx`, `use-open-tab-search.ts`, and
  `open-tab-search-retention.ts`: retain full candidate access until display
  allocation, distinguish automatic selection from a user pin, and preserve
  deferred-query acceptance checks and existing network-action guards.

Audit other users of the shared matcher, including Kanban's board evidence
policy. They must preserve per-field acceptance and evidence isolation; only surfaces
opting into this typed entity comparator gain its recency ordering.

No IPC, RPC, stream-frame, persistence, or Git change is required by this scope.
Use data already present on the client; missing remote activity is unknown,
not a reason to fetch execution state or infer that remote work has stopped.
Adding real browser page-focus history would expand this scope and must follow
[remote wire compatibility](remote-wire-compatibility.md).

## Verification required before shipping

The reference fixture is necessary but insufficient. Tests must use actual
matcher output and consumer inputs, not handwritten ranks alone.

Matcher and proof tests:

- Exact destination, literal/recovery, wordMatch, coverage, and strength each
  decide a pair, with all preceding keys equal.
- Query `atlas`: secondary `/notes/atlas/` beats primary `megatlascope`, but
  primary `Atlas planning` beats that same secondary field. Neither path is
  a whole-field equality. Literal primary substring still beats a typo proof.
- Query `atlas`: primary `atlaz` versus secondary `/notes/atlas/` chooses the
  literal secondary proof, even though its role is less direct.
- Query `atlas sprint`: `sprint` requires container text; `atlas` has a primary
  prefix hit and a secondary exact-word hit. With recovery and wordMatch tied,
  coverage already ties at container, so choose the stronger secondary proof.
- A token forcing wordMatch 1 must not discard another token's stronger
  alternative after coverage is forced elsewhere. Include recovery proofs and
  composite hits in exhaustive selection comparisons for all four thresholds.
- Mixed primary/secondary and secondary-only proofs share coverage. Adding a
  valid alternative proof cannot worsen a row's best semantic/placement rank.
- Compare threshold selection with exhaustive enumeration on small generated
  candidate sets. Include composites and separate evidence scopes.
- Eligible whole-field equality preserves its proof despite overlapping title,
  absolute/relative path, alias, or URL fields. Equality does not bypass token
  acceptance or provider sigils.
- Repository and host equality remain ordinary matches; entity name, path,
  URL, and the worktree's own branch equality retain destination promotion.
  Identical text in eligible and ineligible fields preserves both policies.
- `#123`/`!123` recognition, title duplicates, incompatible providers, plain
  numbers, and multi-token queries; existing task-URL routing stays intact.
- Complete-field placement keeps that field's highlights; unrelated fields and
  composites cannot donate phrase placement. Retain normalization, repeated
  occurrences, range bounds, token limits, and one-evidence-unit tests. Include
  a mid-word first occurrence followed by a valid whole-phrase word boundary.
- `#123 #123` is ordinary matching; elided `bar` is restored for query `b` with
  title `foobar`; identical text under different profiles retains both policies.
- Multiple selected path/URL representations survive the engine adapters and
  remain inspectable with ranges mapped to their own strings.
- The `atlas sprint` complete-container proof has `exact-evidence` quality;
  test its resulting section leadership, not only its numeric entity rank.

Comparator and consumer tests:

- Reference fixture for `atl` and `atlas`, through tab engines, merged Open Tabs,
  and the eligible top four in the omnibox.
- New bucket beats placement only after **all** semantic keys tie; placement
  beats a timestamp difference inside a bucket; timestamp/position/identity
  break successive ties.
- Exact bucket boundaries, a one-second boundary straddle, both rows aging into
  the same bucket, unknown/invalid/future timestamps, and cross-source shared
  `nowMs`.
- Weekly tail boundaries at 7, 14, and 21 days; 8-day versus 80-day matches;
  and known very old timestamps before unknown. Inside a weekly bucket,
  placement still beats exact timestamp. No terminal old-age catch-all.
- Antisymmetry, transitivity, and permutation-invariant sorting with unique
  qualified identities. No `NaN` comparisons and no comparator clock reads.
- The omnibox cannot promote a workspace typo over an exact browser hit; source
  preference only decides after the common keys tie.
- Never-focused tabs do not inherit busy-worktree output; creation is a real
  fallback. Both browser-builder callers supply focus state. Inactive pages
  do not inherit it; switching pages demonstrates the documented proxy limit.
- Same bare IDs on different hosts, folder workspaces, missing remote activity,
  worktree recency, empty-query ordering, and section leadership when the first
  row is not the row with the best quality class.
- Update only one source across a bucket boundary while other source proofs
  remain memoized; all merged age keys use the new context. An unrelated render
  does not advance it, and reopening does.
- A valid omnibox title/path proof survives an alternative worktree/repository
  proof; a query requiring excluded fields stays excluded. Branch and browser
  workspace-label eligibility and snippet-fallback conditions stay intact.
- Select a non-leading row, update activity to reorder results, then activate:
  the same selected entity opens. Cover #4 to #5 in the omnibox, #50 to #51
  in Cmd+J, expanded caps, section leadership changes, scroll visibility, and
  correct overflow counts. Total displayed rows still respect the cap.
- A late tab match replaces an automatically selected omnibox file action;
  it does not replace a manually selected action. Cmd+J preserves its existing
  same-query selection policy. Programmatic callbacks and passive hover do not
  create a manual pin; network-action guards still hold.
- A retained row uses refreshed proof and host-qualified activation data.
  Closing it or removing its admissible match releases retention; query changes,
  deferred commits, and reopening cannot resurrect a pin from the previous query.
- For `orca`, 51 old worktrees in repository `orca` must not crowd a recent
  worktree named `Fix orca startup` in another repository beyond the initial
  cap: its primary word match leads the ordinary repository matches. Repeat
  for a shared host label and verify the actual rendered section order.
- Fast and slow remote agent clocks, retained entries, and replayed observations:
  use reader-clock activity where available; reconnect alone does not refresh it.
- Cross-host collisions do not borrow titles, paths, snippets, or activity;
  activating either result reaches its own host. Document any proven child-ID
  uniqueness assumptions exercised by these fixtures.
- Typed-result age badges agree with rank activity after evaluation changes and
  for invalid/future timestamps; high-frequency agent updates retain the existing
  snapshot policy and do not introduce new search subscriptions.
- Every explicit product-tradeoff pair below, using real field builders.

Keep the existing `palette-match-performance.test.ts` budgets. Add an accepted
16-token corpus with multiple usable fields/evidence alternatives: the current
nominal 16-token query exits on its third token, so it does not exercise full
assignment work. Measure query-time retained candidates/ranges as well as
cached document payload, and include full source search/merge/sort timing. Pre-aggregate visible
candidates per token using the fixed, small recovery/wordMatch/coverage/strength domains;
combine these summaries with each evidence unit's own candidates rather than
rescanning every visible field for every unit. Retain field references for
complete-field witnesses and deterministic proof recovery.
Selection should be linear in the collected token candidates plus token ×
evidence-scope work, not token × visible-field × evidence-scope work.
Count selection work as well as field-match calls; unchanged
`fieldMatchesPerCandidate` alone cannot detect combinatorial selection cost.
Record fresh measurements before changing a ceiling.

For the implementation, run appropriate typechecks, changed-file lint, matcher,
consumer, task-URL, multi-keyword, host-ownership, and performance suites. Use the
Electron skill and Playwright CDP to seed the reference fixture and verify
rendered order and highlights. This document review does not constitute those
implementation checks.

The sibling `cmd-j-ranking-visual.html` illustrates the earlier draft. It is not
an executable specification of this revision; update it from tested matcher
results before using it as validation evidence.

## Product tradeoffs that the reference fixture does not settle

These are the intended consequences of the order, and belong in the evaluation
corpus alongside the motivating success case:

| Query / competing rows                                                                                                        | Expected choice and cost                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `atlas`: old title `atlas planning` versus recent title `meg atlas`, both exact-word                                          | Recency buckets decide before placement.                                                                                |
| `atlas`: old primary `megatlascope` versus recent path `/atlas/`                                                              | Path word match wins: wordMatch precedes coverage. Exact/prefix/boundary title matches still retain primary preference. |
| `atlas`: typo title `atlaz` versus exact evidence token `atlas` in a review                                                   | Literal evidence wins. Recovery precedes both coverage and strength.                                                    |
| `atlas`: two 8-day and 80-day primary exact-word matches, only the older one at prefix                                        | The 8-day match wins in the weekly tail. Within the same weekly bucket, prefix placement can still beat newer activity. |
| `orca`: many worktrees whose repository field equals `orca`, versus a worktree named `Fix orca startup` in another repository | The name's primary word match wins. Repository equality is searchable scope text, not destination promotion.            |
| `bastion`: many worktrees whose rendered host equals `bastion`, versus name `Repair bastion`                                  | The primary name word match wins. Host equality does not promote all workspaces on that host.                           |

The first row is the motivating principle. The remaining rows expose how strong
its relevance guarantees are. Do not claim that the seven-row Atlas fixture
establishes optimal coverage order, equality eligibility, or bucket thresholds.
Before shipping, review the expanded corpus across query lengths, entity types,
and small/large workspace sets, and record expected top results before tuning.
Report top-choice correctness and target position separately from matcher
acceptance and latency. Include the initial visible section layout and selection
after source updates, not only each section's independently sorted list. The
new wordMatch policy and weekly tail are concrete defaults with regression
fixtures, not claims of optimal thresholds. Evaluate exact-word versus prefix
tradeoffs, word-boundary evidence versus visible substrings, and small/large
workspace sets before shipping. Do not tune against the seven-row fixture alone.

## Rejected alternatives

- **Role-first greedy selection:** violates recovery-before-coverage and loses
  stronger proofs when another token already forces the coverage tier.
- **Scope-label destination promotion:** repository and host equality can fill
  the result cap ahead of a primary name word match in a different scope.
- **Primary substring before every secondary word match:** incidental title
  text permanently defeats a more deliberate path match, regardless of activity.
- **Terminal old-age bucket:** stops distinguishing weeks from months or years;
  fixed weekly intervals preserve a total order without a pairwise tolerance.
- **Strict top K after deliberate selection:** can remove a still-eligible
  selected row and silently transfer Enter to another entity.
- **More assignment-sensitive counts:** require extra optimization and obscure
  the motivating decision. The worst required field and strength suffice here.
- **Fixed agent boost:** the defect affects every tab type.
- **Recency before relevance:** makes a newly opened incidental match beat a
  destination the user explicitly named.
- **Strict timestamp before placement:** every focus-time difference wins;
  buckets deliberately preserve placement within coarse age classes.
- **Pairwise age tolerance:** not transitive. Absolute buckets retain a total
  order, with boundary discontinuities acknowledged.
- **Weighted score:** makes relevance guarantees dependent on tuning weights.
- **Omnibox source preference before relevance:** creates two answers to the
  same query on the same eligible candidates.

## Appendix: reference fixture

Representative rows with substituted names, evaluated against one fixed clock:

| Result                                           | Proof for `atlas`             | Age |
| ------------------------------------------------ | ----------------------------- | --: |
| `atlas-follow-up-draft-2026-09-01.md`            | Title, query at prefix        |  2d |
| `atlas-meeting-todo.md`                          | Title, query at prefix        |  3d |
| `Clarify Atlas action items`                     | Title, query at word boundary | <1m |
| `questions-and-answers.md`                       | `notes/atlas/...` path        | 30m |
| `worklog.md`                                     | `notes/atlas/...` path        |  9h |
| `Advance Atlas security review`                  | Title, query at word boundary | 19h |
| An agent-conversation snippet containing `atlas` | Snippet fallback              | 47h |

Expected order:

1. `Clarify Atlas action items` — primary coverage, bucket 0.
2. `Advance Atlas security review` — primary coverage, bucket 1.
3. `atlas-follow-up-draft-2026-09-01.md` — primary coverage, bucket 2, prefix.
4. `atlas-meeting-todo.md` — same keys as the preceding row; older timestamp.
5. `questions-and-answers.md` — secondary coverage, bucket 0.
6. `worklog.md` — secondary coverage, bucket 1.
7. Snippet fallback — terminal destination category.

All six structured rows have exact-word strength for `atlas`, and prefix
strength for `atl`; placement is not strength. The relative order therefore
holds for both queries. The eligible omnibox top four are the four title hits.
