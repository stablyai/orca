## ELI5

When you ask an agent to do something, it sometimes hands part of the job to a helper agent and
finishes its own turn. In the sidebar, the agent that had finished kept jumping to the top of the
list and saying it had just done something — every single time the helper did anything. Its blue
"unread" dot came back each time too, so a row you had already read went unread over and over for
work you never saw.

Now the finished agent's row shows when *it* actually finished, stays read once you have read it,
and simply shows as still busy for as long as its helper is still working.

## What Changed

**Before.** A session that spawns a helper agent writes both agents' output into one timeline. The
row's "last activity" time was read off that whole timeline, so the helper's output counted as the
parent's. A user watching the sidebar saw the parent row stamped "now" while it sat idle, and the
helper row — the thing actually working — stamped "14m" beside it. The idle row looked live and the
live row looked stale. The same timestamp is what Orca compares against to decide whether you have
read a row, so the finished row also went unread again on every helper frame, and the notification
it produces changed identity with it.

**After.** The finished row shows the time the session's own agent finished, and holds it. It stays
read once read. While the helper is still working, the parent row reads as busy rather than
finished — so nothing goes quiet just because the work moved to a child.

**The mechanism.**

1. *The clock stops counting other agents' rows.* The journal reducer advanced `lastActivityAt` for
   every row appended. It now advances only for rows the session's own agent produced, using the
   producer marker and the shared `isRootAgentJournalItem` predicate that already ship on this
   branch. Two consumers read that clock, and both are the session's status summary.

2. *The subagent roster row is marked as what it is.* Claude's roster row — the "Ran 3 agents" row —
   is written from the parent's code, with no child identity anywhere near the call, yet it holds
   nothing but children's state and is rewritten on every child transition. Left unmarked it kept
   moving the clock by itself and the symptom survived everything else. It is now stamped
   child-produced. Nothing is hidden by that: the transcript deliberately renders every producer's
   rows, and the sidebar's child list comes from the live roster the host publishes, not from this
   row.

3. *Status, and only status, rolls up.* The host's status feed now publishes `working` for a session
   whose own agent has settled but whose subagent is still running. The recency clock, the prompt,
   the running-tool line and the last assistant message all stay strictly the parent's own. The
   rollup is deliberately narrow: only agent-kind children in a working state (a backgrounded shell
   is not a subagent), `attention` still outranks it, and a session with no turn at all is not made
   listable by a child.

4. *The renderer stops holding a second copy of a rule.* `StructuredAgentSessionStatusBridge` passed
   its own `stateStartedAt` when writing the row. The store's entry builder already computes one —
   same state keeps the stamp, a state change restamps it — and that rule is identical to the
   canonical host-side writer's. The bridge's version added a `done` special case that restamped
   every settled row on every publication, which is what let the acknowledgement clock move. The
   property is gone; the builder's rule applies. The bridge itself stays, and so do its publication
   filters.

## Why

The failure was not a formatting bug. One timeline carries two agents' rows, and every "what is this
agent doing right now" answer was a scan over that timeline with nothing on a row saying who wrote
it. Attribution at the producer — already landed for the prose and tool-line readers on this branch
— is what removes the premise, rather than adding a check in front of it.

Alternatives considered:

- **Just delete the bridge's `stateStartedAt`.** One line, and it does fix the reported screen. But
  the session's published `updatedAt` stays contaminated, so `worktree ps`, mobile and the canonical
  host row still report the parent as freshly active, and the host still re-broadcasts the whole
  summary to every subscriber once per child frame. It hides the symptom from one reader.
- **Publish the turn record's own completion time as a second timestamp and stamp the row from
  that.** Exact, and cheap, because turns are already root-only. Rejected: it adds a second recency
  concept beside `updatedAt` instead of making `updatedAt` correct, and attribution yields the same
  answer for free — the parent's last own row *is* its turn record.
- **Leave the parent quiet while its child works.** Correct about the clock and wrong about the
  user: a parent whose only outstanding work is a child is not finished. Hence the status rollup,
  which is the one thing a child is allowed to say about the row it hangs under.

Disclosure, because it is the honest shape of this change rather than a footnote: **Orca keeps two
writers of one status row apart with publication filters; this change does not remove that
structure.** A renderer component still writes structured pane keys, which the store's own guidance
says a reader should not do. What this change removes is the renderer's *policy* — after it, the
structured path has one `stateStartedAt` rule instead of two, and they agree. Consolidating the
writers is a separate, already-planned change, and it gets easier for this one having landed, not
harder.

Two further limits worth stating. Attribution here is a convention, not a type: a future append site
that forgets the marker re-opens the hole, and the mitigation is the producer-boundary tests below
rather than something the compiler can enforce. And only the Claude translator attributes today —
another structured provider that journals a child's output into the session timeline will still
contaminate the clock, with no new guard against it.

## Linked Issue

Fixes #

## Visual Proof

Not attached. The change is a timestamp, an unread marker and a status word on an existing sidebar
row; reproducing it on camera needs a live session that backgrounds a subagent and then sits idle
for long enough for the stamp to be visibly wrong. The behaviour is covered by the tests below,
including the acknowledgement consequence, which is the part a screenshot cannot show at all.

## Testing

`pnpm tc` clean. `pnpm exec oxlint` clean on every changed file.
`pnpm run check:code-quality:changed` passes — 0 new findings across 32 changed files.

Suites run green: `src/main/native-chat`, `src/main/claude`, `src/main/codex`, `src/main/runtime`,
`src/shared`, `src/renderer/src/store`, `src/renderer/src/attention`,
`src/renderer/src/components/sidebar`, `src/renderer/src/components/native-chat`, `mobile`.

