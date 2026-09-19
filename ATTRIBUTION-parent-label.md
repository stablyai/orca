# Defect B — a parent row displays its child's text

Base: `779667c1e7` (origin/main at time of writing).
Status: **diagnosis complete, mechanism NOT chosen.** Do not pick a fix before reading
"Constraints" and the reference findings that will be appended to this file.

## Observed

A structured agent session (native chat) ran a subagent. The **parent** sidebar row displayed text
that the **subagent** had written. The parent itself had produced nothing since launching the child.

## Verified mechanism

Read directly at `779667c1e7`:

1. `src/main/claude/claude-structured-journal-translation.ts:142-144`
   ```ts
   if (envelope.parentToolUseId) {
     subagents.observeChildActivity(envelope.parentToolUseId)
   }
   ```
   A frame belonging to a **child** is noted and then **falls through** — no early return, and no
   producer tag is attached to the item that is subsequently appended. The child's assistant prose
   is appended to the *parent's* journal, indistinguishable from the parent's own output.

2. `src/shared/structured-agent-session-projection.ts:253-269`
   ```ts
   export function latestStructuredAgentSessionAssistantMessage(
     items: readonly AgentJournalRenderItem[]
   ): string {
     for (let index = items.length - 1; index >= 0; index -= 1) {
       const body = items[index]?.body
       if (body?.kind === 'message' && body.role === 'user') {
         return ''
       }
       if (body?.kind === 'message' && body.role === 'assistant') {
   ```
   Scans **all** items backwards, stopping only at a user-role message. There is **no filter on
   which agent produced the item**, so the newest assistant prose may be the child's.

   Note the function's own docstring says *"The newest assistant prose in the latest user turn."*
   The code has no such scoping. **Comment and implementation disagree about what "assistant"
   means** — that gap is the defect.

3. That value becomes the row's `lastAssistantMessage` and is rendered as the row's secondary line.
   Confirmed present as a live field: `orca worktree ps --json` returns `lastAssistantMessage` on
   183 of the agent rows on this machine.

## Reported but NOT personally verified

From a code map; confirm before relying on any of it:

- `src/shared/structured-agent-session-live-turn.ts:81-95` — `activeStructuredAgentSessionToolCall`
  reportedly scans backwards for the newest running `tool-call`, also without a parentage filter,
  so a **child's** running tool can be shown on the **parent** row (`toolName` / `toolInput`).
- `src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx:43-51` — reported render
  site for the secondary line.

## Constraints — read before proposing anything

- `docs/reference/agent-status-store.md:55-62`: readers keep **only** presentation policy;
  precedence is decided once, at write time.
- `docs/reference/agent-status-store.md:5-8`: do **not** remove the renderer bridge or its
  publication filters in this slice — they still carry native-chat child rows.
- **Test gap, not test coverage:** no test in
  `src/shared/structured-agent-session-projection.test.ts` feeds subagent-parented items into
  `projectStructuredAgentSessionStatusSummary`; every case there uses a single flat conversation.
  So this leak is untested in both directions. A regression test is part of the fix.

## Design question this defect raises

Is the right fix to **filter at the reader** (projection skips child-produced items), or to
**attribute at the producer** (journal items carry the producing agent, and every projection is
scoped by it)? The second is the larger change and likely also resolves defects A and C.

Do not assume. The reference research appended to this file should decide it — and note that a
reader-side filter would be the second reader-side policy in a subsystem whose own documentation
says readers should hold none.

## Your task

1. Re-baseline against current `origin/main`; this file may be stale.
2. Confirm or refute the above **at source**. Do not trust this document.
3. Propose a mechanism. Prefer fixing the architecture over adding a guard. State plainly whether
   your fix removes the bug class or just this instance.
4. State what the fix does to defects A (`attr-parent-recency`) and C (`attr-child-clock`).
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

# Review and mechanism decision (second pass)

Re-verified at source in this worktree. Every claim below is marked **VERIFIED** (I read the
cited line myself, in this worktree, at the head recorded under "Re-baseline") or **UNVERIFIED**.

## Re-baseline

**VERIFIED.** `git fetch origin main` moved `origin/main` from `779667c1e7` (the base this
document was written against) to `25dd70e6118b152cd87c9786cfb54e321bfe13c9`. That is **one**
commit: `25dd70e611 Test: target question card title by testid instead of text (#21153)`,
touching four files — `NativeChatQuestionCard.tsx`, `browser-history-match-budget.ts`,
`browser-history-match.performance.test.ts`, `native-chat-ask-user-question-card.spec.ts`.

**No drift.** `git diff --stat 779667c1e7..origin/main` over every file this document cites
(the projection, the live-turn readers, both Claude translation modules, both journal
type/schema modules, the subagent roster, the compact agent row, `agent-status-store.md`, the
projection test) returns empty. Every line number this document quotes still says what it says.
Two corrections to line numbers are noted inline below; neither is drift, both were slightly off
when written.

## Section 1 — the two items the document marked NOT personally verified

### `activeStructuredAgentSessionToolCall` — **VERIFIED, and the reported line range was off by four**

