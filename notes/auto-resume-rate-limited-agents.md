# Auto-Resume Rate-Limited Agents

## Problem

Agent CLIs (Claude Code, Codex) stall when they hit provider usage limits. Claude Code shows either
an idle banner — `You've hit your session limit · resets 3:50pm (Europe/London)` — or a blocking menu:

```text
What do you want to do?
❯ 1. Stop and wait for limit to reset
  2. Ask your admin for more usage
  Enter to confirm · Esc to cancel
```

Today an external cron script scrapes terminal-history files and sends keystrokes. It fails in
practice: append-only history keeps stale banner text matching for hours, a content-hash cooldown
then blinds it to *new* limit events on the same terminal, and 30-minute polling adds worst-case
multi-hour blackouts. Detection must be event-driven on live PTY output, inside Orca.

## Decided product behavior (owner sign-off, do not re-litigate)

1. **Opt-in**: global setting, **off by default**.
2. **Scope v1**: **Claude Code and Codex** stuck-state patterns. Architecture must be
   provider-pluggable for gemini/opencode later.
3. **Menu grace**: when the wait-for-reset menu is detected, do NOT act immediately. Wait the
   agent idle-timer duration already configured in Orca (the hibernation idle timeout the user can
   configure; e.g. 5 min) so a human can intervene, then select option 1 ("Stop and wait for limit
   to reset") if the menu is still live. The agent CLI then handles its own countdown/resume.
4. **Banner-only case** (agent idle at prompt with a limit banner): arm a timer for the parsed
   `resetsAt` + ~90s grace, re-verify the banner is still on the live screen, then send
   `continue` + Enter.
5. **Dead PTY case**: if the limited agent's process has exited and a sleeping-session record
   exists, resume via the existing sleeping-agent relaunch path instead of keystrokes.
6. **Never act on stale data**: all detection and pre-send verification happens against the live
   PTY tail buffer, never terminal-history files on disk. Before any send, confirm the
   triggering banner/menu is still present and the agent title/status is not "working".

## Existing primitives to build on (verified file:line on origin/main)

Detection:
- `src/main/runtime/orca-runtime.ts:24460` — `findTerminalWaitBlockedSignal` scans each PTY's
  tail-buffer preview per output chunk for banner substrings; classifies into
  `RuntimeTerminalWaitBlockedReason` (`src/shared/runtime-types.ts:543`). Per-chunk hook with
  `tailWaitState` / `waitBlockedAt` tracking at `orca-runtime.ts:5390-5423`.
  Entry points: `detectTerminalWaitBlockedReason` (24377), `isKnownReadyPromptPreview` (24364).
- `src/shared/terminal-title-status.ts:138` — `detectAgentStatusFromTitle` (working/permission/idle
  from OSC titles); per-PTY `lastAgentStatus` updated at `orca-runtime.ts:5397-5423`.

Reset-time parsing:
- `src/main/rate-limits/claude-pty-reset-parser.ts:68` — `extractClaudePtyResetMetadata` already
  parses "resets 3:50pm", "resets Jan 5 at 4pm", relative "3h 20m" → timestamp. Reuse, don't rewrite.

Structured quota data (cross-check / fallback):
- `src/main/rate-limits/service.ts:106` — `RateLimitService`, `onStateChange` (161), poller +
  focus-refresh (211-236). `RateLimitWindow.resetsAt` in `src/shared/rate-limit-types.ts:1`.
- Codex: `src/main/rate-limits/codex-fetcher.ts` (JSON-RPC usage probe, resetsAt at 384).

Service template:
- `src/main/agent-awake-service.ts:42` — `AgentAwakeService`: settings-toggled (`setEnabled`, 84),
  fed by status changes (`setStatuses`, 92; wired via `agentHookServer.subscribeStatusChanges` in
  `src/main/index.ts:1691`), per-agent future-expiry `setTimeout` (`scheduleStaleTimer`, 134).
  Registered in composition root `src/main/index.ts:1685-1917`. Model the new service on this.

Wake actions:
- Live PTY keystrokes: `terminal.send` RPC `src/main/runtime/rpc/methods/terminal.ts:903` →
  `runtime.sendTerminal` (`orca-runtime.ts:8891`) → `ptyController.write`.
- Dead PTY resume: `src/renderer/src/lib/resume-sleeping-agent-session.ts:62`
  (`launchSleepingAgentSession` — new tab + resume argv from
  `src/shared/agent-session-resume.ts:195`). Sleeping records:
  `SleepingAgentSessionRecord` (`agent-session-resume.ts:38`).
- Idle-timer setting to reuse for menu grace: see `src/renderer/src/lib/agent-hibernation-planner.ts`
  (default 30-min idle, line 12) and its configurable setting — the menu grace must read the same
  user-configured value, not a new hardcoded constant.

Settings:
- `GlobalSettings` in `src/shared/types.ts:2469` (analog toggle `keepComputerAwakeWhileAgentsRun`
  at 2817); defaults `src/shared/constants.ts:333`; persistence `src/main/persistence.ts:5084/5131`;
  IPC `src/main/ipc/settings.ts:109`. UI: clone
  `src/renderer/src/components/settings/AgentAwakeSetting.tsx` (+ `agent-awake-copy.ts`), mount in
  `src/renderer/src/components/settings/AgentsPane.tsx:836`.

Status surfaces:
- Worktree card status: `src/renderer/src/lib/worktree-status.ts:11`
  (`WorktreeStatus = 'active'|'working'|'permission'|'done'|'inactive'`, heuristic `getWorktreeStatus`
  at 27, labels at 120); rendered via
  `src/renderer/src/components/sidebar/WorktreeCardStatusSlot.tsx` / `StatusIndicator.tsx`.
- Agent status vocabulary: `src/shared/agent-status-types.ts` (`working|blocked|waiting|done`),
  visual mapping `src/renderer/src/lib/agent-status.ts:221`.
- Status bar usage UI: `src/renderer/src/components/status-bar/StatusBar.tsx`,
  `inline-usage-bars.tsx`; renderer slice `src/renderer/src/store/slices/rate-limits.ts`.
- Native notifications: `src/main/ipc/notifications.ts` (settings-gated via `NotificationSettings`,
  `src/shared/types.ts:2233`).

## Implementation plan

### 1. Detection (main process, runtime)

- Add `'usage-limit-banner'` and `'usage-limit-menu'` to `RuntimeTerminalWaitBlockedReason`.
- Extend `findTerminalWaitBlockedSignal` with Claude Code patterns (session/usage/rate limit banner;
  wait-for-reset menu) and Codex equivalents (research Codex's actual limit-stall TUI text first —
  check codex-fetcher / codexbar notes; if Codex has no interactive stall state, document that and
  ship Codex as quota-timer-only).
- On detection, parse reset time from the matched text via `extractClaudePtyResetMetadata`; record
  `{ptyId, reason, resetsAt, detectedAt}` on the PTY record and emit an event.

### 2. `AgentAutoResumeService` (new, main process)

- Modeled on `AgentAwakeService`; registered in the composition root; enabled only by the new setting.
- Subscribes to limit-detected events. State machine per PTY:
  - `usage-limit-menu` → arm timer = user idle-timeout setting → on fire, verify menu still in live
    tail + agent not working → `sendTerminal(handle, Enter)` (selects option 1).
  - `usage-limit-banner` → arm timer = max(resetsAt from banner, resetsAt from RateLimitService for
    that provider) + 90s → verify banner still live → `sendTerminal(handle, "continue", enter)`.
  - PTY exit while limited → if a sleeping-session record exists for the pane, trigger the resume
    path; else notify only.
- Dedup: one in-flight action per ptyId; re-arm only on a *new* detection event (never re-match old
  content). Clear state on PTY output that changes agent status to working.
- Cap retries (e.g. 2 per detection) and always notify on give-up.

### 3. Setting

- `autoResumeRateLimitedAgents: boolean` in `GlobalSettings`, default **false** in constants.
- Toggle component cloned from `AgentAwakeSetting.tsx`, mounted in AgentsPane near the awake toggle.
  Copy: "Auto-resume rate-limited agents — when an agent hits a provider usage limit, Orca waits for
  the limit to reset and resumes it automatically."

### 4. UX surfaces

- New worktree status `'rate-limited'` (amber) in `worktree-status.ts` + card chip in
  `WorktreeCardStatusSlot`: `⏳ Rate-limited · resumes 3:50pm` (time from detection record; fall back
  to "waiting for reset" when unparsed). Priority: above 'inactive'/'done', below 'permission'.
- Status bar: small segment when ≥1 agent is limited: "1 agent paused · resumes 3:50pm"; click
  focuses that terminal. Reuse rate-limits slice plumbing (`rateLimits:update`-style push or a new
  channel from the service).
- Native notifications (gated by existing NotificationSettings + only when feature enabled):
  on detection ("Agent rate-limited — auto-resumes at 3:50pm") and on failed resume. Successful
  resume may notify quietly (respect existing notification granularity patterns).

### 5. Tests & gates

- Vitest units: banner/menu pattern matching (real captured Claude Code output incl. ANSI-stripped
  text; the menu text sometimes renders with collapsed spaces — "Askyouradminformoreusage" — so
  match case/space-insensitively), reset-parser integration, service state machine with fake timers
  (grace waits, re-verification, dedup, retry cap, PTY-exit path).
- Run repo gates: `pnpm tc`, `pnpm lint` (mind the max-lines ratchet — new files, don't bloat
  orca-runtime.ts; keep the service in its own module), `pnpm test`.

## Non-goals (v1)

- No per-repo/per-worktree overrides.
- No gemini/opencode/other agent patterns (keep detection provider-pluggable).
- No scraping of terminal-history files, ever.
- No changes to the automations subsystem (this is a service, not an automation).
