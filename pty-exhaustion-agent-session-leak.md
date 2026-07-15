# Design Doc: PTY Exhaustion from Leaked Agent Sessions

**Date:** 2026-07-13
**Status:** Root cause identified; fixes proposed
**Severity:** P0 — machine-wide outage. Once the pty cap is hit, _nothing_ on the host can open a terminal (Orca, Ghostty, IDEs, `ssh`, agent spawns all fail with "cannot allocate pty").
**Source refs:** file:line references below are against the main checkout at `~/orca/orca` as of 2026-07-13.

---

## 1. Summary

An Orca desktop instance exhausted the macOS pseudo-terminal limit (`kern.tty.ptmx_max = 511`). Investigation on the live machine found **526 allocated ptys**, of which **~476 belonged to three `Orca Helper` processes** — hundreds of idle `login → zsh → codex resume <session-id>` chains, some alive for almost 4 days, all at 0% CPU. Sessions the user had explicitly closed in the UI were still running, and closed sessions kept _coming back_ in bulk waves after restarts.

The root cause is **two independent defects that compound into a self-perpetuating leak**:

- **Bug A (teardown):** Closing a session tab never kills the underlying pty. Tab close is pure renderer-state cleanup; the actual `pty.kill` only happens as a side effect of a mounted `TerminalPane` unmounting. For "cold-parked" tabs in background worktrees — whose panes are unmounted by design — closing the tab silently orphans the live process chain.
- **Bug B (resume):** Closing a tab never removes the session's record from the persisted resume list (`sleepingAgentSessionsByPaneKey`), and the record staleness check is a no-op (it compares `capturedAt - updatedAt`, which is always ≈ 0, instead of `now - updatedAt`). Every workspace open / app restart therefore bulk-launches `codex resume` for the entire orphaned backlog — and a periodic capture timer re-persists all of them, so the backlog only grows.

Every restart makes it worse: Bug B resurrects the dead-but-remembered sessions (each burning a fresh pty), Bug A guarantees closing them doesn't actually free anything, and the capture loop re-persists the ever-larger set.

---

## 2. Observed incident (live-machine evidence)

Measurements taken 2026-07-13 on the affected desktop:

| Metric                                            | Value                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| Allocated ptys (`/dev/ttys*`)                     | 526 (cap: `kern.tty.ptmx_max = 511`)                                    |
| `login` + `zsh` session pairs                     | 506                                                                     |
| Sessions parented to installed `Orca.app` helpers | 476 (helper pids 53960: **377**, 31662: 58, 1510: 41)                   |
| Sessions from dev-build Orca instances            | ~25                                                                     |
| `codex` agent processes                           | ~280 (~270 **unique** session IDs; a handful resumed 2–3× concurrently) |
| `claude` agent processes                          | ~38                                                                     |
| Processes using >1% CPU                           | 7 of 763 — everything else fully idle                                   |

Key observations:

- **`Orca Helper` pid 53960 alone held 376 open ptmx master fds.** Every leaked chain was still fully parented: `Orca Helper → /usr/bin/login → zsh → node → codex`. Nothing was orphaned to launchd — the app-side master fd was simply never closed.
- **Working directories were overwhelmingly finished PR-review worktrees** (`review-p1-pr-7511-issue-7026` alone had 79 codex processes; `review-p0-pr-8370-issue-8212` had 76; `review-p0-pr-8279-issue-8260` had 67).
- **Start times cluster in same-second waves** — batches on Fri Jul 10 (~15:41–18:14) and large bursts on Sun Jul 12 (14:03, 14:27, 14:36–14:40, 15:09). These are bulk resumes on workspace open / app restart, not user-opened sessions.
- **The user had closed these tabs.** The tabs were gone from the UI; the processes survived (Bug A) and were then re-resumed in later waves (Bug B).
- Nearly all resumed with `codex --dangerously-bypass-approvals-and-sandbox resume <uuid>` — i.e., they idle at an interactive prompt and never exit on their own.

---

## 3. Background: pty ownership architecture