`src/shared/structured-agent-session-live-turn.ts:85-98` (the document said 81-95; 82-84 is the
docstring). The body is:

```ts
for (let index = items.length - 1; index >= 0; index -= 1) {
  const body = items[index]?.body
  if (readAgentJournalTurn(body)) {
    return null
  }
  if (body?.kind === 'tool-call' && body.state === 'running') {
    return body
  }
}
```

There is no parentage filter, and the scan's only terminator is a turn record. The premise the
report depended on is also **VERIFIED**: a child's tool calls really are journaled into the
parent's journal. `src/main/claude/claude-structured-journal-translation.ts:168-176` appends
every `claudeToolUses(...)` entry unconditionally — the `parentToolUseId` branch four lines
above it does not return — and `:177-192` does the same for tool results. So while a subagent
runs a tool, the newest `running` tool-call in the parent's item list is the child's, and
`projectStructuredAgentSessionStatusSummary` (`structured-agent-session-projection.ts:303-312`)
publishes it as the parent row's `toolName` / `toolInput`.

**A third reader has the same defect, not reported in the document.**
`isStructuredAgentSessionThinking` (`structured-agent-session-live-turn.ts:54-80`) decides
"thinking" from the newest content item before the turn record, with no parentage filter. A
child's `reasoning` message therefore makes the **parent's** chat show the thinking indicator.
Same mechanism, same scan shape, third instance.

### The render site — **VERIFIED, with a correction**

`src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx`. The function is
`getCompactAgentSecondary` at **:26-57** (the document said 43-51, which is the inner
`lastAssistantMessage` read only). The precedence the row actually applies:

- `:43-46` tool preview (`formatAgentToolPreview`, `src/renderer/src/lib/agent-row-tool-preview.ts:17-30`)
- `:47-51` `lastAssistantMessage`
- `:53-56` fallbacks

So the secondary line shows the **child's tool** first and the **child's prose** second. Both
leaks land on the same line, tool first. `:140` calls it; `:143-145` places it in `trailingText`
and the row `title`.

`orca worktree ps --json` returning `lastAssistantMessage` on 183 rows: **UNVERIFIED by me** — I
did not re-run it. The field is present on the wire regardless
(`src/main/agent-hooks/server/server-ingest-structured.ts:58-60`).

## Section 2 — what I verified independently that changes the analysis

1. **Orca already classifies root vs child at this exact producer, three times, and throws the
   answer away twice.** **VERIFIED.**
   - `src/main/claude/claude-turn-opening.ts:58-60` — `isRootClaudeFrame(frame)`.
   - `:91` — `createClaudeTurnOpener` refuses to open a turn for a non-root frame.
   - `:43` — the send-echo turn requires `frame.parent_tool_use_id === null`.
   - `src/main/claude/claude-streamed-block-identity.ts:31-33` — the streamed-block registry keys
     its map on `` `${sessionId}/${parentToolUseId ?? ''}` ``. It computes the discriminant at
     `:67` and does not return it.
   - `src/main/claude/claude-structured-history-window.ts:94-104` — `claudePromptBlocks` refuses a
     transcript record with `parent_tool_use_id != null` (and `isSidechain`) when deciding what
     the user's own prompt was.
   - `src/main/codex/codex-subagent-activity.ts:73-76` — `isCodexRootAgentActivity` does the same
     job on the Codex lane, from an agent **path** rather than a single parent id.

   This is the decisive fact. Producer-side parentage classification is not a new idea in this
   repo; it is established practice on both provider lanes and in the Claude transcript reader.
   The journal item is the one artifact that does not carry it.

2. **The turn boundary the scans stop at is already root-scoped.** **VERIFIED.** On the Claude
   lane a `message`/`role: 'user'` render item comes from the write-ahead submission row
   (`journal-reducer.ts:239-260`, `applySubmission` upserts the submission body as an item), and
   provider user frames journal no message body at all —
   `claudeOutputEnvelope` (`claude-structured-item-translation.ts:79-87`) filters a user
   envelope's content down to `tool_result` parts, so `claudeMessageBody` returns `null` for one.
   Turn records are likewise root-only, per `createClaudeTurnOpener` above.

   **This is what makes the defect exact rather than vague:** the window every scan reads is
   bounded by root-written markers and filled with root + child content. The window is
   *guaranteed* to contain foreign items, and during a subagent run the newest item in it is
   almost always the child's.

3. **There is no producer field anywhere.** **VERIFIED** — zero hits for
   `parentToolUseId|agentId|parentAgentId|producer|subagentId|producedBy` in
   `src/shared/agent-session-journal-schemas.ts` and `src/shared/agent-session-journal-types.ts`.
   Positive control run on the same files (`kind`: 11 and 14 hits), so the empty result is a fact
   about the files and not about my grep.

