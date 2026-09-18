# Defect A — an idle parent row is stamped "now" by its child's work

Base: `779667c1e7` (origin/main at time of writing).
Status: **diagnosis complete, mechanism NOT chosen.** Do not pick a fix before reading
"Constraints" and the reference findings that will be appended to this file.

## Observed

A structured agent session (native chat) ran a subagent. In the sidebar:

- The **parent** row was stamped **now** — while the parent was idle. The user had written
  nothing since launching the child.
- The **child** row, which was the thing actually working, was stamped **14m**.

The idle row looked live; the live row looked stale.

## Verified mechanism

Every line below was read directly at `779667c1e7`.

1. `src/main/native-chat/agent-session-journal/journal-reducer.ts:69`
   ```ts
   state.lastActivityAt = Math.max(state.lastActivityAt, row.ts)
   ```
   Advances for **every** non-epoch journal row, with no regard for which agent produced it.

2. `src/main/native-chat/agent-session-wire/structured-agent-session-status-feed.ts:264`
   ```ts
   updatedAt: journal.lastActivityAt() || this.deps.now()
   ```
   So `summary.updatedAt` is a journal-wide clock.

3. `src/renderer/src/components/native-chat/StructuredAgentSessionStatusBridge.tsx:192-196`
   ```ts
   stateStartedAt:
     desired.state !== 'done' && current?.state === desired.state
       ? current.stateStartedAt
       : summary.updatedAt,
   ```
   For a `done` (idle) row the first conjunct is false, so `stateStartedAt` is **re-stamped to
   `summary.updatedAt` on every publish**.

4. `src/shared/agent-completion-time.ts:35-44` — `agentEntryCompletionAt` returns
   `entry.stateStartedAt` for a non-interrupted `done` entry.

5. `src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx:59-66` —
   `getCompactAgentTime` displays `lastEnteredDoneAt(agent)` for a done row.

**Chain:** child emits a frame -> row appended to the *parent's* journal -> `lastActivityAt` bumps
-> `summary.updatedAt` bumps -> bridge re-stamps the idle parent's `stateStartedAt` ->
row renders "now".

## The two-writer disagreement

There are two writers for the same pane key, and they use **different rules**:

- Renderer (above): `desired.state !== 'done' && current?.state === desired.state`
- Main, canonical — `src/main/agent-hooks/server/server-ingest-structured.ts:65`:
  ```ts
  stateStartedAt: priorStatus?.state === state ? priorStatus.stateStartedAt : summary.updatedAt,
  ```

Main has **no `!== 'done'` guard**, so main's canonical row holds a stable idle `stateStartedAt`
while the renderer's copy does not. They are kept apart by publication *filters*, not by having one
writer.

Note `agent-completion-time.ts:33` documents the invariant the bridge breaks — `stateStartedAt` is
described as *"unmoved by same-state tool/prompt pings"*.

## Constraints — read before proposing anything

- `docs/reference/agent-status-store.md:55-62`: *"Precedence is decided once, at write time...
  Readers never re-adjudicate... Readers keep only presentation policy and user facts."*
  A renderer-side writer owning a `stateStartedAt` rule is already outside that boundary.
- `docs/reference/agent-status-store.md:184-187`: the renderer bridge still writes these rows
  because forwarding from main *"would give one pane key two writers"*; removing that filter is
  step one of PR 2.
- `docs/reference/agent-status-store.md:5-8`: **do not remove the renderer bridge or its
  publication filters in this slice** — they still carry native-chat child rows.

So the clean architectural fix and the current slice boundary are in tension. Resolving that
tension is part of the task, not something to paper over.

- An existing test **pins the defective behavior**:
  `src/renderer/src/components/native-chat/StructuredAgentSessionStatusBridge.test.tsx:446-477`
  asserts an idle row's `stateStartedAt` advances (`now-100` -> `now-50`). Fixing this means
  changing that test — say so explicitly rather than quietly editing it.
  `:481-493` asserts the non-done case holds steady, confirming the guard is done-only.

## Your task

1. Re-baseline against current `origin/main` before doing anything; this file may be stale.
2. Confirm or refute the chain above **at source**. Do not trust this document.
3. Propose a mechanism. Prefer fixing the architecture over adding a guard beside the existing one.
   State plainly whether your fix removes the bug class or just this instance.