- Terminal sessions are spawned in an Electron utility/helper process which holds the **pty master** (hence the ptmx fds on `Orca Helper`).
- A **daemon** hosts sessions so they survive app restarts for warm reattach: it is forked `detached: true` + `unref()` and deliberately outlives the app (`daemon/daemon-init.ts:306-319`; comment at `:741` — "sessions stay alive for warm reattach").
- Background (non-active) worktrees are **"cold-parked"**: their `TerminalPane` React components unmount, the transport calls `detach()` (`pty-transport.ts:929` — "keep the PTY exit observer alive"), and pane-less byte watchers observe the still-running pty.
- Agent sessions are additionally tracked in a persisted map, `sleepingAgentSessionsByPaneKey` (`src/renderer/src/store/slices/agent-status.ts:121`), so they can be resumed (`codex resume <id>`) after sleep/quit.

Keep-alive-on-detach is **intentional**. The defects are in what is supposed to end a session's life.

---

## 4. Bug A: closing a tab never kills the pty

### The close path contains no kill

`closeTerminalTab()` (`terminal-tab-actions.ts:152`) → `closeLocalTerminalTabState` → `state.closeTab()` (`store/slices/terminals.ts:1192-1381`). `closeTab` scrubs ~20 per-tab maps — including `delete ptyIdsByTabId[tabId]` (`terminals.ts:1217-1218`) — but issues **no `pty.kill`, no shutdown, no IPC**. It just _forgets the pty id_.

### The only kill is a React-unmount side effect

The pty dies only when a _mounted_ `TerminalPane` unmounts with the tab gone: `shouldDetachPaneTransportOnUnmount()` (`use-terminal-pane-lifecycle.ts:456`) returns false → unmount cleanup (`use-terminal-pane-lifecycle.ts:1725-1826`, kill branch at `:1807`) → `transport.destroy()` (`pty-transport.ts:1031`) → `window.api.pty.kill(id)` → main `pty:kill` (`ipc/pty.ts:4953`) → `provider.shutdown(id, {immediate: true})`.

This works for the **active** worktree. But for a **cold-parked** tab there is no mounted pane; closing it runs `syncParkedTerminalTabWatchers` → `disposeParkedTabWatchers` (`terminal-parked-watcher-registry.ts:53-63`), which stops the watchers and **never kills the pty**. The `login → zsh → codex` chain is orphaned with nothing pointing at it. **This is the zombie source.**

### Nothing else ever reaps it

Every existing reaper is scoped to an event _other than_ tab close:

| Mechanism                                                                                                             | Why it doesn't help                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon `detach` handler                                                                                               | Logging no-op — "full implementation would track tokens" (`daemon/daemon-server.ts:508-512`). No idle timeout exists anywhere.                                       |
| `reapSession` (`daemon/terminal-host.ts:215`)                                                                         | Fires only on the child's natural exit or explicit kill; an idle interactive `codex` never exits.                                                                    |
| App-quit `killAllPty()` (`ipc/pty.ts:5191`), reload `killOrphanedPtys` (`ipc/pty.ts:2851`)                            | Both guarded by `if (localProvider instanceof LocalPtyProvider)` — false for the daemon adapter, so daemon-hosted sessions are excluded _by design_ (warm reattach). |
| Worktree removal (`runtime/worktree-teardown.ts:39`, `killAllProcessesForWorktree`)                                   | Works, but only on full worktree delete.                                                                                                                             |
| Sleep flow (`sidebar/sleep-worktree-flow.ts:148` → `shutdownWorktreeTerminals`, `terminals.ts:2331`, kill at `:2665`) | Works, but only when the user explicitly sleeps the worktree.                                                                                                        |

### The codebase already knows close ≠ kill

`kill-all-terminal-surfaces.ts` performs daemon `killAll()`, then `closeTerminalTab({force: true})` per tab, **then an explicit `window.api.pty.kill(ptyId)` loop over `ptyIdsByTabId`** (`:140-147`, `:188-190`) — direct evidence that tab close alone is known not to kill. There is even a manual mop-up UI: **Manage Sessions → "Kill orphan terminals"** for sessions "that have no tab in this Orca instance" (`status-bar/ResourceUsageStatusSegment.tsx:~1114-1155`) — a hand-operated workaround for exactly this leak.