4. **`AgentJournalRenderItem` already carries exactly one optional provenance marker, and it is
   row-level, not body-level.** **VERIFIED.** `recovered?: true` is declared on
   `JournalRowBase` (`journal-row-schema.ts:20-31`), threaded through
   `JournalItemAppendOptions` (`journal-store-contracts.ts:42`), `JournalItemAppender`
   (`journal-item-appender.ts:11,21-34`) and `journalItemRowBuilder`
   (`journal-row-builders.ts:28-44`), and copied onto the render item by the reducer
   (`journal-reducer.ts:82` and `:107`). It is declared on the shared type at
   `agent-session-journal-types.ts:242-250` and admitted by
   `AgentJournalRenderItemSchema` at `agent-session-journal-schemas.ts:223`. That is a complete,
   shipped template for the field this fix needs.

5. **`projectStructuredAgentSessionStatusSummary` has exactly one production caller.**
   **VERIFIED** — `src/main/native-chat/agent-session-wire/structured-agent-session-status-feed.ts:233`.
   Blast radius of changing its contents is one host-side writer.

6. **The test gap is real.** **VERIFIED** — zero hits for `parent|subagent|child` in
   `src/shared/structured-agent-session-projection.test.ts` (24 cases, all single-agent). And
   the input fixture for the leak already exists and asserts nothing about it:
   `src/main/claude/claude-structured-journal-translation-subagents.test.ts:184-199` feeds an
   assistant frame with `parent_tool_use_id: 'toolu_1'` carrying the text `'looking'` and
   asserts only the roster row. Nothing checks where `'looking'` went.

## Section 3 — the central question

### The failure mechanism, stated plainly

One journal is the durable record of **one agent session**. It is being used as the record of
**N agents** — the session's own agent plus every subagent it spawns — with no field that says
which one wrote a row. Every "what is this agent doing" reader is a backward scan that stops at a
marker only the root agent writes. So the scans are root-scoped at their boundaries and
unscoped in their contents.

The bug class is therefore: **a shared timeline with no producer field, read by newest-item-before-the-boundary scans.** It is not one function. Three readers have it today
(`latestStructuredAgentSessionAssistantMessage`, `activeStructuredAgentSessionToolCall`,
`isStructuredAgentSessionThinking`), and any fourth reader written the same way inherits it.

### The verdict: attribute at the producer. This is not close.

**A reader-side filter is not implementable at the reader.** **VERIFIED.** An
`AgentJournalRenderItem` carries `itemId`, `revision`, `body`, `sequence`, `observedAt`,
`recovered` — and nothing else (`agent-session-journal-types.ts:242-250`). A child's items are
appended under the *parent's* identity shape (`claudeMessageIdentity` →
`{ provider: 'claude', sessionId, uuid }`) and with the *parent's* `session_id` — visible in the
existing fixture, where the child frame carries `session_id: 'claude-session'`, the same value
the parent's frames carry (`claude-structured-journal-translation-subagents.test.ts:192`
against `:64`). There is no bit anywhere in the render item to filter on.

So "filter at the reader" can only mean *infer* parentage from neighbouring items — "an item
that follows a still-`running` tool-call named `Task` belongs to a child." That option is worse
on every axis:

- It is a second reader-side adjudication rule in a subsystem whose own documentation forbids
  exactly that: `docs/reference/agent-status-store.md:58-59`, "Precedence is decided once, at
  write time, with provenance recorded on the row. Readers never re-adjudicate." **VERIFIED at
  source.** Note the wording — *provenance recorded on the row* is literally the field this fix
  adds.
