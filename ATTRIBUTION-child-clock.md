# Defect C — a working child row shows its spawn time, not its activity

Base: `779667c1e7` (origin/main at time of writing).
Status: **diagnosis complete, mechanism NOT chosen.** Do not pick a fix before reading
"Constraints" and the reference findings that will be appended to this file.

## Observed

A subagent row that had been **working for 14 minutes** displayed **"14m"**. Read as a recency
column ("last seen 14 minutes ago") it looks stale, while the child was in fact the only thing
doing work. Its idle parent, meanwhile, read "now" — see `attr-parent-recency` (defect A).

## Verified mechanism

Read directly at `779667c1e7`:

`src/renderer/src/components/sidebar/worktree-subagent-child-rows.ts:41-47`
```ts
const startedAt = subagent.startedAt > 0 ? subagent.startedAt : args.parentEntry.stateStartedAt
const paneKey = subagentRowKey(args.parentEntry.paneKey, subagent.id)
const entry: AgentStatusEntry = {
  state: activeState ?? 'done',
  prompt: subagent.description ?? subagent.agentType ?? '',
  updatedAt: args.parentEntry.updatedAt,
  stateStartedAt: startedAt,
```

Three things to note:
- `stateStartedAt` is the subagent's **spawn** stamp.
- `prompt` (the row's label) is the subagent's description — this row is *correctly* attributed.
- `updatedAt` is **borrowed from the parent**, which is itself polluted by defect A.

So "14m" is literally "14 minutes since spawn". It is correct-by-field and **cannot be fixed at the
reader** — the number the row wants to show does not exist.

## Reported but NOT personally verified

From a code map; confirm before relying on any of it:

- `src/shared/agent-session-background-task-wire.ts:18-35`, `:26` — the child's wire type reportedly
  has **no activity field at all**; the comment is said to read *"Host epoch ms when the task was
  first observed, so clients render elapsed."*
- `src/main/claude/claude-background-task-tracker.ts:245` (`startedAt: existing?.startedAt ?? this.now()`)
  and `:303` (`startedAt: existing.startedAt`) — first-observed stamp reportedly preserved across
  every roster update, **deliberately**.
- `src/shared/agent-status-types.ts:80-81` — *"Timestamp (ms) when this subagent was first observed."*
- `src/renderer/src/components/dashboard/agent-finished-timestamp.ts:14-16` — `lastEnteredDoneAt`
  reportedly returns `null` for a non-done subagent row, so the row falls through to `startedAt`.

**Verify the "deliberately preserved" claim first.** If the stamp is load-bearing for stable
first-seen sort, then adding a second field is right and mutating this one is wrong.

## The actual question

This is **not** a rendering bug. It is a missing field: there is no per-child last-activity
timestamp anywhere on the wire. So the options differ in kind from defects A and B:

- Add a last-activity field to the child wire type (and keep `startedAt` for elapsed/sort), or
- Derive child activity from producer-attributed journal items — which is exactly the mechanism
  defect B may introduce. **If B attributes items to their producing agent, this defect may be
  solved for free.** That is the preferred outcome; check it before designing anything bespoke.

Note the display question is separate and also unresolved: for a *working* child, is the right
label an elapsed duration ("working 14m") or a recency ("last active 3s ago")? A duration may be
the honest reading of a spawn stamp and may need no new field at all. Decide this explicitly.

## Wire compatibility — mandatory

Any new field crosses the client/host boundary. Follow
`docs/reference/remote-wire-compatibility.md`: a new **optional** field is safe; changing what the
host publishes reaches old clients even with no wire change. Mixed versions are the normal state.
Say which category your change is in.

## Constraints

- `docs/reference/agent-status-store.md:55-62`: readers keep **only** presentation policy.
- `docs/reference/agent-status-store.md:5-8`: do **not** remove the renderer bridge or its
  publication filters in this slice — they still carry native-chat child rows.
- Existing tests pin the spawn stamp; check them before changing behavior:
  `src/renderer/src/components/sidebar/worktree-subagent-child-rows.test.ts:19-54` (asserts
  `row.startedAt === 20` across a freshness matrix) and
  `src/renderer/src/components/sidebar/useWorktreeAgentRows.test.ts:728-768`.

## Your task

1. Re-baseline against current `origin/main`; this file may be stale.
2. Confirm or refute the above **at source**. Do not trust this document.
3. Decide first whether defect B's mechanism already supplies this. Only design a new field if it
   does not.
4. Propose a mechanism; prefer architecture over a guard. State whether it removes the bug class.
5. Mark every claim VERIFIED or UNVERIFIED. Cite file:line.

---

# Reference findings

Five independent implementations were reviewed. Projects are deliberately not named here; describe
any conclusion in repo-native terms only. Every mechanism below was read at source and verified.

## Converged — all five agree

1. **A child's activity never touches the parent row's lifecycle state, label, or timestamp.**
2. **Attribution happens at ingestion (the producer boundary), never as a reader-side filter.**
3. **Exactly one writer of a row's status/recency.** None of the five keeps two writers apart with
   publication filters. They make the second writer *impossible*.
4. **Child -> parent rollups do exist** — but they roll up *status* or a *count*, never a label and
   never a timestamp, and each is explicit and documented.
5. **The row label is a stored title derived from the user's own prompt** — never a backward scan
   for the newest assistant message.

## Closest architectural match (same platform: Electron, host-service process + renderer sidebar
## that nests parent and subagent rows)

- Subagent hook events are routed to a **separate roster at ingestion, before any store write**.
  The ingestion comment reads: *"Subagent activity is not the terminal's lifecycle: no chime, no
  status change, no session id capture."*
- The store method recording subagent events is documented *"Never touches the parent binding's
  lifecycle state."*
- The renderer **derives** status on every read inside a `useMemo` and **stores nothing**.
- The state-entry stamp is preserved server-side as
  `prior !== undefined && !sessionChanged ? prior.startedAt : occurredAt`.
  **There is no done-state special case.** That is the shape of Orca's *main* canonical writer
  (`server-ingest-structured.ts:65`), not the renderer bridge's.

## How the references make a second writer impossible

- One reference's generic update API **structurally omits** the status/recency fields, so the type
  itself forbids a second writer; a lint rule confines cache writes to owner modules.
- One consolidated *"ten independent writers across six slices"* into a single registry writer and
  recorded the decision as an architecture decision record.
- One gates client updates behind a monotonic sequence check and replaces **whole rows**, so a
  client cannot mutate an individual field.

## Where the references DIVERGE — do not claim precedent here

The child clock (defect C) has **no single answer**:
- one shows **no timestamp at all** on the desktop row, carrying liveness via status + derived counts;
- one shows a **live-ticking elapsed duration** that freezes at completion;
- one carries a true **advancing per-child progress field**.

All three do quarantine the spawn stamp from display. So C has several legitimate answers — choose
one with stated reasons; you may not justify it by precedent alone.

## Material deviation to disclose (repo-native terms, for the eventual PR body)

> Orca keeps two real writers of one status row apart with publication filters. Every reference
> implementation examined removes the possibility of a second writer rather than suppressing its
> traffic.

## Feasibility fact established in Orca

The producer already has the attribution and discards it:
- `src/main/claude/claude-structured-item-translation.ts:57` already parses
  `parentToolUseId: claudeText(frame.parent_tool_use_id)`.
- `src/main/claude/claude-structured-journal-translation.ts:143-144` uses it only for
  `observeChildActivity(...)`, then drops it; the item is journaled with no producer trace.
- The journal schemas carry **no producer field at all** — zero hits for
  `parentToolUseId|agentId|parentAgentId|producer|subagentId` in
  `src/shared/agent-session-journal-schemas.ts` and `src/shared/agent-session-journal-types.ts`.
- A canonical subagent id already exists next door:
  `src/main/claude/claude-subagent-roster.ts:121` (`this.ids.canonical(parentToolUseId)`).

So attributing at the producer means **persisting a value we already compute and throw away three
lines later** — not plumbing a new one end to end.

---

# Review, mechanism decision, and implementation plan (2026-09-17)

Every claim below is marked **VERIFIED** (read at source in this worktree at the stated
file:line) or **UNVERIFIED**. Line numbers are against `origin/main` = `25dd70e6118b`.

## 1. Re-baseline and drift

**VERIFIED.** `git fetch origin main` puts `origin/main` at `25dd70e6118b`, exactly **one**
commit ahead of this document's base `779667c1e7`: `25dd70e611 Test: target question card title
by testid instead of text (#21153)`. It touches `NativeChatQuestionCard.tsx`,
`browser-history-match-budget.ts` and two tests. **No drift** on anything this defect cites —
every line the document quotes still reads as quoted, including
`worktree-subagent-child-rows.ts:41-47`.

## 2. The claims the document left unverified

### 2.1 Is `startedAt` deliberately preserved? Yes — and the source says so, in two places

**VERIFIED.** `src/main/claude/claude-settled-background-tasks.ts:28-30` documents the field on
the tracked row itself:

> `/** First-observed epoch ms; preserved across updates and roster replacement`
> ` *  so clients can render elapsed and keep a stable first-seen sort. */`

That single comment names **both** load-bearing uses and settles the question the document asked
first. The preservation sites the document guessed at are real:

- **VERIFIED** `src/main/claude/claude-background-task-tracker.ts:245` —
  `startedAt: existing?.startedAt ?? this.now(),` inside `replaceAggregateRoster`.
- **VERIFIED** `src/main/claude/claude-background-task-tracker.ts:303` —
  `startedAt: existing.startedAt,` inside `upsert`.

The same discipline holds independently on the **hook** path, which the document did not look at:

- **VERIFIED** `src/shared/claude-subagent-roster.ts:73-84` — `upsertWorkingClaudeSubagent`'s
  `existing` branch writes `state`, `agentType`, `description` and two authority flags, and
  **never touches `startedAt`**. The only write is at creation, `:93`.
- **VERIFIED** `src/shared/codex-subagent-roster.ts:41-47` — identical shape; the only write is
  `:56`.

Four further consumers make mutating it actively wrong, all **VERIFIED**:

1. `src/shared/claude-subagent-roster.ts:351-353` sorts snapshots by `startedAt`, with the stated
   reason *"hook arrival order is not stable across reconciles; sort so equal rosters serialize
   identically and downstream equality checks can dedupe."* Mutating it reshuffles the array on
   every ping and defeats that dedupe. `src/shared/codex-subagent-roster.ts:122` does the same.
2. `src/renderer/src/components/sidebar/worktree-agent-row-order.ts:17-23` —
   `compareWorktreeAgentRows` uses `row.startedAt` as its **primary** sort key, and
   `worktree-agent-rows.ts:273` applies it to every row including children. A mutating stamp
   reorders sibling child rows under the user's cursor.
3. `src/shared/claude-subagent-roster.ts:99-113` — `evictOldestIdleClaudeSubagent` picks the
   victim by smallest `startedAt`. Mutating it changes which teammate is dropped at the cap.
4. `src/shared/agent-status-types.ts:334` — `agentSubagentsEqual` compares `startedAt`, and
   `src/shared/agent-hook-relay.ts:130-136` folds it into the shed-roster digest.

**Verdict: the stamp is load-bearing for stable first-seen ordering and for roster identity.
Mutating it is wrong. A second field is required.** This settles the question the document
told us to settle first.

### 2.2 Does the wire type have an activity field? No

**VERIFIED.** `src/shared/agent-session-background-task-wire.ts:18-35` — `AgentSessionBackgroundTask`
carries exactly `id`, `kind`, `description?`, `name?`, `state?`, `startedAt?`, `totalTokens?`,
`stoppable?`. No activity field. `:26` reads verbatim
*"Host epoch ms when the task was first observed, so clients render elapsed."*
`backgroundTaskFieldsEqual` at `:53-67` compares those eight and nothing else.

**VERIFIED.** `src/shared/agent-status-types.ts:72-82` — `AgentSubagentSnapshot` carries
`id`, `agentType?`, `model?`, `description?`, `state`, `startedAt`. `:80` reads
*"Timestamp (ms) when this subagent was first observed."* No activity field. The document's
`:80-81` citation is exact.

### 2.3 `lastEnteredDoneAt` for a child row

**VERIFIED, and stronger than reported.** `src/renderer/src/components/dashboard/agent-finished-timestamp.ts:14-16`
returns `null` when `rowSource === 'subagent' && state !== 'done'`. But
`worktree-subagent-child-rows.ts:39` maps `'done'` to `'idle'` before the row is built, so a
subagent row's `state` is one of `working | blocked | waiting | idle | unverifiable` and is
**never `'done'`**. The guard therefore fires on **every** child row, always. A child row can
never display a finish time; it always falls through to `startedAt`.

### 2.4 One claim the document did not make, which changes the design

**VERIFIED.** *The producer already computes the child's activity timestamp, already passes it
into the roster upsert, and the upsert discards it.* On all three paths:

- `src/shared/agent-hook-listener/providers/claude-events.ts:161-167` — every child-attributed
  `PreToolUse` / `PostToolUse` / `PostToolUseFailure` calls
  `upsertWorkingClaudeSubagent(roster, eventAgentId, {...}, Date.now())`. That `Date.now()` **is**
  the child's own last-activity moment. `upsertWorkingClaudeSubagent`'s `existing` branch
  (`claude-subagent-roster.ts:73-84`) never reads the `now` parameter.
- `src/shared/agent-hook-listener/providers/codex-events.ts:133-143` — identical, for every
  child-attributed Codex hook event. `upsertCodexSubagent`'s `existing` branch
  (`codex-subagent-roster.ts:41-47`) never reads `now`.
- `src/main/claude/claude-background-task-tracker.ts:134-142` — the provider sends a
  per-child `task_progress` frame whose own comment says *"Progress `description` is the current
  activity (\"Running <tool>\")"*. Orca takes `totalTokens` off it and **drops the frame entirely
  when it carries no usage** (`:139-140`, `return false`). The arrival time — proof the child is
  alive right now — is never recorded.

So this is not end-to-end plumbing. On every path the value is already in hand at the producer
boundary and thrown away within a few lines, exactly as the document's "Feasibility fact" says
of the journal — but it holds for the sidebar's actual producers, which the journal is not.

## 3. Framing: is this a missing field or a display bug? — **Both, and not where the document says**

### The time column is not a recency column. It is documented as bimodal, and it is already elapsed-for-active

**VERIFIED**, in two independent places:

- `src/renderer/src/components/dashboard/agent-finished-timestamp.ts:4-9`:
  *"Shared by the left worktree sidebar and the pop-out dashboard so both time from the SAME
  event: a finished agent reads 'N since it finished', an active one falls through to its start."*
- `src/shared/dashboard-snapshot.ts:125-130`: `startedAt` is *"'Started … ago' display"*;
  `finishedAt` *"Drives the card's time column: finished cards read time-since-finish (parity with
  the left worktree sidebar), active cards fall back to startedAt."*

And that is what the code does: `worktree-card-compact-agent-row.tsx:59-66` takes
`lastEnteredDoneAt(agent)` when non-null, else `agent.startedAt`, and renders it through
`formatShortTimeAgo` (`src/renderer/src/lib/short-time-ago.ts:1-16`, which emits a bare
`now / 14m / 3h / 2d` with no words).

**So "14m" on a child that has been working 14 minutes is correct, and it is an elapsed
duration — the same reading the parent row's own active-state number has.** The premise in
"Observed" — that the row *"sits in a column read as recency"* — is **refuted at source**. The
column reads as recency only for rows that have finished.

### Then why did it look wrong? Because of defect A, not C

The report is a *comparison*: the child read `14m` while its idle parent read `now`. Defect A's
document establishes (and its chain is independently consistent with what I read here) that the
parent's `now` was **false** — the child's own frames were restamping the parent's
`stateStartedAt`. Put an honest number on the parent and the child's honest `14m` stops looking
like the anomaly. **C should not be fixed by making the child's number match a parent number that
is itself wrong.**

### The honest rendering for a working child is a DURATION, not a recency. Reasons, not precedent

1. **A recency on a healthy child conveys nothing.** A working child emits a tool event every few
   seconds (`claude-events.ts:161-167` fires on each one), so "last active 3s ago" is a constant.
   The number a user acts on is the elapsed: *this has been running forty minutes, something is
   wrong.* The duration carries the information; the recency carries a pulse.
2. **Orca would otherwise disagree with itself about the same child.** The pop-out dashboard's
   subagent row is `{ id, name, dotState }` — **no timestamp at all**
   (`src/shared/dashboard-snapshot.ts:55-59`, VERIFIED). The sidebar's column is contractually
   "start for active, finish for done". Introducing a third meaning for children only, in one of
   the three surfaces, is the reader-side precedence rule
   `docs/reference/agent-status-store.md:55-62` forbids.
3. **Where recency *is* the useful reading, Orca already has a dedicated surface for it, in
   words.** `worktree-card-compact-agent-row.tsx:36-38` renders `agentNoUpdateLabel(entry, now)`
   on the **secondary** line for an `unverifiable` row, producing `No update in 14m`
   (`src/renderer/src/lib/agent-row-decay-state.ts:46-56`). Its own comment says it *"deliberately
   says what Orca last heard rather than what the agent is doing."* That is the recency channel,
   and it is reserved for rows whose liveness is in doubt — a derived judgement, not a second
   stored clock. Adding a recency to the time column would be a second representation of liveness
   sitting beside a derivation that already exists.

**Decision: `getCompactAgentTime` is not changed. No new field is needed for the time column.**

### The real, independent defect in C: the child's recency clock is its parent's

**VERIFIED.** The recency surface above reads `agentStatusEvidenceObservedAt(entry)` =
`mirroredEvidenceReceivedAt ?? evidenceObservedAt ?? updatedAt`
(`src/shared/agent-status-freshness.ts:13-29`). The synthetic child entry
(`worktree-subagent-child-rows.ts:43-60`) sets **no** `evidenceObservedAt` and sets
`updatedAt: args.parentEntry.updatedAt` (`:46`). So when a child row decays to `unverifiable`,
`No update in N` is **the parent's silence, reported as the child's**.

With exactly one child this reads correctly by coincidence — the child's activity is what advanced
the parent's `updatedAt` — which is why it survived. With **siblings** it is wrong: child X quiet
for ten minutes while child Y pings shows `No update in 0m` on X's row. A parent that speaks for
itself does the same. That is the attribution bug class this family is about, in its mirror form:
convergence finding #1 says a child's activity must never stamp the parent's row; its dual is that
the parent's must never stamp the child's.

**So the missing field is real — but it is a missing *recency* clock feeding an existing recency
label, not a missing number for the time column.**

## 4. Does defect B solve this for free? **No.** Three independent reasons

B's own document (read at `brennanb2025/attr-parent-label`, doc-only, no implementation) proposes
attributing **journal items** to their producing agent and scoping projections by it, and
speculates that this *"likely also resolves defects A and C."* For A that is plausible — A's chain
runs through `journal-reducer.ts:69`'s journal-wide `lastActivityAt`. For **C it does not hold**:

1. **The hook path has no journal at all.** Child rows for CLI panes come from
   `claudeRosterToSnapshots` / `codexRosterToSnapshots` (`src/shared/claude-subagent-roster.ts:335`,
   `src/shared/codex-subagent-roster.ts:108`), fed by hook lifecycle and tool events in
   `src/shared/agent-hook-listener/providers/`. No journal item exists on that path to attribute.
   **VERIFIED.**
2. **A backgrounded child emits no parent-attributed frames even on the structured path.**
   `src/main/claude/claude-subagent-roster.ts:3-7` states it directly: *"a BACKGROUNDED subagent
   emits no child frames at all, so a roster fed by `parent_tool_use_id` alone would leave every
   one of them an unlabelled row forever."* Backgrounded children are precisely the long-running
   ones this defect is about. A per-producer journal clock would be permanently silent for them.
   **VERIFIED.**
3. **Even on the structured path the sidebar child row is not built from journal items.**
   `StructuredAgentSessionStatusBridge.tsx:103-127` builds the child snapshots from
   `summary.backgroundTasks` — the `ClaudeBackgroundTaskTracker` roster, fed from
   `background_tasks` / `task_*` system frames (`claude-structured-session-adapter.ts:209`), not
   from the journal. A journal-derived per-producer clock would still need new plumbing into that
   roster. **VERIFIED.**

**Conclusion: B and C are independent. Do not sequence C behind B, and do not wait for B's
mechanism.** They are complementary — B attributes *content*, C attributes *liveness* — and they
touch disjoint files. Either may land first.

## 5. Mechanism

**Give the child its own `evidenceObservedAt`, stamped at the producer boundary from the
observation Orca already receives, and let the existing recency reader prefer it.**

Why this and not a bespoke field:

- **It reuses the field that already means exactly this.** `AgentStatusEntry.evidenceObservedAt`
  is *"Timestamp (ms) the reported evidence was first observed. Separate from `updatedAt`, which
  is the delivery/ordering clock"* (`agent-status-types.ts:95-98`). Use that name on the child
  types too, and the reader edit becomes a single spread: `agentStatusEvidenceObservedAt` already
  prefers it and already falls back to `updatedAt`. A grep for a second last-activity concept
  stays empty.
- **It removes the bug class rather than guarding it.** The defect is a reader reading a clock
  that belongs to a different producer. After this, the child row reads a clock stamped by the
  child's own evidence, at the same boundary that already classifies the event as the child's
  (`claude-events.ts:153-161` computes `subagentOriginId` for exactly this purpose). Attribution
  happens at ingestion, which is convergence finding #2.
- **It does not add a second writer.** The producers named below are the only writers of a
  subagent row today; each gains one assignment. No new writer, no new publication filter.
- **The time column is untouched**, so it cannot start disagreeing with the pop-out dashboard.

Honest limits of the claim, stated rather than left implicit:

- This does **not** make an idle-parked teammate's row time its idle-since moment; there is no
  settle stamp on `AgentSubagentSnapshot`. Out of scope, listed in §10.
- On the structured path, `foldClaudeBackgroundTasksIntoRoster` stamps from the **lead's** Stop
  inventory. That is still an observation *of the child* (the provider asserts it is running now),
  not a borrow of the parent's clock — but it is a coarser observation and a reviewer should
  confirm the distinction is acceptable. Marked for review in §9 Step 2.

## 6. Wire compatibility — **Rule 1 on two surfaces, with an explicit absence semantic**

Read `docs/reference/remote-wire-compatibility.md`. Two additive optional numeric fields:

| Surface | Type | Crosses | Category |
| --- | --- | --- | --- |
| `AgentSubagentSnapshot.evidenceObservedAt?: number` (`src/shared/agent-status-types.ts:72-82`) | hook status payload | agent-hook relay, WSL/SSH relay receivers (`src/shared/agent-hook-relay.ts`) | **Rule 1** |
| `AgentSessionBackgroundTask.evidenceObservedAt?: number` (`src/shared/agent-session-background-task-wire.ts:18-35`) | `agentSession.*` | paired desktop client ↔ remote Orca host | **Rule 1** |

- **Not Rule 2.** No new opcode, no new frame, no new journal item kind. Both are new keys on
  frames that already exist, decoded by parsers that ignore unknown keys.
- **Not Rule 3.** Nothing the host already publishes changes meaning, units, nullability, or
  population. `startedAt` keeps its exact value and its exact comment on both types. No content
  stops being synthesized. One caveat below.
- **What an old client does:** ignores the key entirely. Its child rows keep borrowing the
  parent's `updatedAt` for `No update in N`, which is today's behaviour — so the skew degrades to
  the status quo, never to something worse.
- **What a new client against an old host does — this is the part to get right.** The field is
  **absent**, and absence must read as *the host never reported it*, never as *this child has
  never been active*. This is the `agentWait` worked example
  (`remote-wire-compatibility.md:198-217`): collapsing absent into a value makes an old host
  indistinguishable from a silent child. Concretely: `evidenceObservedAt` must be left
  `undefined` — **never normalized to `0`**, which `startedAt` does at
  `agent-status-types.ts:295-296` and which would render `No update in 56 years`. The reader
  then falls through to `updatedAt` through the existing helper, with no extra branch.
- **No client may ever require it.** Nothing gates on presence; the only reader prefers it when
  present.
- **Rule-3 caveat to state in the PR body:** `claude-background-task-tracker.ts:139-140` must stop
  dropping a usage-free `task_progress` frame. That changes **publish frequency** on an existing
  path, not frame content. A `task_progress` frame that today produces no publish will produce
  one. Old clients decode the identical frame shape and see a row whose fields are unchanged
  except the key they ignore, so this is inside Rule 1 — but it is a behaviour change on a shared
  path and belongs in the PR body, not buried.
- **Enforcement:** `tests/e2e/cross-version-wire/cross-version-agent-session-wire.unit.test.ts`
  covers the `agentSession.*` surface and stays green for an added optional field by design
  (`remote-wire-compatibility.md:128-134`). Add no `not.toHaveProperty` assertion anywhere —
  `remote-wire-compatibility.md:136-144` explains why that rots on the next release cut.
- **Mobile is not affected. VERIFIED:** `rg` over `mobile/src/` finds **zero** non-test references
  to `subagent` or `backgroundTask` in production code.

## 7. The pinned tests

Neither test needs to change, and both should be **kept and extended**. They pin the right thing.

- **`worktree-subagent-child-rows.test.ts:19-54`** asserts `row.startedAt === 20` across a
  14-case freshness matrix, and also asserts `parentEntry.subagents` is unmutated. That is exactly
  the invariant §2.1 proved load-bearing. **Keep verbatim.** Extend the same file with two new
  cases: (a) a subagent carrying `evidenceObservedAt` produces a row whose
  `entry.evidenceObservedAt` is the child's value and whose `startedAt` is still the spawn stamp;
  (b) a subagent **without** it produces a row with `entry.evidenceObservedAt === undefined`, so
  `agentStatusEvidenceObservedAt` falls back to the parent's `updatedAt` — the old-host skew,
  pinned.
- **`useWorktreeAgentRows.test.ts:728-768`** asserts `startedAt: 1500` for a child spawned at
  1500, plus lineage and label. **Keep verbatim.** Add one sibling case: two children, one pinged
  recently and one long quiet, and assert their `entry.evidenceObservedAt` values **differ**. That
  is the multi-child case that makes the parent borrow observably wrong, and it is the regression
  test this defect most needs — today it is untestable because the field does not exist.

**VERIFIED** baseline: `pnpm test src/renderer/src/components/sidebar/worktree-subagent-child-rows.test.ts`
→ 14 passed, 147ms, at `origin/main` + this branch's docs.

## 8. Should the fix also stop the child borrowing the parent's `updatedAt`? — **Partly. Demote it, do not delete it.**

`worktree-subagent-child-rows.ts:46` sets `updatedAt: args.parentEntry.updatedAt`. After this
change it stays, but it is no longer the child's recency clock — it becomes the documented
**fallback for a host that predates the field**, which is precisely what Rule 1 requires of an
absent optional. `agentStatusEvidenceObservedAt` already encodes that fallback, so demoting the
borrow costs one added spread line and no new branch.

Deleting it is wrong. The alternatives are both worse:
- setting `updatedAt` to the spawn stamp makes every child on an old host read
  `No update in <its entire lifetime>`;
- setting it to `now` fabricates freshness, which is the exact defect on the parent side (A).

The residual must be stated plainly: **while defect A is unfixed, the fallback clock is polluted**,
so a child row on an old host still inherits a wrong number. That pollution is A's to fix; C's
field is what lets a current host stop depending on it at all. Recording this here rather than
silently relying on A is the point.

## 9. Implementation plan

Independent of A and B; no shared files. Land in any order.

### Step 1 — wire types (additive only)

1. `src/shared/agent-status-types.ts`
   - Add to `AgentSubagentSnapshot` (`:72-82`), below `startedAt`:
     `evidenceObservedAt?: number` with a one-line comment: last moment the host observed this
     child's own activity; absent means the host never reported it.
   - `normalizeSubagentSnapshot` (`:271-300`): accept it as an optional finite number.
     **Do not mirror the `startedAt` `?? 0` at `:295-296`** — absent must stay `undefined` (§6).
   - `agentSubagentsEqual` (`:322-345`): add the comparison.
2. `src/shared/agent-hook-relay.ts:130-136` — add it to `subagentRosterDigest`'s stable tuple, so
   a roster differing only in this field cannot collide with a shed digest.
3. `src/shared/agent-session-background-task-wire.ts` — add `evidenceObservedAt?: number` to
   `AgentSessionBackgroundTask` (`:18-35`) and to `backgroundTaskFieldsEqual` (`:53-67`).

### Step 2 — producers stamp what they already compute

4. `src/shared/claude-subagent-roster.ts`
   - `TrackedClaudeSubagent` (`:21-53`): add `evidenceObservedAt?: number`.
   - `upsertWorkingClaudeSubagent` `existing` branch (`:73-84`): `existing.evidenceObservedAt = now`.
     Create branch (`:91-96`): `evidenceObservedAt: now`. **Leave `startedAt` untouched at both.**
   - `foldClaudeBackgroundTasksIntoRoster` (`:154-248`): stamp on the id-exact running match
     (`:183-189`). **Flag for review** — this observation arrives on the lead's Stop payload
     (§5 limits).
   - `claudeRosterToSnapshots` (`:335-355`): emit it when defined. **Do not change the sort at
     `:353`.**
5. `src/shared/agent-hook-listener/providers/claude-roster-state.ts:155-180` —
   `seedClaudeSubagentRosterFromSnapshots` carries `snapshot.evidenceObservedAt` through, so a
   restored row does not read as freshly observed. Absent stays absent.
6. `src/shared/codex-subagent-roster.ts` — same three edits: `TrackedCodexSubagent` (`:14-20`),
   `upsertCodexSubagent` existing (`:41-47`) and create (`:51-57`), `codexRosterToSnapshots`
   (`:108-123`), and `seedCodexSubagentRoster` (`:86-105`).
   **Two call sites must NOT stamp:** `setCodexSubagentModel` (`:70-84`), which its own comment
   says never touches lifecycle; and `codex-subagent-transcript.ts:287-292`, which passes
   `tracked.startedAt` — a **spawn** stamp — as `now`. Stamping recency there would backdate it to
   the spawn. Give that call site an explicit observation argument or leave the field alone.
7. `src/main/claude/claude-settled-background-tasks.ts`
   - `TrackedClaudeBackgroundTask` (`:18-32`): add `evidenceObservedAt?: number`.
   - `claudeBackgroundTaskDetail` (`:34-49`): project it onto the wire row when defined.
8. `src/main/claude/claude-background-task-tracker.ts` — stamp `this.now()` on every frame that is
   evidence the task is alive: `task_started` upsert (`:164-171`), `task_updated` upsert
   (`:198-205`), `replaceAggregateRoster` (`:236-248`), and `upsert`'s existing branch
   (`:295-307`). **Preserve `:245` and `:303` exactly as written.**
   **The load-bearing edit in this slice:** `task_progress` (`:134-142`) currently returns `false`
   and writes nothing when the frame carries no `totalTokens` (`:139-140`). A progress frame with
   no usage is still proof the child is alive. Stamp before that early return, and return `true`
   so the state refreshes. Everything else about that branch stays — in particular the comment's
   rule that progress `description` must not overwrite the task's name.

### Step 3 — bridge

9. `src/renderer/src/components/native-chat/StructuredAgentSessionStatusBridge.tsx:115-121` —
   carry `task.evidenceObservedAt` onto the snapshot when defined. The write gate at `:168` uses
   `agentSubagentsEqual`, which Step 1 already widened.

### Step 4 — reader (presentation policy only)

10. `src/renderer/src/components/sidebar/worktree-subagent-child-rows.ts:43-60` — add exactly one
    line to the synthetic entry:
    `...(subagent.evidenceObservedAt !== undefined ? { evidenceObservedAt: subagent.evidenceObservedAt } : {})`
    Keep `updatedAt: args.parentEntry.updatedAt` (`:46`) as the documented old-host fallback (§8).
    Keep `stateStartedAt: startedAt` (`:47`) and `row.startedAt` (`:69`) unchanged.
11. **No change** to `worktree-card-compact-agent-row.tsx`, `agent-finished-timestamp.ts`,
    `short-time-ago.ts`, `agent-row-decay-state.ts`, or `agent-status-child-work-freshness.ts`.
    The recency label already prefers the new clock through
    `agentStatusEvidenceObservedAt` (`agent-status-freshness.ts:25-29`). A reuse check on the
    consumer side should come back empty — that is the success signal.

### Step 5 — tests

12. Extend the two pinned tests as in §7 (keep every existing assertion).
13. `src/shared/claude-subagent-roster.test.ts` / `codex-subagent-roster.test.ts`: a second upsert
    for an existing id advances `evidenceObservedAt` and **leaves `startedAt` unchanged**, and the
    snapshot sort order is unchanged across the advance. This is the ablation that proves the two
    stamps are genuinely separate.
14. `src/main/claude/claude-background-task-tracker.test.ts`: a `task_progress` frame **with no
    `usage`** advances `evidenceObservedAt`, preserves `startedAt`, preserves `name`, and reports
    changed. Pin this explicitly — it is the branch that today returns early.
15. A relay test that a roster differing only in `evidenceObservedAt` produces a different shed
    digest.
16. Gates: `pnpm tc`, `pnpm test` on the touched paths, `oxlint`,
    `pnpm run check:code-quality:changed`, plus
    `pnpm exec vitest run --config config/vitest.config.ts tests/e2e/cross-version-wire/cross-version-agent-session-wire.unit.test.ts`.
    Restore `pnpm-lock.yaml` with `git checkout -- pnpm-lock.yaml` after any test run — that file
    only, never a bare checkout.

## 10. Risks, and what is deliberately not fixed

1. **Publish/fanout churn.** `evidenceObservedAt` changes on every child tool event, so
   `agentSubagentsEqual` stops returning true for consecutive pings.
   - `agent-status-live-entry-builder.ts:260-262` uses it only for **array reference reuse**, not
     as a fanout gate, so the cost is a new `subagents` array per child event and the React
     re-renders that follow. **UNVERIFIED: not measured.** Measure before merging; if it bites, the
     mitigation is to quantize the stamp to a coarse bucket at the producer, and that tradeoff
     should be recorded rather than applied silently.
   - `StructuredAgentSessionStatusBridge.tsx:160-180` **is** a write gate, but its chain already
     includes `current.updatedAt === summary.updatedAt`, which moves on every publish anyway, so
     the added term changes nothing there. **VERIFIED** by reading the gate.
2. **Frequency change on `task_progress`.** Step 2/8 makes usage-free progress frames produce a
   publish where today they produce none. Rule-1 safe, but it is the one behavioural change on a
   shared path (§6).
3. **Silent no-op if a provider sends no child-attributed events.** For a provider whose children
   emit nothing, the field stays absent and the row keeps today's behaviour. That is the correct
   degrade, but it means the fix is unobservable on such a provider — QA must pick a provider and
   a child shape that actually emits, and say which.
4. **Not fixed: an idle-parked teammate's row still times from spawn.** There is no settle stamp
   on `AgentSubagentSnapshot`. A parked teammate reads `14m` meaning "spawned 14m ago", not
   "parked 14m ago". Separate defect; needs a settled-at field, not this one.
5. **Not fixed: the two-writer structure.** The material deviation this family must disclose —
   Orca keeps two real writers of one status row apart with publication filters, where every
   reference examined removes the possibility of a second writer — is untouched here. C adds no
   writer and removes none. Say so in the PR body rather than implying the slice narrows it.
6. **Not fixed: defect A's pollution of the fallback clock** (§8).

## 11. Claim ledger

**VERIFIED at source in this worktree:** §1 drift; §2.1 all five preservation/consumer sites;
§2.2 both wire types; §2.3 the always-null guard; §2.4 all three discard sites; §3 both
column-contract docstrings, `formatShortTimeAgo`, the pop-out subagent shape, the
`agentNoUpdateLabel` surface, the `updatedAt` borrow, the `agentStatusEvidenceObservedAt`
fallback chain; §4 all three reasons; §6 the mobile-consumer absence and the `startedAt` `?? 0`
normalization hazard; §7 the baseline test run; §10.1 second bullet.

**UNVERIFIED:** §10.1 first bullet (fanout churn is reasoned from the code path, not measured);
the assertion that defect A's chain is the cause of the reported `now` on the parent (read from
A's document and consistent with what I read here, but A's journal-reducer line was not
re-read in this worktree); any statement about what B *will* do, since B is doc-only — its branch
contains one markdown file and no implementation.