Every new test was proven red by removing the corresponding production change at the final head and
green with it restored:

| Test | Removed to prove it red |
| --- | --- |
| `journal-reducer.test.ts` — the session's recency clock (own rows advance it, a child's do not, on both the item and lifecycle-batch paths) | the producer check around `lastActivityAt` |
| `structured-agent-session-status-feed-subagents.test.ts` — an idle session's clock and publication count hold still across five child rows | the same |
| `structured-agent-session-status-feed-subagents.test.ts` — a session with a working subagent reads `working`, claims no tool of its own, and ignores a backgrounded shell or a settled child | the status rollup |
| `claude-subagent-roster.test.ts` — every roster row is child-produced, first write and each revision | the roster row's marker |
| `claude-structured-journal-translation-subagents.test.ts` — the roster row is stamped | the same |
| `StructuredAgentSessionStatusBridge.test.tsx` — a settled row holds its completion stamp, its attention timestamp, and its read state as the host clock advances | the bridge's `stateStartedAt` |
| `StructuredAgentSessionStatusBridge.test.tsx` — a restored completion is stamped with host journal time and the bridge sends no `stateStartedAt` | the same |

Two harness details worth a reviewer's eye, because both would have produced a test that passes
either way:

- The roster test's fake sink discarded the options argument entirely, so every append read as root
  and the attribution assertion would have passed against the unfixed code. It now captures options.
- The feed test first used the wall clock, and five appends inside one millisecond share a `ts`, so
  `Math.max` moved nothing and the test passed under ablation on a re-run. It now drives an explicit
  advancing journal clock and fails under ablation on every run.

Three existing tests changed, which is worth saying plainly rather than leaving in the diff:

- `StructuredAgentSessionStatusBridge.test.tsx`, *"sorts restored completions by host time and
  advances identical turns"* — split. The restore half is a real fix from another change and is kept
  verbatim. The half asserting that an idle row's stamp advances on an identical republication is
  **inverted**, because it is the defect written down as intent: it contradicts the canonical
  host-side writer, it contradicts the documented invariant in the timestamp's own module, and its
  final assertion is a same-state ping re-triggering attention, which the acknowledgement module
  states outright cannot be allowed to happen. What it was really protecting — two completions in a
  row must not leave the row frozen on the first — now has its own test that drives the turn
  directly.
- `claude-structured-journal-translation-subagents.test.ts` — asserted the roster row stays root, on
  the stated reasoning that stamping it would hide the subagent list from the parent. It does not:
  the transcript projection is deliberately unscoped and the sidebar's children come from the live
  roster. Inverted, with the reason recorded next to it.
- `StructuredAgentSessionStatusBridge.test.tsx`, *"accepts an authoritative older journal age after
  a host upgrade reconnect"* — the corrected clock still lands on `updatedAt`, which is the point of
  the test. The completion stamp no longer moves with it, because the row was already `done` and
  stayed `done` — which is exactly what the canonical writer does with its own copy of the same
  session. One assertion updated.

Also refactored for the line budget rather than suppressing it: the status feed's test setup moved
into a shared `-test-bed` module used by both feed test files, and the old
`-test-session` helper folded into it. That removed a pre-existing double type assertion in the
process — the fake session map is now a real `Map` subclass.

Platforms: the change is platform-independent (journal reducer, host status projection, renderer
store write). Verified on macOS.

- [ ] I manually tested these changes locally
- [x] Automated tests added/updated, or explained why not below

## AI Disclosure

Claude Opus 4.5.

## Review

Worth a second opinion on two judgement calls:

1. **The rollup's state set.** It fires for agent-kind children in `working` or `monitoring`, and
   for a child whose state is absent (an older host's live task). `waiting` and `blocked` are
   deliberately excluded: a child that wants something is not a parent that is busy, and carrying
   them would be claiming the child's status rather than reporting outstanding work.
2. **Where the rollup lives.** It is in the host's status feed, so `worktree ps`, mobile and the
   sidebar cannot disagree about one session. The alternative was the renderer, which would have
   meant adding renderer policy in the same change that removes some.

## Agent skill upstream boundary

- [x] Not applicable.

## Notes

- **Backwards compatibility / remote wire.** No new field, no new frame, no schema version bump. Two
  published *values* change meaning, which the wire-compatibility guidance treats as a wire change
  even with no codec movement: a session's `updatedAt` now derives from its own agent's rows only,
  and its `status` can be `working` because of a child. Both are values every existing client
  already renders, and the new meaning is the corrected one, so an older paired client reads it
  without a capability gate and simply shows the fixed behaviour.
- **Journals written before this lands** carry no attribution, so a replayed child row is still read
  as the session's own. This is forward-only and self-heals on the session's next turn; nothing is
  backfilled.
- **Not fixed here, deliberately.** A subagent re-invoked after a pause keeps its first spawn stamp,
  so it can render "40m" while its current invocation is seconds old. That is a separate latch in
  the roster, it needs its own evidence, and the apparent version of it in the original report — an
  idle parent reading "now" beside a child reading "14m" — is resolved by this change, because the
  two now read coherently.
- **Performance.** Strictly less work: an idle session with a running child no longer re-broadcasts
  its whole status summary to every local and remote subscriber once per child frame.
- Security, SSH and cross-platform: no execution, path, or transport surface touched.

## Checklist

- [x] This PR is small and focused
- [x] I explained what changed and why (ELI5, the user-facing before/after, the mechanism, and why over the alternatives)
- [x] Before/after screenshots or videos attached for UI changes, or `N/A` with reason
- [x] Self-reviewed for correctness, security, and performance
- [x] Cross-platform, SSH/remote, and path/shortcut impact considered (or N/A)
- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass (or CI will cover; local preferred)
