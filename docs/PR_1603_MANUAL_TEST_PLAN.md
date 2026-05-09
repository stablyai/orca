# PR #1603 — Manual verification with real agents

Companion to `docs/PLAN_SLEEP_STATUSES.md`. Covers the gaps the playwright-cli/CDP run couldn't hit cleanly: real agent processes, full window recreation (Cmd+Q + relaunch), and SSH worktrees.

The scripted run already verified the renderer-side store transitions for: live-row drop on sleep, retained-done drop on sleep, ack drop on sleep, sleep+wake reactivation, and `WorktreeJumpPalette` label parity. See PR description for those.

---

## Setup once

- Open a fresh dev build (or a worktree you can throw away after).
- Pick a worktree where it's safe to start real Claude/Codex turns. Throwaway branch recommended.
- Have a separate worktree open in another tile so cross-worktree behavior (test 8) can be observed.

## Highest value — genuinely uncovered by the scripted run

### Test 1 — Real working-state mid-turn sleep (Phase 1)

1. Start a Claude (or Codex) turn that does at least one tool call. Confirm sidebar shows yellow dot + "AGENTS (1) … working" row.
2. While the tool call is in flight, right-click the worktree → **Sleep**.
3. Watch closely: dot should transition yellow → grey within one render, working row should vanish at the same time.

**Expect:** dot grey, no row, no toast. Memory panel shows the worktree leaving the active list. The agent process is actually dead — `ps` should show no surviving Claude/Codex child.

**Fail signals:** dot stays yellow for >1 render; row persists as "working" or as "done"; toast `Failed to sleep workspace`.

### Test 2 — Sleep + Cmd+Q + relaunch (true reload — Test 8 from design doc)

This is the case the scripted run couldn't drive (`location.reload()` doesn't recreate the BrowserWindow, so `agentHookServer.setListener` never re-fires the replay loop).

1. Start a Claude turn → let it complete (`Stop`).
2. Wait ~2 seconds for `useRetainedAgentsSync` to capture the live entry into `prevAgentsRef`.
3. Sleep the worktree (right-click → Sleep). Confirm card greys + retained row drops (this is Phase 2 in-process behavior).
4. **Cmd+Q the entire app.** Wait until it's fully exited.
5. Relaunch the dev build. Open the same worktree.

**Expect:** card stays grey. **No retained-done row.** The PTY-teardown path called `clearPaneState(paneKey)` (`src/main/ipc/pty.ts:349`), wiping `lastStatusByPaneKey` for that pane, so there's nothing for the replay loop to re-emit.

**Fail signals:** retained-done row reappears in the sidebar — that's a Phase 2 regression in the `clearPaneState` wiring or a path where it's being skipped.

### Test 3 — Done + Cmd+Q + relaunch, **no sleep** (Test 7 control)

Run this back-to-back with Test 2 so any divergence is obvious.

1. Start a Claude turn → let it complete (`Stop`).
2. Wait ~2 seconds for retention to capture.
3. **Don't sleep.** Just Cmd+Q the app.
4. Relaunch. Open the same worktree.

**Expect:** retained-done row **restored** in the sidebar. Replay loop fires on window recreation (`agentHookServer.setListener` re-registration → iterates `lastStatusByPaneKey.values()` → re-emits each as a normal status event into the renderer → `setAgentStatus` lands the entry → the next retention sync picks it up if/when the live entry disappears).

Note: per the design doc, retained-done **is not persisted to disk** — `lastStatusByPaneKey` is process-memory in main. So if the relaunch is far enough apart that you've fully restarted, you may see no row. That's pre-existing behavior, not a Phase 2 regression. Quick relaunch is what proves the replay path is intact.

**Fail signals:** if Test 2 passes (no row after sleep+Cmd+Q+relaunch) but Test 3 *also* shows no row, then either the replay path is broken (regression) or the retention-sync re-capture isn't firing on hydrate. Check the terminal for `[agent-hooks] replay listener threw` log.

## Medium value

### Test 4 — Permission-state sleep (Phase 1)

Triggered the `waiting`/`blocked` path through the same `dropAgentStatusByWorktree` plumbing — the scripted run only exercised `working` and `done`, so this confirms the user-visible signal.