4. State what the fix does to defects B (`attr-parent-label`) and C (`attr-child-clock`) — a single
   attribution mechanism may resolve all three, which is the preferred outcome.
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

# Independent review, architecture verdict, and implementation plan

Reviewed at `origin/main` = `25dd70e611`. Every line quoted below was read in this worktree at that
base. Claims are marked **VERIFIED** (I read it) or **UNVERIFIED** (inference from code I read).

## Re-baseline: what moved

**VERIFIED.** `git fetch origin main` puts `origin/main` at `25dd70e611`, one commit past the doc's
base `779667c1e7`. That commit is `Test: target question card title by testid instead of text
(#21153)` and touches four files, none of them cited here. `git diff 779667c1e7..origin/main` is
empty for all ten files this document cites. **No drift in substance.**

One citation is off, and it matters only for a reader following line numbers:

- **VERIFIED.** The canonical main-process rule is at
  `src/main/agent-hooks/server/server-ingest-structured.ts:63`, not `:65`. The doc cites `:65` in
  two places. The code is verbatim what the doc quotes.

**VERIFIED.** No concurrent fix is in flight for this: `src/main/native-chat/`,
`src/shared/structured-agent-session-projection.ts`, and the bridge are untouched since
`779667c1e7`.

## The chain, verified link by link

All five links **VERIFIED** at source, with two corrections and one addition.

1. **VERIFIED.** `src/main/native-chat/agent-session-journal/journal-reducer.ts:69` —
   `state.lastActivityAt = Math.max(state.lastActivityAt, row.ts)`, reached for every row after the
   `row.kind === 'epoch'` early return at `:66-68`. No producer is consulted, because no row
   carries one.
2. **VERIFIED.** `src/main/native-chat/agent-session-wire/structured-agent-session-status-feed.ts:264`
   — `updatedAt: journal.lastActivityAt() || this.deps.now()`. Backed by
   `.../agent-session-journal/journal-store.ts:179`, which is a bare read of reducer state.
3. **VERIFIED.** `src/renderer/src/components/native-chat/StructuredAgentSessionStatusBridge.tsx:193-196`
   — the `desired.state !== 'done' && current?.state === desired.state` guard, evaluating false for
   every idle row, so `stateStartedAt` is re-stamped to `summary.updatedAt` on every publish.
4. **VERIFIED.** `src/shared/agent-completion-time.ts:35-43` — `agentEntryCompletionAt` returns
   `entry.stateStartedAt` for a non-interrupted, non-boundary `done` entry. The bridge writes
   `sessionBoundary: false` (`StructuredAgentSessionStatusBridge.tsx:156`), so structured rows
   always take that branch.
5. **VERIFIED.** `src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx:59-66` —
   `getCompactAgentTime` prefers `lastEnteredDoneAt(agent)`, which routes through
   `src/renderer/src/components/dashboard/agent-finished-timestamp.ts:21` into
   `agentEntryCompletionAt`.

**The chain holds. The defect is real and reproducible from the code alone.**

### Correction: the contaminated clock is amplified, not merely passed along

**VERIFIED.** `structured-agent-session-status-feed.ts:68`:

```ts
// Settled activity changes ranking; streaming active turns must stay quiet.
(a.status !== 'idle' || a.updatedAt === b.updatedAt) &&
```

`summariesEqual` deliberately makes `updatedAt` significant **only while idle**. So an idle parent
with a running child is the one case where every single child row defeats the equality check,
republishes the whole summary to every local and remote subscriber, and drives one bridge write per
child frame. The doc treats the feed as a pass-through; it is the amplifier.

### Addition: the same conflation exists at three layers, not one

**VERIFIED.** Three independent sites encode "the journal clock moved" as "the parent did
something":

| Layer | Site | The assumption |
| --- | --- | --- |
| Journal | `journal-reducer.ts:69` | any row is this session's activity |
| Host feed | `structured-agent-session-status-feed.ts:68` | an idle session whose clock moved has newly settled work |
| Renderer | `StructuredAgentSessionStatusBridge.tsx:193-196` | an idle row whose clock moved finished a new turn |

They are not three bugs. They are one false premise asserted three times.

### Addition: the state machine already gets attribution right — only the journal does not

This is the single most important finding in this review, and the doc does not have it.