---

## 5. Bug B: closed sessions are resurrected in bulk forever

### The resume list never learns about tab close

Agent sessions are recorded in `sleepingAgentSessionsByPaneKey` (`agent-status.ts:121`; record shape in `src/shared/agent-session-resume.ts:38-59`, with `state`, `capturedAt`, `updatedAt`, and `origin: 'worktree-sleep' | 'quit' | 'live'`). Records are written:

- **Live:** on every non-done agent-status update, an `origin: 'live'` record is captured (`agent-status.ts:1492-1544`).
- **Quit + periodic:** `captureAllSleepingAgentSessions` writes an `origin: 'quit'` record for _every currently-live pane_ (`agent-status.ts:2312-2350`), called on quit (`App.tsx:1367`) **and on a periodic interval** (`App.tsx:1394`).

`closeTab` (`terminals.ts:1192-1381`) calls `dropAgentStatusByTabPrefix` (`terminals.ts:1894-2010`), which removes the agent-_status_ entry but **never touches `sleepingAgentSessionsByPaneKey`**. There is no concept of "user closed this tab" in the resume store. The orphaned record persists to disk with the workspace session state (`workspace-session-sleeping-agents.ts` → `workspace-session.ts:393`).

### The staleness gate is a no-op

On workspace/worktree open, `resumeSleepingAgentSessionsForWorktree` (`resume-sleeping-agent-session.ts:143-218`) launches `codex resume <id>` (argv built in `agent-session-resume.ts:195-220`; full command in `tui-agent-startup.ts:189-238`; launched via `sleeping-agent-session-launch.ts:65-128`) for every record unless a filter rejects it:

- `isPassiveCompletedHibernationEvidence` (`sleeping-agent-pane-ownership.ts:16-18`): only skips records that are `done` **and** not `live`/`quit` origin. Orphaned records are `live`/`quit`, so they pass.
- `isInvalidWorktreeActivationRecord` (`resume-sleeping-agent-session.ts:131-141`): rejects records where `state !== 'done' && (capturedAt - updatedAt) > 30 min` (`AGENT_STATUS_STALE_AFTER_MS`, `shared/agent-status-types.ts:256`). **But live records are captured with `capturedAt === updatedAt`** (`agent-status.ts:1501`) and quit records stamp `capturedAt = Date.now()` immediately after the last update — so the difference is always ≈ 0. The check should compare against **`now`**; as written, a record from three days ago is perpetually "fresh."
- `recordPaneIsOwnedByPreservedPane`: skips only if the pane still exists in the restored layout — but the user closed the tab, so it doesn't.

Result: orphaned records are neither passive, nor stale, nor pane-owned → **all of them get `codex resume`'d**, dozens in the same second. Triggers: folder-workspace open (`worktree-activation.ts:229`), worktree open (`:363`), startup hydration of the active worktree (`Terminal.tsx:1062-1075`), and mobile wake (`wake-sleeping-agents-in-background.ts:165-212`, wired at `useIpcEvents.ts:836`).

### The feedback loop

1. Workspace opens → every orphaned record is resumed → N fresh ptys, N idle `codex` processes.
2. Resumed sessions idle at a prompt and never reach `done`, so done-cleanup (`agent-status.ts:1541-1544`) never runs.
3. The periodic/quit capture (`agent-status.ts:2312-2350`) re-persists a record for every one of them.
4. User closes the tabs → Bug A leaves the processes alive; Bug B leaves the records in place.
5. Next open/restart → goto 1, with a strictly larger backlog.

Distinct historical session IDs produce distinct claim keys, so per-claim dedup doesn't collapse them — which is exactly why one worktree accumulated 79 live codex processes across ~270 unique session IDs machine-wide.

---

## 6. Proposed fixes

### Fix 1 (primary, Bug A): make tab close actually kill the pty