1. Trigger a Claude tool call that hits a permission gate (e.g. Bash with a command not on the auto-allowlist). Sidebar dot should turn red.
2. Sleep the worktree.

**Expect:** dot grey, permission row gone, no toast.

### Test 5 — Status-bar memory segment sleep button (alternate UI surface)

The scripted run drove sleep via `runSleepWorktree` directly. The right-click menu uses the same helper. Confirm the per-worktree memory-segment sleep button in the bottom status bar also behaves identically.

1. Start an agent turn somewhere.
2. Open the memory/resource panel from the status bar.
3. Use the per-worktree sleep button.

**Expect:** same outcome as Test 1.

### Test 6 — Two worktrees, sleep one

Catches accidental cross-worktree drops in `dropAgentStatusByWorktree`'s tab-prefix sweep.

1. Start agents in worktree A and worktree B simultaneously (real turns, both ideally in a `working` state).
2. Sleep worktree A only.

**Expect:** A goes grey + empty. B is **completely untouched** — same dot color, same row, same sort position. If B's dot or row flickers or shifts, we have a cross-worktree leak.

## Lower value — sanity / coverage completeness

### Test 7 — Sleep mid-turn for **Codex** specifically

Phase 1 audit explicitly mentioned both Claude and Codex paths. The scripted run used a fake hook event labeled `agentType: 'claude'`. Confirm the same flow with a real Codex pane:

1. Start a Codex turn.
2. Sleep mid-turn.

**Expect:** dot grey, working row gone — same as Test 1. No `pendingCodexPaneRestartIds` orphans (these are preserved under sleep, but cleared on remove — only relevant if you wake afterwards and the agent comes back cleanly).

### Test 8 — Sleep mid-turn for **OpenCode** / **Gemini** / **Cursor**

Less critical but free coverage if you have them set up. All flow through the same `agentStatusByPaneKey` infrastructure; if one of them broke the unconditional drop, Test 1 would have caught it, but a once-over per agent confirms the title-heuristic + hook paths agree.

### Test 9 — Mobile-initiated `worktree.sleep` over MCP

Skipped per your earlier ask; listing here so it doesn't get lost. Triggers the same renderer-side flow but from a different entry point.

1. Have the desktop card visible with a retained-done row (post-Test 2 setup).
2. From mobile (or via direct MCP call), invoke `worktree.sleep` for that worktree.

**Expect:** desktop card folds to grey, retained row drops — same as desktop-initiated sleep.

## What to actively look for during all of these

- **Stale rows that survive a render or two** before disappearing — Phase 1 invariant is "within one render". A 1-frame flicker is OK; a 100ms persistence is suspect.
- **Suppressor leak** — would manifest after wake: start a fresh turn, expected `working` row never appears (because `retentionSuppressedPaneKeys[paneKey]` was planted but never consumed). Easy to spot.
- **Jump palette parity** — open Cmd+J after each sleep, confirm the slept worktree shows `Inactive`. Easy to forget, quick to glance.
- **Toast errors** during sleep — the `runSleepWorktree` catch surfaces them as `Failed to sleep workspace`. None should fire in any of these flows.
- **Other worktrees re-sorting** when you sleep one — `sortEpoch` should bump only for the slept worktree's score change. If unrelated worktrees jump in the list, smart-sort is reading a wider input than it should.

## SSH-specific notes

If you run any of the above on an SSH worktree (relay-backed PTY), the renderer-side semantics are identical — `ptyIdsByTabId` and `agentStatusByPaneKey` look the same regardless of where the PTY actually executes. The only differences:

- `pty.kill` flows through the relay → may take a few hundred ms longer to round-trip than local. The dot should still grey within one render of `shutdownWorktreeTerminals` returning.
- `lastKnownRelayPtyIdByTabId` is preserved across sleep (wake hint). The map is independent of the live-PTY path and shouldn't matter for status correctness.
- `shutdownBufferCaptures` writes `buffersByLeafId` for SSH wake to reseed scrollback. Pre-existing path, untouched by this PR.

If you have an SSH host already configured in Orca, repeating Test 1 + Test 2 over SSH gives the strongest cross-platform coverage. If not, skip — the renderer-side change is the same code path regardless.