**VERIFIED.** The repo already refuses to let a child's frame drive the parent's lifecycle, in five
separate producer-side filters:

- `src/main/claude/claude-turn-opening.ts:58-60` defines `isRootClaudeFrame`, and `:91` enforces it
  in `createClaudeTurnOpener` — a child frame **cannot open a parent turn**.
- `src/main/claude/claude-turn-opening.ts:43` — a send echo carrying a parent tool id opens no turn.
- `src/main/claude/claude-structured-dispatch.ts:43` — replay-turn resolution requires
  `parent_tool_use_id === null`.
- `src/main/claude/claude-tui-exit.ts:23` and `claude-transcript-branch-proof.ts:130` — sidechain and
  child records are not eligible transcript leaves.
- `src/main/claude/claude-structured-history-window.ts:98` — a child record is not a user prompt.

So the parent correctly stays `done` while a backgrounded child runs. That is *why* the symptom
looks the way it does: the lifecycle is right and the clock is wrong.

**VERIFIED.** The one place the attribution is dropped is the journal append.
`src/main/claude/claude-structured-journal-translation.ts:143-145` reads `envelope.parentToolUseId`,
hands it to `subagents.observeChildActivity(...)`, and then falls straight through to
`deps.sink.appendItem(identity, body)` at `:165` — plus `:171` (child tool calls), `:183` (child
tool results) and `:195` (child reasoning) — with the attribution discarded. The journal is the only
consumer in the Claude path that cannot tell a child's row from the parent's.

### Addition: `latestPrompt` is *not* contaminated, and the reason is load-bearing

**VERIFIED.** `latestStructuredAgentSessionPrompt` (`src/shared/structured-agent-session-projection.ts:239-251`)
scans backwards for a `role === 'user'` message, which looks like the same bug as defect B. It is
not reachable: `claudeOutputEnvelope` (`claude-structured-item-translation.ts:79-87`) strips a user
envelope down to `tool_result` parts only, and `claudeMessageBody` (`:107-110`) returns `null` when
`messageBlocks` yields nothing — and `messageBlocks` (`:89-105`) keeps only `text` and `image`
parts. **No provider user frame, child or parent, ever becomes a journalled user item.** User
bubbles come from Orca's own submission rows.

Do not "fix" `latestPrompt` as part of this. It is correct for a reason, and the reason should be
stated in the PR so nobody re-derives it.

### Addition: two more consumers are contaminated today

- **VERIFIED (by code, not observed).** `activeStructuredAgentSessionToolCall`
  (`src/shared/structured-agent-session-live-turn.ts:85-97`) scans tail-first and returns the first
  `running` tool call before it reaches a turn record. Child tool calls are appended into the same
  item list. While the parent has a turn open and a backgrounded child is running, the child's tool
  call is later in sequence than the parent's turn record, so the parent row will render the
  **child's** tool name and input. Today this is masked only because
  `projectStructuredAgentSessionStatusSummary:303` computes `activeToolCall` solely when the parent
  reads `working`; it is not masked when the parent starts a new turn.
- **VERIFIED.** `hasPersistedStructuredAgentSessionTurn`
  (`src/shared/structured-agent-session-projection.ts:172-179`) accepts a child's assistant
  message as proof the *session* has a turn. Low impact, same root cause.

### Addition: the defect also re-triggers unread

**VERIFIED.** `stateStartedAt` is the acknowledgement clock, not just a display stamp.
`src/renderer/src/attention/agent-attention-acknowledgement.ts:36-38` states the invariant outright:

> Why compare stateStartedAt (not updatedAt): same-state pings must not re-trigger an ack.

and `:49` / `:53` compare `acknowledgedAt < stateStartedAt`.
`src/renderer/src/store/slices/ui/ui-slice-agent-notification-acknowledgement.ts:31` does the same.
So a re-stamped idle parent does not merely look fresh — **it goes unread again on every child
frame**, and its notification id changes with it (`:34`). The doc undersells the blast radius.

### Refuted: this is not a rule the renderer needs to own

**VERIFIED, and this reframes the whole fix.** The store's own entry builder already implements the
correct rule as its default —
`src/renderer/src/store/slices/agent-status-live-entry-builder.ts:135-141`:

```ts
const stateStartedAt =
  timing?.stateStartedAt ??
  (commandCodeNewTurn
    ? updatedAt
    : existing && existing.state === payload.state
      ? existing.stateStartedAt
      : updatedAt)
```

Strip `commandCodeNewTurn` and that is `server-ingest-structured.ts:63` verbatim — same-state keeps,
state-change restamps, **no `done` special case**. The bridge is not filling a gap. It is passing
`timing.stateStartedAt` to *override a rule the store already gets right*.

**VERIFIED via `git show c49345d3582` (#19144, 2026-09-06).** Before that commit the bridge passed
`undefined` for the whole timing argument and the builder's default applied. #19144 introduced the
override. Its actual goal is visible in the same diff: `sessionBoundary: summary.status === 'idle'`
became `sessionBoundary: false`, and `updatedAt: summary.updatedAt` + `allowOlderTimestamp: true`
were added so a restored session is stamped with host journal time instead of restore time. Those
were needed. **The `stateStartedAt` override was not**: on the first write there is no `existing`,
so the builder's default already yields `stateStartedAt = summary.updatedAt`, which is exactly what
the restore assertion wants. The override exists solely to make the *second* assertion pass — the
one that advances an idle row.

## Architecture challenge

### The failure mechanism, stated plainly

> A structured session's journal is an unattributed append log shared by the session's agent and
> every descendant it spawns, and every recency and prose field on the session's status row is
> derived by scanning that log. Because no row records who produced it, no scan can distinguish the
> parent's own work from its children's. `lastActivityAt` is the degenerate case: a scan over all
> rows.

Everything else follows. The renderer's `!== 'done'` clause is a *symptom of that*: the bridge had
no turn boundary available, so it approximated "a new turn settled" with "the journal clock moved" —
and in a journal where a child's work moves that clock, the approximation is unsound by
construction.

### Is "attribute at the producer + one writer" right? Partly. Two things are conflated.

The doc's phrase bundles two independent changes with different justifications. I accept one and
substantially restate the other.

**Attribute at the producer: yes, and it is the only option that removes the mechanism.** I
considered three alternatives and rejected two:

- *Smallest (S): delete the bridge's `stateStartedAt` override; one line.* **VERIFIED** that this
  alone fixes the reported symptom — with the override gone, the builder sees `'done' === 'done'`
  and keeps the existing stamp, and `lastEnteredDoneAt` reads the real completion. But it leaves
  `summary.updatedAt` contaminated, so the row's `updatedAt` and `evidenceObservedAt` still advance,
  main's canonical row's `receivedAt`/`evidenceObservedAt` still advance (`server-ingest-structured.ts:61-62`),
  `worktree ps` and mobile still report the parent as freshly updated, the feed still re-broadcasts
  the entire summary to every remote subscriber per child frame, and defect B is untouched. **This
  is a guard, not a fix.**
- *Turn-clock (T): publish the turn record's own `completedAt` in the summary and stamp the done row
  from it.* This is exact for defect A, and cheap, because turns are already root-only
  (`claude-turn-opening.ts:91`). **Rejected**: it adds a second recency concept beside `updatedAt`
  rather than making `updatedAt` correct, it fixes nothing for defect B or the tool-call scan, and
  it is precisely the shape the repo's own guidance calls a second guard. It is also unnecessary —
  attribution yields it for free, since the parent's last root row *is* its turn record.
- *Producer attribution (P): rows carry who produced them; root-only scans.* **Accepted.** It makes
  all three layers in the table above true at once, and it fixes the two contaminated consumers the
  doc had not found.

There is a decisive in-repo argument for P that outweighs the reference findings: the Claude
producer already computes root-ness and already enforces it in five places. P does not introduce a
concept. **P propagates a concept the codebase already has into the one component that lost it.**
And the plumbing is already modelled: `recovered?: true` is an optional `JournalRowBase` flag
(`journal-row-schema.ts:30`) carried through the reducer (`journal-reducer.ts:78`) onto
`AgentJournalRenderItem` (`agent-session-journal-types.ts:249`) and onto the wire schema
(`agent-session-journal-schemas.ts:223`). P is the same move, field-for-field.

**"One writer": restate it as "one rule".** Consolidating *writers* is PR 2 and is out of this
slice. But nothing about the slice requires the renderer to carry a second *rule*. Deleting
`timing.stateStartedAt` from the bridge does not remove the bridge, does not remove a publication
filter, and does not create a second writer. It removes a duplicated, divergent rule and leaves the
builder's single one — which already matches the canonical writer verbatim.

### Does my proposal remove the mechanism or add a guard beside one?

**It removes it, and it removes an existing guard rather than adding one.** P deletes the premise
that any row is the parent's activity. The bridge change deletes a rule rather than adding one; the
file ends up with *fewer* conditionals than today, and the code path converges on
`server-ingest-structured.ts:63` instead of diverging from it.

Honest qualification: P is not a type-level impossibility proof. A future producer that appends a
child row and forgets to attribute it re-opens the hole. The references make a second writer
*impossible*; this makes an unattributed row *possible but wrong*. The mitigation is a
producer-boundary unit test plus a single attribution helper, not a type. **Disclose that as a
material deviation** — do not claim the references' guarantee.

## The tension with the slice boundary, resolved without papering over it

`docs/reference/agent-status-store.md:5-8` says: *"Do not remove the renderer bridge or its
publication filters in this slice: they still carry native-chat child rows."* `:184-187` says
forwarding structured rows from main *"would give one pane key two writers"* and that removing the
filter is step one of PR 2. `:58-59` says precedence is decided once at write time and readers never
re-adjudicate.

These are not actually in conflict, and the reason is worth stating precisely:

> **The slice boundary protects the writer, not the rule.** It exists because two *transports*
> delivering the same pane key would race. A rule is not a transport. The bridge can remain the sole
> writer of structured pane keys — as the boundary requires — while owning zero write-time policy,
> because the policy already lives one layer down in the store's entry builder, which every writer
> shares.

So the honest sequencing is:

1. **This slice.** Journal rows carry producer attribution; root-only derivation in the host
   projection; the bridge stops passing `stateStartedAt`. The bridge stays. The publication filters
   stay. `agent-status-store.md:5-8` is respected literally, and `:58-59` becomes *more* true than
   it is today, because after this the structured path has exactly one `stateStartedAt` rule instead
   of two.
2. **PR 2, unchanged and unblocked.** Remove the publication filter, forward structured rows from
   main, delete the bridge's write path. Because this slice already made the two rules identical,
   PR 2 becomes a pure transport change with no behavioural delta on this field — which is a
   strictly easier PR to review than it is today.

What I will **not** claim: that this slice satisfies the store doc's rule. It does not. A renderer
component still writes a status row. This slice removes the renderer's *policy*, which is the half
available without breaking the boundary. State that in the PR body in exactly those terms.

## The pinned test

`src/renderer/src/components/native-chat/StructuredAgentSessionStatusBridge.test.tsx:446-478`,
`'sorts restored %s completions by host time and advances identical turns'` (claude and codex).
**VERIFIED**: the whole file's 18 tests pass at `origin/main`.

The test does two separable things:

- **`:455-468` — keep verbatim.** First snapshot of a restored idle session asserts
  `stateStartedAt === now - 100` and `updatedAt === now - 100`. This is #19144's real fix (host
  journal time, not restore time) and it survives the change: with no `existing` row, the builder
  falls to `: updatedAt` at `agent-status-live-entry-builder.ts:141`. **VERIFIED by reading the
  builder**; pin it with an added assertion that `allowOlderTimestamp` still admits the older stamp.
