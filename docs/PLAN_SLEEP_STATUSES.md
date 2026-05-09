# Plan: Sleep folds the worktree

## Problem

`runSleepWorktree` shuts down PTYs and browsers, but the sidebar lies about it on three axes:

1. **Workspace dot stays green.** The card heuristic still reports `'active'`.
2. **Agent rows persist as "working".** A Claude that was mid-turn at sleep time keeps its row in the inline agent list, displayed as `working`, until `AGENT_STATUS_STALE_AFTER_MS` (30 min) decays it to `'idle'`.
3. **Retained `done` rows survive under a grey card** (after axes 1 and 2 are fixed). A finished agent's row keeps rendering inside the card body even though the worktree is asleep — producing a mixed signal: a grey "this is asleep" dot stacked with a bright green-check "Claude finished" row.

Each is a different surface lying about the same underlying state. The fix is one mental model applied across all three.

## Mental model

**The agent lives in the pane.**

Sleep is a deliberate, user-initiated action — not an OS sleep, not a timer, not an idle decay. It comes from one of:

- The desktop right-click → Sleep menu (`runSleepWorktree` via `WorktreeContextMenu`)
- The status-bar resource-usage row's per-worktree sleep button (`runSleepWorktree` via `ResourceUsageStatusSegment`)
- The mobile / MCP RPC method `worktree.sleep` (`sleepManagedWorktree` → notifier → renderer's `runSleepWorktree`)

All three are authorized user intent on some surface. The desktop user might be surprised by a mobile/MCP-initiated sleep, but that's a "why did sleep fire?" problem, not a "what should happen on sleep?" problem.

Given that contract, sleep folds *both* the runtime *and* its UI surfaces for that worktree:

- Live PTYs killed.
- Workspace dot reports `inactive` (grey) when no PTY is alive.
- Live `agentStatusByPaneKey` entries dropped.
- **Retained `done` snapshots dropped.**

The card collapses to just name + branch + grey dot. One coherent "this is closed" signal.

## Implementation status

This plan covers two changes on the `brennanb2025/sleep-statuses` branch:

1. **Status precondition + live-row drop (Phase 1)** — already shipped on the branch as commit `b5fd86e6` ("fix: gate worktree status on live PTYs so sleep reports inactive"). Gates the dot on runtime liveness; drops live `agentStatusByPaneKey` entries on sleep; introduces a `tabHasLivePty` helper.
2. **Retained-done drop (Phase 2)** — this PR. Removes the `preserveRetained` escape valve; folds retained `done` rows on sleep along with everything else.

Splitting the work was a sequencing call (Phase 1 was the latent bug; Phase 2 is the redirection). They share the same mental model — the unified document is the source of truth for both.

---

# Phase 1: Status precondition + live-row drop (shipped: b5fd86e6)

## Root cause

A single dot conflates three orthogonal signals:

1. **Runtime liveness** — is a PTY (or browser tab) actually alive in this process?
2. **Title-scraped activity** — `detectAgentStatusFromTitle` parses `tab.title` for "esc to interrupt" etc.
3. **Hook-reported agent state** — `agentStatusByPaneKey` entries from Claude/Codex hooks (`permission` / `working` / `done`).

The dot promoted to non-grey if *any* of those three read true. After sleep, (1) is false but (2) and (3) read true off stale state, so the dot lied. Same shape on crash and on slept-with-retained-done: liveness is gone but the other two signals survive and falsely promote.

Sleep does the right thing memory-wise — `pty.kill` runs, `ptyIdsByTabId[tab.id]` is cleared to `[]` (`src/renderer/src/store/slices/terminals.ts:1020-1023`), the daemon/relay PTYs go away. The bugs were in the *status surfaces*, which read fields that sleep deliberately preserves as wake hints rather than the field that tracks live processes.

### The two preserved fields, and why they exist

Under `keepIdentifiers: true` sleep preserves:

- `tab.ptyId` — the last known daemon-history sessionId (or relay session id). Kept so wake can pass it as `args.sessionId` to `pty.spawn` and reattach to the same on-disk history dir / relay session. **Not** a liveness signal.
- `terminalLayoutsByTabId[*].ptyIdsByLeafId` — same purpose, per-leaf granularity for split panes.
- `lastKnownRelayPtyIdByTabId` — same purpose for SSH wake.
- `agentStatusByPaneKey` entries — the prior comment at `terminals.ts:1128-1138` reasoned these "describe the live agent process which the user expects to survive sleep". That was the wrong call: the agent process is dead the instant `pty.kill` fires.

### The bug in `getWorktreeStatus`

`src/renderer/src/lib/worktree-status.ts:19`:
```ts
const liveTabs = tabs.filter((tab) => tab.ptyId)
…
if (liveTabs.length > 0 || browserTabs.length > 0) return 'active'
```

`tab.ptyId` is the wake hint — preserved across sleep — not a live-PTY check. So `liveTabs.length > 0` for every slept tab and the dot stayed emerald.

### The bug in `useWorktreeAgentRows`

`src/renderer/src/components/sidebar/useWorktreeAgentRows.ts` reads `agentStatusByPaneKey` and emits a row for every entry whose tab is in this worktree. Sleep skipped `dropAgentStatusByTabPrefix` (gated behind `if (!keepIdentifiers)`), so entries from before sleep kept producing rows.

## Phase 1 design (shipped)

**Core rule: runtime liveness is a precondition.** A worktree's dot is `'inactive'` (grey) unless at least one of its tabs has a live runtime — `ptyIdsByTabId[tabId].length > 0` — or a live browser tab. Only when liveness holds may the existing priority order (`permission` > `working` > `done` > `active`) promote the dot.

This single rule subsumes sleep, crash, slept-with-retained-done, and never-started — they all collapse to the same answer. If nothing is alive, agent-state and title-scraped signals can't lie the dot green; they're shadowed by the precondition.

### Change 1: `getWorktreeStatus` and `WorktreeCard` gate on live PTYs

Switch the liveness signal from `tab.ptyId` to `ptyIdsByTabId[tab.id].length > 0`. Pass the map (or a per-tab live count) into `getWorktreeStatus` and update its caller (`WorktreeCard`).

The same precondition applies at `WorktreeCard.tsx:183-225`, where `hasPermission` / `hasLiveDone` / `hasRetainedDone` are derived, and at the status `useMemo` at `WorktreeCard.tsx:227-241`. Today those promote the dot off `agentStatusByPaneKey` and `retainedAgentsByPaneKey` directly; under the new rule they only promote when liveness is true. Why: `retainedAgentsByPaneKey` is intentionally persistent UX — the row inside the card still shows the retained-done signal — but with no live runtime the worktree-level dot has no business being green.

Why reading `ptyIdsByTabId` is strictly better than `tab.ptyId`:
- `ptyIdsByTabId` is the source of truth for live PTYs in the renderer. Every `pty.spawn` writes it; every `pty.kill` and every shutdown path clears it. Sleep clears it. Hydration starts it empty (`terminals.ts:1605-1609`).
- Self-corrects on wake — when the user activates a slept worktree and reattach repopulates `ptyIdsByTabId`, the dot lights up automatically with no extra wiring.
- Catches non-sleep dead-PTY cases too. A PTY that exited unexpectedly (crash, daemon disconnect before reattach) leaves `tab.ptyId` populated as a reattach hint while `ptyIdsByTabId[tab.id]` is `[]`. The fix covers them.
- Hydration shape unchanged: `ptyIdsByTabId` is populated from the wake-hint sessionId at hydrate time (`terminals.ts:1716-1722`, motivated by the comment at `:1689` — "restore ptyId on the tab so getWorktreeStatus() sees it as active (green dot) even before the terminal pane mounts"), so the dot lights up on reload at the same moment it does today.

### Change 2: Sleep drops live agent-status entries

In `shutdownWorktreeTerminals`, the `if (!keepIdentifiers)` gate around `dropAgentStatusByTabPrefix(tab.id)` was removed. Drop unconditionally.

Without this, `useWorktreeAgentRows` would still emit a row per stale `agentStatusByPaneKey` entry, so dead-process rows would persist as "working" inside the card body even though the dot is correctly grey.

Phase 1 kept retained-done across sleep — the grey-card-with-green-row mixed signal. Phase 2 drops that too (see below).

### Change 3: Centralize via a `tabHasLivePty` helper

```ts
// Why: tab.ptyId is the wake-hint sessionId, not a liveness signal.
// Reads of "is this tab alive?" must go through the live-PTY map.
export function tabHasLivePty(
  ptyIdsByTabId: Record<string, string[]>,
  tabId: string
): boolean {
  return (ptyIdsByTabId[tabId]?.length ?? 0) > 0
}
```

Routed through every renderer reader of "is this tab alive?":

- `src/renderer/src/lib/worktree-status.ts` — `liveTabs` filter.
- `src/renderer/src/components/sidebar/WorktreeCard.tsx` — pass live signal into `getWorktreeStatus` and the status `useMemo`.
- `src/renderer/src/lib/agent-status.ts` — both `getWorkingAgentsPerWorktree` and `countWorkingAgentsForTab` gate on **both** their primary pane-titles branch and their tab-title fallback. Sleep preserves `runtimePaneTitlesByTabId`, so a slept tab whose pane titles still match "esc to interrupt" would otherwise emit a working agent through the primary branch — feeding the title-bar `activeAgentCount`, the dock badge, and `workingAgentsPerWorktree` aggregates. Specifically gates: `:65-78` (primary branch in `getWorkingAgentsPerWorktree`), `:79-84` (its tab-title fallback), `:237-244` (primary branch in `countWorkingAgentsForTab`), `:249-251` (its tab-title fallback). Plumbing: thread `ptyIdsByTabId` into `AgentQueryArgs` and propagate from App.tsx's `agentInputs` selector.
- `src/renderer/src/store/slices/tabs.ts:1289` — `legacyRuntimeTerminalTabs` is a one-shot migration filter selecting tabs not yet in `unifiedTabs` that either have live PTYs or carry a wake-hint `tab.ptyId`. The `|| tab.ptyId != null` clause is kept with a comment explaining why: the migration filter must include slept tabs not yet promoted to `unifiedTabs`, and reconcile fires again post-reattach so the field's wake-hint semantics here are intentional, not a confused liveness check.

### Change 4: suppressor-id hygiene

`shutdownWorktreeTerminals` adds the killed ptyIds to `suppressedPtyExitIds` so the renderer ignores their exit events (`terminals.ts:1027-1030`). Two distinct suppressor systems are in play and shouldn't be conflated:

- `suppressedPtyExitIds` — the renderer ignore-list for incoming PTY exit events. Unchanged.
- `retentionSuppressedPaneKeys` — the retention-side ignore-list consumed by `collectRetainedAgentsOnDisappear` (`useRetainedAgents.ts:87`) on the next render cycle when the pane disappears from the live aggregate. Since live entries are removed by the unconditional drop, the same render cycle's effect sees the disappearance and consumes the suppressor — no leak.

---

# Phase 2: Sleep drops retained-done (this PR)

After Phase 1 the dot is honest, but the inline agent rows under the slept card are not. Specifically, **retained `done` rows survive sleep** and render under a grey-dotted card.

That produces a visually mixed signal: a grey "this is asleep" dot stacked with a bright green-check "Claude finished" row. New users read the green check as live status; experienced users read it as a notification breadcrumb. Both readings are defensible, which is the problem — there isn't a single coherent message.

The fix is to commit fully to the mental model: sleep folds the worktree's UI surfaces, including its retained-done rows.

## Why drop retained-done on sleep specifically

The retained-done row exists for one purpose: "Claude finished while you were away — go look here." That purpose is justified across:

- **Reload / app restart** — the user didn't ask to forget; resuming should restore the breadcrumb. ✅ Keep.
- **Tab close** — the user explicitly tore down the tab; the row should not resurrect. ✅ Already drops.
- **Worktree remove** — the user deleted the whole worktree. ✅ Already drops (whole map is filtered by `pruneRetainedAgents`).
- **Sleep** — the user explicitly folded the worktree away. The breadcrumb has nothing left to point at because the user just said "I'm done with this for now." ❌ Today (after Phase 1): kept. This PR: drops.

The "Claude finished while you were away" framing applies when the user *didn't choose* to step away from the result. Sleep *is* the user choosing to step away, with full knowledge of the result (the row was visible at the moment they slept it).

## Phase 2 design

One change in the sleep call site, inheriting existing semantics from `dropAgentStatusByTabPrefix` without `preserveRetained`. After Phase 1 the call was:

```ts
get().dropAgentStatusByTabPrefix(tab.id, { preserveRetained: keepIdentifiers })
```

### Change 5: Drop the `preserveRetained` flag from the sleep path

Change the sleep call site at `src/renderer/src/store/slices/terminals.ts:1149` to:

```ts
get().dropAgentStatusByTabPrefix(tab.id)
```

Sleep (`keepIdentifiers: true`) and remove (`keepIdentifiers: false`) now share the same retained-row behavior — both wipe live and retained entries. The acknowledged-flag cleanup that was previously gated on `!preserveRetained` naturally re-enables. Suppressor planting also re-enables, which is correct because we want to forbid re-retention if a hook ping promotes working→done in the same frame as sleep (the same-frame race already documented in `dropAgentStatusByTabPrefix`).

### Change 6: Update the comment block at `terminals.ts:1128-1147`

The current comment justifies `preserveRetained: keepIdentifiers` with the "Claude finished while you were away" rationale. Replace with a short note explaining the new contract: agent rows live with the pane; sleep folds them; renderer reload within the same Orca process still restores retained-done by replaying the main-process hook cache (`lastStatusByPaneKey` in `src/main/agent-hooks/server.ts`) on window re-attach. Sleep tears down that upstream source via PTY teardown's `clearPaneState`, so a slept-then-reload flow has nothing to replay — by design.

### Change 7: Remove the `preserveRetained` option from `dropAgentStatusByTabPrefix`

`src/renderer/src/store/slices/agent-status.ts:69-78` describes `preserveRetained: true` as "for sleep, where the agent process is dead but a retained `done` snapshot should stay visible." With that justification gone, the option has no remaining caller. Remove it:

- Delete the `preserveRetained` parameter from the function signature.
- Inline the logic that was previously gated on `!preserveRetained`.
- Delete the orphan `// Why skip when preserveRetained` paragraphs at `agent-status.ts:442-447` and `:486-491` — they justify a branch that no longer exists. The same-frame race comment at `:493-501` stays load-bearing; just adjust its opening to read as the now-default behavior, not as a `preserveRetained=false`-conditional behavior.
- Drop the `preserveRetained` argument at the (only) call site in `terminals.ts:1149`.
- `dismissRetainedAgentsByWorktree` is unaffected — different call shape, different purpose.

### What stays the same

- **Reload / hydrate path.** No code change. On renderer reload (Cmd-R / window re-attach within the same Orca process), retained-done snapshots are re-emitted from the main-process hook-replay cache (`lastStatusByPaneKey` in `src/main/agent-hooks/server.ts`) and surface in the sidebar exactly as they do today. Note: that cache is process-memory only — full app quit+relaunch starts empty and retained-done is not restored. That's pre-existing behavior; `agentStatusByPaneKey` was never persisted to disk (see `agent-status.ts:33-34`). This PR does not change that contract.
- **Live status drop.** Phase 1's unconditional live drop is unchanged.
- **Wake path.** No special handling — when the user wakes a slept worktree, no retained snapshots come back, and any post-wake agent activity flows through the normal hook → `setAgentStatus` → retention path. Fresh state.
- **Tab/pane close, worktree remove.** Unchanged. Both already drop retained.
- **`dismissRetainedAgentsByWorktree`.** Unchanged. The "Dismiss all in worktree" UI gesture still works the same way.

### Cross-surface implications

A mobile-initiated `worktree.sleep` will now also fold retained-done rows on the desktop. This is the right behavior — the mental model is "sleep is sleep regardless of where it was triggered" — but it's worth being explicit in case we need to revisit.

A scripted/MCP loop that calls `worktree.sleep` aggressively (e.g. "sleep idle worktrees on a timer") would silently discard retained-done rows the user hasn't seen yet. That's a misuse of the API rather than a bug here, but it's worth noting in source. **Recommendation: add a one-line code comment above the `defineMethod` block for `worktree.sleep` in `rpc/methods/worktree.ts`.** This is a stopgap — the comment is invisible to MCP/RPC clients. If aggressive scripted sleep becomes a real misuse pattern, runtime control (rate-limit, `acknowledgeUnread` flag) is the right answer; see Out of scope.

---

## UX (combined, Phase 1 + Phase 2)

| Worktree state | Live PTY? | Agent state (hooks) | Retained done? | Dot color | Card body | Comment |
|---|---|---|---|---|---|---|
| Active, working agent | yes | working | — | yellow spin | working row | Working |
| Active, agent done | yes | done | — | green | done row | Done |
| Active, agent needs permission | yes | blocked/waiting | — | red | row | Needs permission |
| Active, no agent | yes | none | — | green | (empty) | Active |
| Slept, was working | no | (dropped) | — | grey | (empty) | Coherent "closed" signal |
| Slept, was done (acknowledged) | no | (dropped) | (dropped) | grey | (empty) | Coherent; row reappears on wake if the agent does new work |
| Slept, was done (unacknowledged) | no | (dropped) | (dropped) | grey | (empty) | User saw the row, slept it knowing the result was there |
| Slept, never had agent | no | — | — | grey | (empty) | Identical to the above three cases |
| Renderer reload after sleep | empty (replay source wiped) | empty | empty | grey | (empty) | Sleep's PTY teardown calls `clearPaneState`, so the main-process hook-replay cache has nothing to re-emit on window re-attach |
| Wake | empty until hooks repopulate | (gone — no auto-restore) | (gone — no auto-restore) | grey then real | reactivates fresh | Past completions do not resurrect |
| Crash (PTY died unexpectedly) | no | stale | — | grey | stale row decays | Inactive |

The "slept, never had an agent" row is now indistinguishable from the slept-but-had-stuff cases. That's intentional under the laptop-lid model — sleep means "this worktree is folded away," and the card's visual state reflects only that fact, not the history of what happened before sleep. UX-1 (future work) tracks differentiating slept from never-started visually.

## Files touched

### Phase 1 (shipped: b5fd86e6)

| File | Change |
|---|---|
| `src/renderer/src/lib/tab-has-live-pty.ts` (new) | Export `tabHasLivePty(ptyIdsByTabId, tabId)` helper |
| `src/renderer/src/lib/worktree-status.ts` | `getWorktreeStatus` accepts the live-pty signal; switch `liveTabs` filter to use `tabHasLivePty` |
| `src/renderer/src/components/sidebar/WorktreeCard.tsx` | Subscribe to `ptyIdsByTabId` for this worktree's tabs; thread into `getWorktreeStatus`; gate `hasPermission` / `hasLiveDone` / `hasRetainedDone` selectors at `:183-225` and the status `useMemo` at `:227-241` behind a worktree-level `hasAnyLive` |
| `src/renderer/src/lib/agent-status.ts` | Gate **both** the primary pane-titles branch and the tab-title fallback in **both** functions on `tabHasLivePty`: `:65-78` and `:79-84` in `getWorkingAgentsPerWorktree`; `:237-244` and `:249-251` in `countWorkingAgentsForTab`. Thread `ptyIdsByTabId` into `AgentQueryArgs` and propagate from App.tsx's `agentInputs` selector |
| `src/renderer/src/store/slices/tabs.ts` | At `:1289`, leave `livePtyIds.length > 0 \|\| tab.ptyId != null` intact; add a comment that this is a migration filter |
| `src/renderer/src/components/WorktreeJumpPalette.tsx` | Thread `ptyIdsByTabId` into the `getWorktreeStatus` call at `:833` |
| `src/renderer/src/store/slices/terminals.ts` | Remove `if (!keepIdentifiers)` guard around the `dropAgentStatusByTabPrefix` loop (with `{ preserveRetained: keepIdentifiers }`); update the comment to match |

### Phase 2 (this PR)

| File | Change |
|---|---|
| `src/renderer/src/store/slices/terminals.ts` | At `:1149`, drop the `{ preserveRetained: keepIdentifiers }` argument. Update the surrounding comment block (`:1128-1147`) to reflect the new contract |
| `src/renderer/src/store/slices/agent-status.ts` | Remove the `preserveRetained` option from `dropAgentStatusByTabPrefix` (signature + doc + body). Inline the `!preserveRetained` branches. Delete the orphan `// Why skip when preserveRetained` paragraphs at `:442-447` and `:486-491`; adjust the same-frame race comment at `:493-501` to read as the now-default behavior |
| `src/renderer/src/store/slices/store-cascades.test.ts` | In `describe('shutdownWorktreeTerminals (sleep) — agent status hygiene')`: keep `:1373` (live drop) and `:1500` (existing-suppressors preserved) unchanged. Invert `:1400` (rename + flip `toBeDefined` → `toBeUndefined`; drop the parenthetical "Claude finished while you were away" justification from the title), `:1443` (rename + flip ack expectation — ack should now be cleared), and `:1471` (rename + flip — suppressors ARE planted now). Update the comment block at `:1357-1366` to drop the stale `(preserveRetained: true)` parenthetical and reflect the new contract that retained-done, ack, and suppressors all fold on sleep |
| `src/renderer/src/components/sidebar/sleep-worktree-flow.test.ts` | Add an assertion that retained-done rows for the slept worktree are gone after `runSleepWorktree` returns |
| `src/main/runtime/rpc/methods/worktree.ts` | Add a code comment above the `defineMethod({ name: 'worktree.sleep', ... })` block noting that sleep folds agent rows, including retained-done; aggressive scripted use will discard unread completions. (RpcMethod has no description field, so this is a source-only note — see Out of scope) |

## Test plan

### Unit

**Phase 1 (shipped):**
- `worktree-status.test.ts`: `getWorktreeStatus` returns `'inactive'` when tabs have `tab.ptyId` set but `ptyIdsByTabId[tab.id]` is `[]`. Returns `'active'` when `ptyIdsByTabId[tab.id]` has entries even if `tab.ptyId` is null. Slept-with-retained-done → grey via the extracted `resolveWorktreeStatus` pure function.
- `tab-has-live-pty.test.ts` (new): direct tests for the helper — empty map, missing key, empty array, populated array.
- `agent-status.test.ts`: `getWorkingAgentsPerWorktree` returns 0 for a slept tab when (a) `runtimePaneTitlesByTabId[tab.id]` still contains a working-pattern title (primary branch) and (b) only `tab.title` matches (fallback branch). Same for `countWorkingAgentsForTab`.

**Phase 2 (this PR):**
- `agent-status.test.ts` (extends): `dropAgentStatusByTabPrefix(tabId)` now wipes live, retained, ack, and plants suppressors uniformly. Add a regression test for the prior `preserveRetained: true` semantics being gone (i.e. the option no longer exists in the API).
- `store-cascades.test.ts`: in the `shutdownWorktreeTerminals (sleep) — agent status hygiene` block, three of the five tests invert (retained-done, ack, suppressor-planting); the live-drop and existing-suppressor-preservation tests stay. The comment block above the describe also updates. See the Files touched row for specifics.
- `sleep-worktree-flow.test.ts`: end-to-end through `runSleepWorktree`, retained-done rows for the slept worktree are gone after the call returns.
- `dismissRetainedAgentsByWorktree`: no new test — it isn't changing, and existing tests in `agent-status.test.ts:223,266` cover it implicitly.

### Integration / manual (Electron)

**Phase 1 paths (re-verify on this PR's branch HEAD since we're stacking):**
1. Start a Claude turn in worktree A. Confirm spinner + working row.
2. Sleep worktree A from the context menu while Claude is mid-turn. **Expect:** dot turns grey within one render. Working agent row disappears.
3. SSH worktree: same flow over relay. The renderer-side semantics are identical regardless of where the PTY runs.
4. Crash case: kill a daemon to simulate an unexpected PTY exit. **Expect:** dot turns grey for affected worktrees.

**Phase 2 paths:**
5. Start a Claude turn, let it report `done`, wait for retention sync to capture. Sleep the worktree. **Expect:** dot grey, retained `done` row gone (not just hidden — the entry is dropped).
6. Same as 5, but acknowledge the row first (so it's not bold). Sleep. **Expect:** same — row gone.
7. After step 5, do a renderer reload (Cmd-R / window re-attach) within the same Orca process *without* sleeping. **Expect:** retained-done row restored — replay path untouched. Note: full app quit+relaunch is *not* exercised here; the hook-replay cache is process-memory only and retained-done is not restored across full restart (pre-existing behavior, unchanged by this PR).
8. Sleep, then renderer reload. **Expect:** card stays grey with no row — sleep's PTY teardown wiped the replay source via `clearPaneState`, so there's nothing to re-emit. Same outcome on full restart, by the same mechanism.
9. Sleep, then wake. **Expect:** card reactivates empty; if Claude does new work, fresh hooks populate normally; past `done` does not come back.
10. Mobile / MCP path: trigger `worktree.sleep` via the runtime RPC while a desktop card has a retained-done row visible. **Expect:** desktop card folds to grey with no row, same as a desktop-initiated sleep.

## Out of scope

- **New "asleep" state in the `WorktreeStatus` enum.** Reuses `'inactive'` — the user perceives slept and inactive as the same thing visually, and there's no UX requirement to differentiate them in this PR.
- **Visual differentiation of slept vs never-opened.** Both render as grey + name + nothing else under this design. Tracked as Future Work UX-1.
- **Cross-worktree unread surface.** Today retained-done in the sidebar acts as a passive "scan the list, find finished agents" UI. After Phase 2, slept worktrees no longer participate in that scan. If we want that signal back later, options include a global notifications view or a small per-worktree badge that survives sleep. Tracked separately.
- **Live MCP `worktree.sleep` rate-limiting or confirmation.** If aggressive scripted sleeping becomes a real misuse pattern, add it to the RPC's policy layer. Not addressed here.
- **Mobile/MCP `worktree.ps` parity.** The runtime mirrors Phase 1's liveness rule for mobile clients in `src/main/runtime/orca-runtime.ts` (around `:3217`, `:6412`, `:6423`) using a different data model (`RuntimeLeafRecord`). Tracked in Future Work.

## Future work

- **Mobile/MCP `worktree.ps` parallel fix.** The runtime computes a worktree-status answer for mobile/MCP consumers using `RuntimeLeafRecord`-shaped state, separate from the renderer's `ptyIdsByTabId`. Open question: **why is the runtime/renderer code around worktree status duplicated rather than sharing a contract?** Worth checking whether they could share a status-derivation contract (pure function over a normalized shape) so a fix here doesn't have to be re-discovered there.
- **Rename `tab.ptyId` → `tab.lastSpawnSessionId`** (or audit and document each reader). The dual semantics — wake hint *and* (mistakenly) liveness — is the underlying root cause that Phase 1 mitigated but didn't eliminate. A rename makes any future "is this tab alive?" read off `tab.ptyId` either a type error or a grep-spottable mistake.
- **UX-1: differentiate slept from never-started.** Both render grey/inactive. Options: a small "z" glyph, a dimmed border, or a distinct tooltip ("Sleeping" vs "Inactive"). Low priority.
- **Optional unread-result badge on slept worktrees.** A small dot on the worktree row indicating "there was unread completion data here at sleep time," distinct from the active/working/done dots. Recovers the cross-worktree triage signal lost under Phase 2 while keeping the card body coherent.
- **Sleep-initiated source attribution.** If the IPC payload carried the source of the sleep call (`desktop_menu` / `status_bar` / `mobile` / `mcp`), the desktop could surface a brief toast for surprising remote-initiated sleeps ("This worktree was put to sleep from the mobile app"). Mitigates the "why did my worktree just sleep?" surprise from cross-surface initiation. Low priority.
