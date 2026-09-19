## ELI5

When a chat agent hands part of a job to a helper agent, both of them write into the same
notebook. Nothing in the notebook said who wrote each line. So when the sidebar asked "what is my
agent doing right now?", it read the most recent line — usually the helper's — and showed the
helper's words and the helper's tool on the main agent's row.

Now every line records who wrote it, and the "what is my agent doing" readers only read their own
agent's lines. The full conversation still shows everything both agents wrote.

## What Changed

**Before.** Start a chat session and let the agent spawn a helper agent. While the helper worked,
the parent's sidebar row showed the helper's text as its own secondary line, and showed the
helper's running tool (for example `Grep`) as the tool the parent was running. The parent's chat
also showed the "thinking" indicator whenever the helper was reasoning, even though the parent was
not. The parent had produced nothing since handing the work over.

**After.** The parent's row shows the parent's own last line and the parent's own running tool —
which, while a helper runs, is the call that spawned it. The thinking indicator follows the
parent's own reasoning. The transcript is unchanged: it still shows everything the helper wrote,
and the helper's own rows in the helper list are unchanged.

**The mechanism.** A session's durable record is one file, but a session that spawns helpers writes
their output into it too, and no field on a row said which agent produced it. Every "what is this
agent doing right now" reader is a scan backwards from the end of the list that stops at a marker
only the top-level agent ever writes. So those scans were correctly bounded at their edges and
completely unscoped in their contents — the window they read was guaranteed to contain another
agent's rows, and during a helper run the newest row in it was almost always the helper's.

The change records the producer where the row is written, and scopes the readers by it:

- Rows gain an optional `producedBySubagent` marker, shaped exactly like the existing `recovered`
  marker next to it — present or absent, never `false`. Absence means the session's own agent.
- The Claude translator already read each frame's parent-call id and discarded it. It now stamps
  every row that frame produces: the message body, each tool call, each tool result, reasoning, and
  the generic fallback row. It also stamps **streamed** text, which is written from a callback that
  has no frame in scope — that path takes the marker from the streamed-block registry, which
  already scopes itself on the same parent-call id. A fix that only covered the frame path would
  have looked complete and still leaked on every streamed reply.
- Turn records and other lifecycle rows are left unstamped, because a turn is only ever opened by a
  top-level frame. That is now stated in a comment and pinned by a test.
- The three readers that leaked — the newest assistant line, the active tool call, and the thinking
  indicator — now skip rows another agent produced, through one shared predicate that is the only
  place absence is interpreted.
- Two readers are deliberately **not** scoped, each with its reason recorded in the file: the
  transcript renders every agent's output, and the "does this session have any content" check is an
  existence test, not an attribution one.

No schema version bump, no upcaster, no backfill. A row from a higher version is treated as
unreadable and puts the host into read-only, whereas an unknown key is simply ignored — so a
version bump for an optional marker would make journals written by a newer build unreadable to an
older one, for a field the older build never reads. Rows written before this change read as the
session's own agent, which reproduces today's behaviour for existing history exactly. The one
bounded consequence: a session that is open across the upgrade can still pick up a helper's line
for at most one turn, because the scans stop at the first turn marker and the first turn opened
after the upgrade is written by the new build.

## Why

The alternative was to filter at the reader — infer that a row belongs to a helper because it
follows a still-running spawn call. That is not implementable honestly: a helper's rows are written
under the parent's identity and the parent's session id, so there is no bit in the rendered row to
filter on. Inference also breaks under exactly the cases that already exist and are already tested,
such as a backgrounded helper still emitting after its spawn call has returned, or two helpers in
flight at once. It would have to be written four times over, and it would leave the durable record
permanently ambiguous, so the next reader starts from the same nothing.

Recording the producer where the row is written is also what this subsystem's own reference
document asks for: precedence is decided once, at write time, with provenance on the row, and
readers never re-adjudicate. Producer-side classification of top-level versus helper frames is
already established practice here — it exists in turn opening, in the streamed-block registry, in
the transcript reader, and on the Codex lane. The journal row was the one artifact that did not
carry it.