- **`:469-477` — must be inverted.** It asserts a second idle summary at `now - 50` moves
  `stateStartedAt` to `now - 50` and that `resolveAttention` therefore reports
  `attentionTimestamp: now - 50`. That is the defect, asserted as intent.

**Split the test into two, and invert the second.** Do not quietly edit it in place: the name
"advances identical turns" is the design claim being retracted, and it should disappear from the
suite by name.

Why inverting is correct, not merely convenient — three independent grounds, all verified:

1. **It contradicts the canonical writer.** `server-ingest-structured.ts:63` holds the stamp for the
   same state. Main's row and the renderer's row describe the same session and would disagree; the
   only thing stopping a user from seeing both is a publication filter that PR 2 removes.
2. **It contradicts a documented invariant in the field's own module.**
   `src/shared/agent-completion-time.ts:32` describes `stateStartedAt` as *"unmoved by same-state
   tool/prompt pings"*. The test asserts it moves on one.
3. **It contradicts the acknowledgement contract.**
   `src/renderer/src/attention/agent-attention-acknowledgement.ts:36-38` states that comparing
   `stateStartedAt` rather than `updatedAt` is what stops same-state pings re-triggering an ack. The
   test's own final assertion — `attentionTimestamp: now - 50` — *is* a same-state ping re-triggering
   attention. The test asserts the bug that the acknowledgement module's comment says cannot happen.