In `closeTab` (`terminals.ts:1192`) / `closeTerminalTab` (`terminal-tab-actions.ts:152`), issue `window.api.pty.kill()` for the tab's pty ids **before** `delete ptyIdsByTabId[tabId]`, mirroring the explicit kill loop in `kill-all-terminal-surfaces.ts:140-147`. This closes the parked-pane gap directly: the kill no longer depends on a mounted `TerminalPane` unmounting. Cover the split-pane close paths (`use-terminal-pane-lifecycle.ts`, `TerminalPaneOverlayLayer.tsx`) as well.

Design decision needed: if warm-reattach semantics should be preserved for _some_ tab closes, distinguish "close tab" (kill) from "sleep/detach" (keep alive) explicitly in the UI action — today the distinction exists in the code (Sleep uses `keepIdentifiers: true`, `sleep-worktree-flow.ts:148`) but plain tab close falls into an unintended third state: forgotten but alive.

### Fix 2 (primary, Bug B): remove resume records on tab close

Have `closeTab` (and the split-pane close paths) delete the closed panes' entries from `sleepingAgentSessionsByPaneKey`. A user closing a tab is expressing "I'm done with this session" — it must not remain resumable-by-default.

### Fix 3 (secondary, Bug B): origin-aware wall-clock expiry

Do not globally expire resume records by wall time: intentional `worktree-sleep`
checkpoints may remain valid for days. A defensive expiry can apply only to
unowned `live` or `quit` records after their origin and ownership are validated
at every wake entry point. Explicit tab close must delete its records
immediately and remains the primary fix.

### Fix 4 (secondary, Bug A): daemon-side reaper

Implement the daemon `detach` handler (`daemon-server.ts:508-512`) and an idle reaper for sessions that are detached with **no owning tab**. The daemon deliberately outlives the app and is excluded from every `instanceof LocalPtyProvider` sweep, so it needs its own lifecycle policy — otherwise any future client-side bookkeeping bug leaks forever again.

### Defense in depth

- Surface a pty-pressure warning (the data already exists for the "Kill orphan terminals" feature) when app-owned ptys exceed a threshold (e.g. 300), since exhaustion is a machine-wide outage.
- The `--dangerously-bypass-approvals-and-sandbox` resume flag amplifies blast radius: hundreds of unattended, sandbox-less agents idling for days. Consider whether bulk background resume should ever use it.

---

## 7. Verification plan

1. **Repro (pre-fix):** in a background worktree, open an agent session, switch to another worktree (parking the pane), close the tab → `ps` shows the `login/zsh/codex` chain still alive and the helper still holds its ptmx fd. Restart Orca → the session is resumed again.
2. **Post-fix:** same steps → chain dies on tab close (Fix 1); record removed so restart resumes nothing (Fix 2). Origin-aware defensive expiry is verified separately when implemented (Fix 3).
3. **Regression:** worktree Sleep → wake still resumes sessions; quit → relaunch still warm-reattaches sessions whose tabs were _not_ closed; daemon warm-reattach unaffected.
4. **Soak:** count `Orca Helper` ptmx fds (`lsof -p <helper> | grep -c ptmx`) across a day of open/close/restart cycles — should stay flat.

## 8. Immediate mitigation (ops, no code)

- Use **Manage Sessions → "Kill orphan terminals"** or exact-session termination
  to release the leaked ptys. A normal Orca.app restart is insufficient because
  the persistent terminal daemon deliberately survives for warm reattach.
- `sudo sysctl kern.tty.ptmx_max=999` raises the cap to its macOS hard max — buys headroom only, hours at current leak rate.
- Restart the terminal daemon only when exact-session cleanup is unavailable;
  this terminates all daemon-backed sessions, including legitimate in-flight work.

---

## Appendix: diagnostic commands used

```sh
ls /dev/ttys* | wc -l && sysctl kern.tty.ptmx_max        # allocation vs cap
ps -ax -o pid,tty,etime,comm | grep -E 'ttys[0-9]+'      # who holds ptys
lsof -a -d cwd -c codex | awk '{print $NF}' | sort | uniq -c | sort -rn   # per-worktree counts
lsof -p <helper-pid> | grep -c ptmx                       # master fds per Orca Helper
ps -ax -o args | grep -oE '[0-9a-f-]{36}' | sort | uniq -c # duplicate session resumes
```