- It is wrong under concurrency. Two spawns in flight, a backgrounded child still emitting after
  its spawn call returned (the backgrounded case is real and already tested —
  `claude-structured-journal-translation-subagents.test.ts` "leaves a backgrounded child running
  past the end of its turn"), or the parent producing its own prose while a child runs, all
  defeat the inference.
- It has to be written four times (projection, two live-turn readers, and mobile, which imports
  these same shared functions — `mobile/src/session/use-mobile-structured-agent-session.ts:12-13`).
- It leaves the durable record permanently ambiguous, so the next reader starts from the same
  nothing.

**Does producer attribution REMOVE the bug class or guard it?** It removes it, with one honest
qualification. It removes the *ambiguity* — after it, a reader that wants root-scoped truth can
have it, and a reader that wants the whole transcript can have that. It does not by itself stop
someone writing a fifth unscoped scan; what stops that is that the scoped predicate is the
obvious thing to reach for and lives beside the type. That is a real improvement over today,
where the correct code is impossible to write, but it is not a type-level impossibility. I am
not going to claim more than that.

### Where I argue AGAINST the producer-attribution framing as this document states it

Line 74 of this document says the producer change "is the larger change and likely also resolves
defects A and C." **That is wrong, and Section 6 below shows why.** Producer attribution
resolves B. It is a *precondition* for one plausible fix to A, whose cost is a genuine trade-off
that deserves its own decision. It does nothing at all for C. Adopting the field because it
"probably fixes three things" would be adopting it for a reason that is two-thirds false.

I also reject one shape the framing invites: stamping the **roster's** child identity on the
item. The roster already owns per-child identity, with canonical task ids and tool ids as
aliases because "Claude re-announces a resumed task under a NEW `tool_use_id`"
(`src/main/claude/claude-subagent-roster.ts:1-12`, **VERIFIED**). Duplicating that identity onto
journal rows creates a second copy that disagrees after a resume — the exact thing
`AGENTS.md`'s "prefer deriving state over storing it" warns against. The journal needs to answer
"is this mine", nothing more. See the field shape below.

## Section 4 — the field, precisely

### Declaration

On the row, beside `recovered`, in `JournalRowBase`
(`src/main/native-chat/agent-session-journal/journal-row-schema.ts:20-31`):

```ts
/** Set when a subagent running inside this session produced the row, rather than
 *  the session's own agent. Absent on every root row and on every row written
 *  before this field — so readers test presence and never read absence as unknown. */
producedBySubagent?: true
```

Mirrored onto the render item (`src/shared/agent-session-journal-types.ts`, beside `recovered`
at `:248-249`) and admitted by `AgentJournalRenderItemSchema`
(`src/shared/agent-session-journal-schemas.ts:223`) as
`producedBySubagent: z.literal(true).optional()`.

**Type: `true | undefined`. Optional. Never `false`.** Same shape as `recovered`, for the same
reason: `false` and absent would be two spellings of one fact, and the reducer's spread
(`...(row.recovered ? { recovered: row.recovered } : {})`) is the established idiom.

**Why a bare `true` and not a child id.** Readers need one bit: "is this the session's own
agent". Per-child identity already has an owner — the roster, whose ids survive resumes through
an alias map. A raw `parent_tool_use_id` on the row would be a second, alias-unaware copy, and
its presence would invite a future join to the roster that is wrong after any task resume.
Presence also generalises to Codex, where the discriminant is a path of depth ≥ 1
(`codex-subagent-activity.ts:73-76`) and a single parent id would not fit. If a per-child
transcript view is ever wanted, add a second field then, with the alias question answered.

**Why on the row and not in the body.** Three reasons, all verified:
- It is provenance of the append, not content — the same category as `recovered`, `ts` and
  `fence`, all of which live on the row.
- The body is a deep-validated discriminated union (`AgentJournalItemBodySchema`,
  `agent-session-journal-schemas.ts:153-215`) and is also the surface downgraded per client
  capability (`src/main/runtime/rpc/methods/structured-agent-session-turn-item-capability.ts`).
  A body field means touching the `message`, `tool-call`, `diff` and `status` arms — four
  places — and entangling attribution with the capability downgrade.
- `journalRowSchemaVersion()` (`agent-session-journal-types.ts:24-28`) derives the row's version
  from its **body kinds**. A row-level field leaves that function untouched, which is what keeps
  the migration free (next).

### Where it is stamped

Exactly one producer writes Claude journal items, and it already holds the answer.

1. `src/main/claude/claude-structured-journal-translation.ts`, inside `handleMessage`. The
   envelope is parsed with `parentToolUseId` already on it
   (`claude-structured-item-translation.ts:57`, **VERIFIED**). One local constant next to the
   existing `:143-145` block, passed as an append option at every `deps.sink.appendItem` in that
   function: `:165` (message body), `:171` (tool uses), `:183` (tool results), `:195`
   (reasoning), and through `appendUnmodeledContent` at `:205`.

2. **The streamed path, which is not inside `handleMessage` and is the part a naive fix misses.**
   Streamed text is persisted from a callback at `:99-106` that has no envelope. The producer is
   still available: `claude-streamed-block-identity.ts` already scopes its registry on
   `(sessionId, parentToolUseId)` at `:31-33` and computes it at `:67`. Return it on
   `ClaudeStreamedTextDelta`, thread it through `createClaudeStreamedTextCheckpoints`'s
   `append`/`persist` (`claude-streamed-text-checkpoints.ts:10,17,46-59,75-79`), and the
   checkpoint row is attributed. This is deriving, not a new store: the flag is a property of the
   block identity the registry already minted inside that scope.

3. **Lifecycle rows are root by construction** and are left unstamped. Turn records are only ever
   opened by root frames (`claude-turn-opening.ts:91`), so `tryAppendLifecycleTransition` and
   `appendLifecycleBatch` need no option. Say so in a comment rather than leaving it to be
   rediscovered.

Carrier for (1) and (2): `StructuredAgentSessionAppendOptions`
(`structured-agent-session-event-sink.ts:25-32`) gains the field and forwards it at `:179-192`
(`appendItem`) and `:193-205` (`tryAppendItem`), into `JournalItemAppendOptions`
(`journal-store-contracts.ts:42`), `JournalItemAppender` (`journal-item-appender.ts:11,21-34`)
and `journalItemRowBuilder` (`journal-row-builders.ts:28-44`) — every one of which already
carries `recovered` along the identical path.

Out for this slice: the Codex producer. The field is provider-neutral and Codex has the
discriminant (`isCodexRootAgentActivity`), but whether Codex journals child output into the
parent journal is **UNVERIFIED** and is its own investigation. Absent on Codex rows means root,
which is exactly today's behaviour there — no regression, no silent half-fix, because nothing
about the Codex lane changes.

### Rows already on disk — migration and backfill, explicitly

**There is no migration and no backfill, and both of those are decisions, not omissions.**

- **No schema version bump.** `AGENT_SESSION_JOURNAL_SCHEMA_VERSION` stays 3. This matters:
  `parseJournalRow` fails **closed** on a higher version — `if (version > AGENT_SESSION_JOURNAL_SCHEMA_VERSION) return { ok: false, unreadable: true }`
  (`journal-row-schema.ts:148-150`, **VERIFIED**) — and an unreadable row latches the host
  read-only rather than skipping. A version bump for an optional provenance flag would make
  every journal a new host touches unreadable to an older host, for a field that older host does
  not read. Not bumping is not a shortcut; it is the correct read of that gate.
- **An older host reads a new row fine.** `isJournalRow` (`journal-row-schema.ts:178-231`)
  validates `kind`, `epoch`, `seq`, `fence`, `ts`, `itemId`, `revision` and the body, and ignores
  unknown top-level keys. **VERIFIED** at the `item` arm, `:192-198`. The old host drops the flag
  and behaves exactly as it does today.
- **No upcaster.** `upcastRow` (`journal-row-schema.ts:157-166`) has no case to add. There is
  nothing to compute for an old row.
- **Old rows read as root, and that is the safe default rather than a lossy one.** Backfill is
  impossible in principle — the frame's `parent_tool_use_id` was discarded at ingestion and the
  journal is append-only by contract (`journal-row-schema.ts:1-6`). Treating an old row as root
  reproduces today's behaviour for that history **exactly**: old transcripts keep rendering as
  they render now, and only turns produced on a build that has the field are corrected. Nothing
  regresses; the fix simply takes effect going forward.
- **Old rows are the normal case, and here is the bounded consequence.** A session live across
  the upgrade has unattributed rows below attributed ones. A backward scan that reaches into the
  pre-upgrade region can still pick up a child's prose. It cannot reach far: every scan stops at
  the first turn record or user item, and the first turn opened after the upgrade is written by
  the new build. The exposure is at most one turn, for sessions open at upgrade, once. Not worth
  a repair pass; worth a line in the PR body.
- **`undefined` must never be read as "unknown".** This is the failure mode
  `docs/reference/remote-wire-compatibility.md:198-217` documents for `agentWait`, and the
  difference is worth stating rather than assuming: `agentWait` has three states because the host
  may genuinely not have evaluated a pane. Here there is exactly one producer of Claude journal
  items, it parses `parentToolUseId` on every message envelope
  (`claude-structured-item-translation.ts:57`), and it therefore always knows. Absence is a
  positive claim of root-ness, not an absence of evaluation. Write that in the field's doc
  comment so a later reader does not add an "unknown" arm.

## Section 5 — wire compatibility (mandatory)

Read `docs/reference/remote-wire-compatibility.md` in full. Three distinct changes, three
categories:

**(a) `producedBySubagent` on the persisted journal row — not a protocol surface.** Covered
above: no `v` bump, `isJournalRow` ignores unknown keys, old hosts degrade to today's behaviour.

**(b) `producedBySubagent` on `AgentJournalRenderItem`, which crosses `agentSession.history` and
`agentSession.subscribe` — Rule 1** (`remote-wire-compatibility.md:12-29`), a new optional JSON
field on an existing frame. Safe, with the Rule 1 condition met explicitly: **no reader may ever
require it.** A new client against an old host receives items with no flag and must render
exactly today's behaviour — which it does, because the shared predicate reads absence as root.
Confirmed non-hostile decoding: `AgentJournalRenderItemSchema` is a non-strict `z.object` used
only through `safeParse(...).success` as a type guard
(`agent-session-journal-schemas.ts:217-224, 249-253`), so an unknown key neither fails validation
nor is stripped from the object the caller keeps; and the schemas file's own header
(`:11-14`) states that unknown object keys pass by design. **VERIFIED.**

**(c) What the host publishes in `AgentSessionStatusSummary` — Rule 3**
(`remote-wire-compatibility.md:61-76`). The frame shape does not move, but the *content* of
`lastAssistantMessage`, `toolName` and `toolInput` changes for the duration of a subagent run.
This is the category that is easy to get wrong, so the argument in full:

- Rule 3's test is whether old clients can interpret the new projection correctly. They can: the
  same fields carry the same kind of value, with the same units and nullability. Only the
  attribution is corrected.
- No old client requires them. `getCompactAgentSecondary`
  (`worktree-card-compact-agent-row.tsx:26-57`) falls through tool preview →
  `lastAssistantMessage` → agent-type label, and `formatAgentToolPreview`
  (`agent-row-tool-preview.ts:17-30`) returns `''` on empty input. **VERIFIED.**
- The row does not go blank during a subagent run. With child items excluded, the newest running
  tool-call is the spawn call itself, so `toolName` stays populated (`Task`, with the spawn
  description as `toolInput`). The row gets *more* accurate, not emptier.
- **No capability gate, and that is a deliberate refusal.** Gating this would mean deliberately
  continuing to serve old clients the child's text as the parent's — preserving the defect for
  them by design. A gate is the right tool when an old client would *misread* new content
  (as with the `turn` item at `remote-wire-compatibility.md:219-244`). It is the wrong tool when
  the old client reads the field correctly and the field was simply wrong.
- `orca worktree ps --json` and mobile read the same summary through the same store
  (`agent-status-store.md:47-51`), so all surfaces change together. No reader-side divergence is
  introduced, which is the property `agent-status-store.md:55-62` asks for.

**Not in scope, and flagged because it IS a Rule 3 change with teeth:** any change to what
`summary.updatedAt` is derived from. See Section 6, defect A.

**Harness note.** `tests/e2e/cross-version-wire/cross-version-agent-session-wire.unit.test.ts`
covers this surface. Adding an optional field keeps it green (Rule 1). Do **not** add an
assertion of the form "the old side lacks `producedBySubagent`" — the baseline is a rolling
release tag and `remote-wire-compatibility.md:136-159` explains why such an expectation reddens
unrelated PRs the first time a release ships the field.

## Section 6 — the docstring, and the two other defects

### The docstring: intent is right, the code is the bug — but the docstring hid it

`latestStructuredAgentSessionAssistantMessage`'s comment
(`structured-agent-session-projection.ts:251-252`) reads *"The newest assistant prose in the
latest user turn."*

The turn-scoping claim is **not** the gap the document supposed. **VERIFIED:** on the Claude
lane the `role === 'user'` terminator *is* the latest user turn's boundary, because user render
items come from the write-ahead submission row (`journal-reducer.ts:239-260`) and provider user
frames journal no message body (`claude-structured-item-translation.ts:79-87`). Scanning back to
the newest user item and scanning back to the start of the latest user turn are the same scan.

**So the code implements the docstring, and both are wrong in the same place.** The word doing
the lying is *"assistant"*. In a single-agent conversation it means "the session's agent". In a
session with subagents it silently means "any agent". The docstring is correct about the window
and silent about the producer, which is exactly why the defect survived review.

**Decision:** the intent is right — the sidebar wants the session's own agent's latest line.
Implement the producer scoping, and rewrite the comment to say *whose* prose, because leaving
"assistant" unqualified is what let the code and the comment agree while both were wrong. A
comment that both parties read as correct is not corroboration.

### Defect A — idle parent stamped "now"

**What the field does for A: it makes A fixable in one place. It does not fix A.** Mark the
following mechanism **VERIFIED as a code path** and **UNVERIFIED as the cause of the reported
symptom** — I have not seen defect A's own document or a repro, and I did not reproduce it.

- `journal-reducer.ts:69` — `state.lastActivityAt = Math.max(state.lastActivityAt, row.ts)`,
  applied to **every** row, child rows included.
- `structured-agent-session-status-feed.ts:264` — `updatedAt: journal.lastActivityAt() || now()`.
- `:68` in `summariesEqual` — `(a.status !== 'idle' || a.updatedAt === b.updatedAt)`, so while a
  session reads idle, a bare `updatedAt` move is significant and forces a republish.
- `server-ingest-structured.ts:62` — `evidenceObservedAt: summary.updatedAt`.

So a backgrounded child emitting after its parent's turn settled advances the idle parent's
recency clock. That is one honest mechanism for "idle parent stamped now".

Note what is **not** broken: `server-ingest-structured.ts:63` reads
`stateStartedAt: priorStatus?.state === state ? priorStatus.stateStartedAt : summary.updatedAt`
— the state-entry stamp **is** preserved across same-state updates, with no done-state special
case. **VERIFIED**, and this is the line the reference section describes (it cited `:65`; the
actual line is `:63` — a two-line correction, not drift). Whatever A turns out to be, it is not
this line.

**Why A is a separate decision.** Excluding child rows from `lastActivityAt` has a real cost:
that value is the journal's general recency and feeds the 30-minute display decay and
`worktree ps` freshness. A parent whose only live work is a backgrounded child would then decay
to stale while the child genuinely runs — trading a false "active" for a false "stale". That is a
product judgement about which lie is worse, and it should be made in A's own change with its own
evidence, not carried along by B.

### Defect C — working child showing spawn time

**The field does nothing for C. Nothing.** **VERIFIED:** the child row's clock never touches a
journal item. `src/renderer/src/components/sidebar/worktree-subagent-child-rows.ts:41` sets
`startedAt` from the roster's `subagent.startedAt` (the spawn stamp), falling back to the
parent's `stateStartedAt`; `worktree-card-compact-agent-row.tsx:59-66` renders it through
`formatShortTimeAgo` for any row that is not `done`. Roster entry to render, no projection in
between.

The reference section already records that the three implementations reviewed **diverge** on the
child clock, so C has several legitimate answers and none of them is settled by precedent. C
needs its own decision with its own stated reasons.

### The honest answer to "does one mechanism cover all three"

**No.** One mechanism covers **one** defect completely (B, in three readers), is a
**precondition** for one plausible fix to a second (A) whose cost is a genuine trade-off, and is
**irrelevant** to the third (C). The current document's line 74 — "likely also resolves defects A
and C" — should be struck.

## Section 7 — regression tests

No test today feeds subagent-parented items into the projection. Below is what to add. **Every
one of these must be shown to fail with the stamping removed** — a test that passes against
`main` pins nothing, and a scan asserting "no leak" is a claim about the instrument until a
positive control proves the instrument fires.

**Producer side** — `src/main/claude/claude-structured-journal-translation-subagents.test.ts`.
The harness at `:20-54` records `{ identity, body }` per `appendItem` and **discards the third
argument**. It must capture options first, or every producer assertion below silently passes on
`undefined`.

1. A frame with `parent_tool_use_id` set stamps `producedBySubagent` on its message item, its
   tool-use items and its tool-result items. Extend the existing case at `:184-199`, which
   already feeds exactly this frame and asserts only the roster.
2. A root frame (`parent_tool_use_id: null`) stamps **nothing** — the positive/negative pair.
   Without this, an implementation that stamps every row passes test 1.
3. The **streamed** path: `stream_event` deltas under a `parent_tool_use_id` scope produce a
   checkpoint row carrying the flag; root deltas do not. This is the case a `handleMessage`-only
   fix fails, and it is the single most valuable test here.
4. Lifecycle/turn rows carry no flag (pins the "root by construction" claim).

**Journal round-trip** — `src/main/native-chat/agent-session-journal/journal-reducer.test.ts`.

5. A row with the flag reduces to a render item with it; a row without reduces to an item
   without. Both upsert paths — the plain `item` row (`journal-reducer.ts:76-83`) and the
   `lifecycle-batch` path (`:101-108`) — because they are two separate spreads.
6. **The old-row case, which is the normal case.** A journal whose rows predate the field
   (no key at all) parses, reduces, and reads as all-root. Assert against `parseJournalRow` with
   a literal legacy line, not a constructed row, so it also pins that `isJournalRow` does not
   reject an unknown key and that no version bump crept in.

**Reader side** — `src/shared/structured-agent-session-projection.test.ts` and
`src/shared/structured-agent-session-live-turn.test.ts`. Both directions, as asked:

7. *Child text is not leaked to the parent.* Items: root user submission → root assistant prose
   `"delegating"` → root `Task` tool-call `running` → child assistant prose `"looking"` (flagged)
   → child `Grep` tool-call `running` (flagged). Assert
   `latestStructuredAgentSessionAssistantMessage` returns `"delegating"`, not `"looking"`; and
   `activeStructuredAgentSessionToolCall` returns the `Task` call, not `Grep`. Assert both on the
   summary too, through `projectStructuredAgentSessionStatusSummary` — the field names the
   sidebar actually reads.
8. *Parent text is not leaked to the child, and the child's output is not deleted.* There is no
   per-child projection today — child rows come from the roster — so the meaningful second
   direction is that scoping the status readers does **not** scope the transcript.
   `projectStructuredItemsToNativeChat` over the same item list must still return the child's
   `"looking"` message. A fix that filters at the wrong level deletes subagent output from the
   chat, and only this test catches it.
9. *Same-shaped case for the thinking indicator.* A child `reasoning` item after a root
   `Task` call must not make `isStructuredAgentSessionThinking` true.
10. *The mixed-generation case.* Root items, then **unflagged** child items (as a pre-upgrade
    journal has), then flagged ones. Pins the documented behaviour — old rows read as root — so a
    later change cannot quietly convert absence into "unknown".

**Not a test, a check:** confirm no mobile RPC golden recording contains journal render items
before landing. `mobile/src/test-support/rpc-recording/` shows no `agentSession.*` family, so the
risk looks nil, but an added field on a recorded payload forces a re-record with a `baseline`
bump and it is cheap to confirm.

## Section 8 — implementation plan

Executable in this order. Each step compiles on its own; behaviour changes only at step 11.

| # | File | Change |
|---|---|---|
| 1 | `src/shared/agent-session-journal-types.ts` | `producedBySubagent?: true` on `AgentJournalRenderItem`, beside `recovered` (`:248-249`), with the doc comment from Section 4 |
| 2 | `src/shared/agent-session-journal-schemas.ts` | `producedBySubagent: z.literal(true).optional()` in `AgentJournalRenderItemSchema` (`:217-224`) |
| 3 | `src/shared/agent-session-journal-producer.ts` *(new)* | `isRootAgentJournalItem(item)` — one predicate, the only place absence is interpreted |
| 4 | `.../agent-session-journal/journal-row-schema.ts` | field on `JournalRowBase` (`:20-31`); comment recording that `v` is deliberately not bumped and why |
| 5 | `.../journal-store-contracts.ts`, `journal-item-appender.ts`, `journal-row-builders.ts` | thread the option exactly where `recovered` is threaded |
| 6 | `.../journal-reducer.ts` | copy onto the render item at `:76-83` and `:101-108`, mirroring `recovered` |
| 7 | `.../agent-session-wire/structured-agent-session-event-sink.ts` | field on `StructuredAgentSessionAppendOptions` (`:25-32`); forward in `appendItem` (`:179-192`) and `tryAppendItem` (`:193-205`); comment that lifecycle appends are root by construction |
| 8 | `src/main/claude/claude-streamed-block-identity.ts` | return the parentage it already computes at `:67` on `ClaudeStreamedTextDelta` |
| 9 | `src/main/claude/claude-streamed-text-checkpoints.ts` | carry it from `append` to `persist` |
| 10 | `src/main/claude/claude-structured-journal-translation.ts` | one local constant in `handleMessage`; pass at `:165`, `:171`, `:183`, `:195`, `:205`; and in the streamed `persist` at `:99-106` |
| 11 | `src/shared/structured-agent-session-live-turn.ts` | scope `activeStructuredAgentSessionToolCall` (`:85-98`) and `isStructuredAgentSessionThinking` (`:54-80`) |
| 12 | `src/shared/structured-agent-session-projection.ts` | scope `latestStructuredAgentSessionAssistantMessage` (`:253-269`) and rewrite its docstring to name the producer; scope `latestStructuredAgentSessionPrompt` (`:239-249`); leave `projectStructuredItemsToNativeChat` and `hasPersistedStructuredAgentSessionTurn` alone, with a one-line reason at each |
| 13 | tests | Section 7, with the ablation for each |

Two of those "leave alone" decisions need their reason recorded, not just stated:

- `projectStructuredItemsToNativeChat` — **the transcript shows every agent's output.** The line
  this change draws is: *the transcript renders every item; every "what is this agent doing right
  now" scan renders only the session's own agent's items.* Scoping the transcript would delete
  subagent output from the chat.
- `hasPersistedStructuredAgentSessionTurn` — an existence test ("is this session listable at
  all"), not an attribution test. Scoping it could make a session with content read as having
  none, and a missing row is worse than a correctly-attributed one.

`latestStructuredAgentSessionPrompt` **is** scoped even though it is provably a no-op on the
Claude lane today (Section 2, item 2). The reason is the Codex lane, where user-item provenance
is **UNVERIFIED**: scoping costs one predicate call and removes a live question.

### Risks, each with its handling

- **`max-lines`.** `claude-structured-journal-translation.ts` is 310 raw lines and the repo caps
  at 300/400/600/800 by path (`.oxlintrc.json:160-178`). If step 10 trips the cap, **extract**
  — `AGENTS.md` forbids a `max-lines` disable or a per-file bump, without exception.
- **The streamed path is the one that gets missed.** A fix that only edits `handleMessage` looks
  complete, passes every test written against `handleMessage`, and leaks on every streamed reply
  — which is the common case under `--include-partial-messages`. Test 3 in Section 7 exists
  solely for this, and it should be written before step 10, not after.
- **The subagent test harness silently swallows the third argument** (`:20-54`). Fix the harness
  in the same commit as the first producer test, or every producer assertion is vacuous.
- **Byte accounting.** `estimateStructuredAgentSessionItemBytes` does not see append options, so
  the flag is ~24 bytes per child row uncounted against the sink watermarks. Immaterial at the
  16 MB pause watermark; noted so nobody rediscovers it as a mystery.
- **Cross-version suite.** Run
  `pnpm exec vitest run --config config/vitest.config.ts tests/e2e/cross-version-wire/cross-version-agent-session-wire.unit.test.ts`.
  It should stay green under Rule 1. Add no "old side lacks X" assertion.
- **Running tests rewrites `pnpm-lock.yaml`.** Restore with `git checkout -- pnpm-lock.yaml` —
  that path only, never a bare checkout.

### Gates

`pnpm tc`; `pnpm test src/shared/structured-agent-session-projection.test.ts`,
`src/shared/structured-agent-session-live-turn.test.ts`,
`src/main/claude/claude-structured-journal-translation-subagents.test.ts`,
`src/main/native-chat/agent-session-journal/journal-reducer.test.ts`,
`src/main/native-chat/agent-session-journal/journal-row-schema.test.ts`; the cross-version
agent-session suite; `pnpm run check:code-quality:changed`.

### For the PR body

The material deviation this document already records — that Orca keeps two writers of one status
row apart with publication filters where every implementation examined removes the possibility of
a second writer — is **not** what this change fixes, and the PR should not imply otherwise. This
change fixes something narrower and adjacent: one row's *content* was being written from another
agent's output. Describe it in repo-native terms only, and name no external project anywhere in
the PR, the commits, the branch, or the code.

### Evidence gap to disclose

The exact frame shapes Claude emits for a subagent's inner tool calls and their results — in
particular that a child's `tool_result` frame carries the same `parent_tool_use_id` as the
`tool_use` that preceded it — are **VERIFIED by code path** (both flow through the one
`envelope.parentToolUseId` read at `claude-structured-item-translation.ts:57`) and
**UNVERIFIED against a captured transcript**. If the producer tests are written from remembered
frame shapes rather than a recorded stream, that assumption is untested. Capturing one before
step 10 would close the last gap in this plan.