What the test was protecting is real and must not be dropped: two completions in a row, where the
renderer never observed the intervening `working`, must not leave the row frozen on the first. Cover
that directly instead of by proxy, with a test that drives `idle → working → idle` and asserts the
second completion restamps. **VERIFIED by code reading (UNVERIFIED by execution)** that this path
works: the status flip is a `summariesEqual` difference on `a.status`
(`structured-agent-session-status-feed.ts:64`), not on `updatedAt`, so it is never coalesced away;
and `hasUnansweredStructuredAgentSessionDispatch` (`structured-agent-session-projection.ts:192-204`)
makes the session read `working` from the durable submission row, before the provider replies at
all. A turn cannot be invisible to a mounted bridge. Write the test; do not assume it.

## What this does to defects B and C — honestly

**Defect B (a parent row showing its child's text): the same mechanism fixes it. VERIFIED.**
`latestStructuredAgentSessionAssistantMessage` (`structured-agent-session-projection.ts:253-268`)
scans backwards for the newest assistant prose and stops at a user boundary. Child assistant
messages are appended as ordinary `message`/`assistant` items
(`claude-structured-journal-translation.ts:165`), and **VERIFIED above** that no user-role item is
ever journalled from a provider frame, so the user boundary that would have stopped the scan does
not exist inside a child's output. Once rows carry a producer, one added predicate in that loop
fixes B, and the identical predicate in `activeStructuredAgentSessionToolCall` fixes the third
contamination the doc had not found. **A and B genuinely share one mechanism, and so does a third
defect nobody filed.**

**Defect C (a working child row showing its spawn time): my fix does NOT resolve it, and I will not
claim it does.** C is not contamination of the parent by a child; it is a question about what a
child's own clock should mean. Producer attribution says nothing about it. Three separate findings:

- **VERIFIED.** For a `working` row, `getCompactAgentTime`
  (`worktree-card-compact-agent-row.ts:64-65`) shows time since `startedAt`. It does this for parent
  rows too — where `startedAt` is the turn start. A working child showing time-since-spawn is
  therefore *the same rule the parent row uses*, applied consistently. It is not obviously wrong.
- **VERIFIED.** What made it *look* wrong is defect A. The reported screen was an idle parent
  reading "now" beside a live child reading "14m". Fix A and the same two values read coherently:
  the parent finished 14m ago, the child has been working 14m. **The reported appearance of C is an
  artifact of A.** Say this in the PR rather than shipping a display change to chase it.
- **VERIFIED, and this is the real C.** A *re-invoked* child keeps its first spawn stamp.
  `claude-subagent-roster-state.ts:50-53` resets `state` to `working` and clears `settledAt` on a new
  invocation but never touches `entry.startedAt`; `claude-subagent-roster.ts:255-292` (`revise`)
  likewise never writes it. `claude-background-task-tracker.ts:245` latches the same way
  (`startedAt: existing?.startedAt ?? this.now()`). So a child resumed after 40 minutes renders
  "40m" while its current invocation is seconds old. That is a genuine defect with a bounded fix —
  stamp `startedAt` on each new invocation — and it belongs in its own change, with its own
  evidence, because the doc records that the references **diverge** on the child clock and precedent
  cannot decide it.

**Summary, stated the way the review asked for it:** one mechanism resolves A, B, and an unfiled
third defect. It does not resolve C. C is two things: an appearance caused by A (resolved for free)
and a separate latch bug in the roster (not resolved; file it).

## Implementation plan

Five commits, each independently revertable. Steps 1-3 are one PR; steps 4-5 are separate.

### Step 1 — carry the producer on a journal row

Mirror `recovered` exactly; it is the established pattern for an optional row flag in these files.

1. `src/main/native-chat/agent-session-journal/journal-row-schema.ts` — add to `JournalRowBase`:
   `/** Set when a descendant agent, not this session's own agent, produced the row. */
   producer?: string`. Validate in `isJournalRow` as
   `(record.producer === undefined || typeof record.producer === 'string')` — a type check, never an
   enum check, per the file's own convention at `:172-177`. **Do not bump
   `AGENT_SESSION_JOURNAL_SCHEMA_VERSION`** (currently `3`,
   `src/shared/agent-session-journal-types.ts:20`): bumping makes every new row `unreadable: true`
   to an older build (`journal-row-schema.ts:149-151`), which degrades a whole live journal to
   read-only. An additive optional field that an older build ignores is the compatible move.
2. `src/main/native-chat/agent-session-journal/journal-row-builders.ts` — thread `producer` through
   `journalItemRowBuilder` options and `buildJournalItemRow`, beside `recovered`.
3. `src/main/native-chat/agent-session-wire/structured-agent-session-event-sink.ts` — add
   `producer?: string` to `StructuredAgentSessionAppendOptions`; pass it through the queue to
   `journal.appendItem` at the three call sites (`:185`, `:199`, `:220`).
4. `src/shared/agent-session-journal-types.ts` — add `producer?: string` to
   `AgentJournalRenderItem`, beside `recovered` at `:248-249`.
5. `src/shared/agent-session-journal-schemas.ts` — add `producer: z.string().optional()` to
   `AgentJournalRenderItemSchema` (`:217-224`). Safe under
   `docs/reference/remote-wire-compatibility.md` rule 1: a new optional field, and the schema is a
   plain `z.object`, so an older client strips it rather than rejecting the item. **Do not** make it
   `.strict()`.
6. `src/main/native-chat/agent-session-journal/journal-reducer.ts` — carry it onto the render item
   at `:77-83` and `:95-104`, as `recovered` is carried.

### Step 2 — attribute at the two producers, and gate the clock

1. `src/main/claude/claude-structured-journal-translation.ts` — compute the attribution once at
   `:143` (`const producer = envelope.parentToolUseId ? 'child-agent' : undefined`, or the canonical
   subagent id from `ClaudeSubagentIds.canonical` if a stable child identity is wanted) and pass it
   in the append options at `:165`, `:171`, `:183`, and `:195`. Reuse
   `isRootClaudeFrame` from `claude-turn-opening.ts:58` rather than re-testing the field, so the
   journal and the turn opener cannot drift apart.
2. `src/main/claude/claude-subagent-roster.ts:383` — mark the spawn-group row child-produced. **This
   is easy to miss and it defeats the whole fix if missed**: the roster row is appended in the
   parent's context with no `parent_tool_use_id` anywhere near it, yet its content is entirely
   derived from child state, and it is rewritten on every child transition. Untreated, it keeps
   bumping `lastActivityAt` and the symptom survives. It is also the rollup row, and per the
   reference convergence a rollup may carry status or a count but must never move a timestamp.
3. `src/main/native-chat/agent-session-journal/journal-reducer.ts:69` — advance `lastActivityAt`
   only when `row.producer === undefined`. An unknown future `producer` value therefore excludes the
   row, which is the fail-safe direction.
4. Leave `structured-agent-session-status-feed.ts:68` alone. Its comment becomes true once the clock
   is root-only; changing it would be the second guard.

### Step 3 — root-only derivation and one `stateStartedAt` rule

1. `src/shared/structured-agent-session-projection.ts` — skip `item.producer !== undefined` in
   `latestStructuredAgentSessionAssistantMessage` (`:253-268`). Leave
   `latestStructuredAgentSessionPrompt` alone and add a one-line comment recording *why* it is
   already safe (no provider user frame is ever journalled as a user item — see the verification
   above), so the next reader does not "fix" it.
2. `src/shared/structured-agent-session-live-turn.ts:85-97` — same predicate in
   `activeStructuredAgentSessionToolCall`, so a parent's row cannot render a child's running tool.
3. `src/shared/structured-agent-session-projection.ts:172-179` — same predicate in
   `hasPersistedStructuredAgentSessionTurn`.
4. `src/renderer/src/components/native-chat/StructuredAgentSessionStatusBridge.tsx:193-196` —
   **delete the `stateStartedAt` property**. Keep `updatedAt`, `allowOlderTimestamp: true`, and
   `evidenceObservedAt`. Replace the deleted lines with one comment naming the owner: the store's
   entry builder holds the only same-state rule, matching the canonical main-process writer.

### Step 4 (separate PR) — the re-invoked child's clock (defect C)

`claude-subagent-roster-state.ts:50-53` and `claude-background-task-tracker.ts:245` — stamp
`startedAt` when a new invocation reopens a settled entry. Needs its own evidence, and per
`docs/reference/agent-pty-transcript-capture.md` a captured resume transcript, not a remembered one.

### Step 5 (PR 2, already planned) — remove the second writer

Unblocked and simplified by step 3: the two rules are identical by then, so removing the publication
filter and forwarding from main is a pure transport change on this field.

### Tests to add

| File | Test |
| --- | --- |
| `journal-reducer.test.ts` | a `producer`-marked row advances `lastSequence` but **not** `lastActivityAt`; an unmarked row advances both |
| `journal-row-schema.test.ts` | `producer` round-trips; a row **without** it parses `ok: true` (old journals); an unknown `producer` value parses rather than going `unreadable` |
| `claude-structured-journal-translation-subagents.test.ts` | a frame with `parent_tool_use_id` journals its item with `producer` set; a root frame does not |
| new, or `claude-subagent-roster.test.ts` | the spawn-group row is appended `producer`-marked |
| `structured-agent-session-projection.test.ts` | with a child assistant message newest, `lastAssistantMessage` is the **parent's** last prose; `latestPrompt` unchanged |
| `structured-agent-session-live-turn.test.ts` | a child's `running` tool call is not returned as the parent's active tool |
| `structured-agent-session-status-feed.test.ts` | **the end-to-end guard.** Idle parent + N child frames ⇒ `summary.updatedAt` constant and **no republish** (assert the subscriber emit count, which also pins the remote-broadcast regression) |
| `StructuredAgentSessionStatusBridge.test.tsx` | split `:446-478`: keep the restore assertion; replace "advances identical turns" with *"holds an idle row's stamp when the host clock advances"*; add `idle → working → idle` restamps |

**Ablation discipline.** Every one of these must be shown red against `origin/main` before the fix
lands, individually. The feed test is the one that proves the mechanism rather than the symptom: it
measures publish count, so it fails on the contaminated clock even if a downstream consumer is
changed to compensate.

### Verification

`pnpm tc`, then `pnpm test` on each touched file, then `pnpm run check:code-quality:changed` and
`oxlint`. Running tests rewrites `pnpm-lock.yaml`; restore with `git checkout -- pnpm-lock.yaml`,
that file only.

### Risks

1. **The roster group row (step 2.2) is the one that silently defeats the fix.** It carries no
   `parent_tool_use_id` and is appended from parent context. If a reviewer sees only the
   `parent_tool_use_id` sites, the symptom survives and the PR looks correct. Ship the feed-level
   publish-count test specifically to catch this.
2. **Codex and other structured providers are untouched.** **VERIFIED** that only the Claude
   translator is being attributed. Another provider that journals child output will still
   contaminate, with no new guard against it. Disclose this as a known gap; do not describe the fix
   as provider-independent.
3. **Attribution is a convention, not a type.** A new append site that omits `producer` re-opens the
   hole. Mitigate with a single shared helper at the Claude producer boundary and a producer-level
   unit test; **disclose** that the references make a second writer structurally impossible and this
   change does not. Do not write "follows precedent" about the impossibility half.
4. **Schema-version discipline.** Bumping `AGENT_SESSION_JOURNAL_SCHEMA_VERSION` for this would
   make every new row unreadable to older builds and force a live journal read-only. The additive
   field is deliberate; put the reason in the commit message so a later reviewer does not "tidy" it
   into a version bump.
5. **An idle parent's row now genuinely goes quiet while a child works.** That is the intended
   behaviour and it is also a visible change: liveness must come from the subagent rollup
   (`backgroundTasks` / `subagents` on the summary), which the bridge already projects at
   `StructuredAgentSessionStatusBridge.tsx:103-143`. **UNVERIFIED** whether the sidebar's parent row
   surfaces a child-working affordance strongly enough on its own; check this in `$electron` before
   merging, because "the parent went quiet" is the thing a user would report next.
6. **Journals written before this change carry no attribution.** Replayed child rows will still be
   read as the parent's. This is a forward-only fix and it self-heals on the next turn. Say so;
   do not backfill.