The marker is a bare `true`, not the helper's id. Readers need one bit: "is this mine". Per-helper
identity already has an owner — the helper roster, whose ids survive a task resume through an alias
map — and copying that identity onto rows would create a second copy that disagrees after any
resume. A presence bit also generalises to Codex, where the discriminant is a path rather than a
single id.

Honest scope: this removes the ambiguity, so a reader that wants its own agent's truth can now have
it. It does not make a fifth unscoped scan impossible to write; what discourages one is that the
scoped predicate now lives beside the type and is the obvious thing to reach for.

**Material deviation.** Orca keeps two writers of one status row apart with publication filters;
this change does not remove that structure. It fixes something narrower and adjacent: one row's
*content* was being written from another agent's output.

## Linked Issue

Fixes #

## Visual Proof

Not attached. The user-visible change is one line of text and one tool name on a sidebar row, and
reproducing it needs a live session that spawns a helper agent mid-turn. The behaviour is pinned
instead by tests asserting the exact fields the row reads — `lastAssistantMessage`, `toolName` and
`toolInput` — in both directions, each shown to fail without the change.

## Testing

`pnpm tc`, `pnpm test` on the five affected files (108 tests), `oxlint`, and
`pnpm run check:code-quality:changed` all pass. The cross-version wire suite stays green: the new
render-item field is optional, and no reader requires it.

Every new test was checked against the pre-change behaviour and observed to fail, then pass after:

- Removing the reader scoping reddens 7 of the reader tests.
- Removing the producer stamping reddens both stamping tests.
- Removing **only** the streamed-text stamping — the shape a frame-path-only fix would take —
  reddens exactly the streamed test and nothing else.
- Over-scoping the readers reddens the "the parent's own line still shows" tests.
- Scoping the transcript by mistake reddens exactly the "the helper's output is still in the chat"
  test, and nothing else.
- Stamping lifecycle rows reddens the "turn records stay unstamped" test.
- Dropping the marker in the row builder or in the reducer reddens the round-trip tests.

Two tests fail in a full local run and are unrelated: one drives the real Claude CLI and asserts
against this machine's own command catalogue (it fails identically with the change reverted), and
one is a temporary-directory cleanup race that passes in isolation.

Platforms: logic-only, no platform-specific code paths; exercised on macOS. No change to remote or
SSH behaviour — the same summary reaches every surface through the same store, so no reader-side
divergence is introduced.

- [x] I manually tested these changes locally
- [x] Automated tests added/updated, or explained why not below

## AI Disclosure

## Review

## Agent skill upstream boundary

- [x] Not applicable, or this change follows `docs/reference/agent-skill-sharing-upstream-boundary.md` and copies or mechanically translates no upstream skill-installer source, tests, fixtures, registry entries, path tables, comments, or documentation.

## Notes

- **Backwards compatibility.** Covered above: no version bump, unknown keys are ignored by older
  hosts, older rows read as the session's own agent.
- **Remote wire.** Three surfaces, three categories. The persisted row is not a protocol surface. The
  rendered item gains an optional field, which is safe as long as no reader requires it — none does,
  because absence is read as top-level. The *content* of the status summary changes for the duration
  of a helper run; this is deliberately **not** capability-gated, because gating it would mean
  continuing to serve older clients the helper's text as the parent's, preserving the defect for them
  by design. Old clients read those fields correctly; the fields were simply wrong.
- **Mobile.** Mobile reads the same shared readers, so it is corrected by the same change. No golden
  RPC recording carries journal render items, so no re-record is forced.
- **Performance.** One optional boolean per row; the readers gain one property check per item.
- **Security.** No new data crosses any boundary; the marker is derived from a field the producer
  already parsed.
- **Not in scope.** The Codex producer. The marker is provider-neutral and Codex has the same
  discriminant available, but whether Codex journals helper output into the parent's record is
  unverified and is its own investigation. Absent on Codex rows means top-level, which is exactly
  today's behaviour there.

## Checklist

- [x] This PR is small and focused
- [x] I explained what changed and why (ELI5, the user-facing before/after, the mechanism, and why over the alternatives)
- [x] Before/after screenshots or videos attached for UI changes, or `N/A` with reason
- [x] Self-reviewed for correctness, security, and performance
- [x] Cross-platform, SSH/remote, and path/shortcut impact considered (or N/A)
- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass (or CI will cover; local preferred)
