# Onboarding flow — design

> **Mockup:** `[docs/design/onboarding-flow-mockup.html](file:///Users/jinjingliang/Documents/projects/orca/create-onboarding/docs/design/onboarding-flow-mockup.html)` — static visual reference only, not the implementation.

## TL;DR

A 4-step split-layout wizard. Steps 1–3 set the three day-1 settings that map directly to marketed features (default agent, theme, notifications); step 4 is the activation moment (add a repo). Each step has a live preview that *shows* the feature, not a description that tells. The wizard ends inside a worktree with an agent ready to receive a task, and hands off to a persistent activation checklist that drives users to the parallel-orchestration aha. Sidebar grouping (worktree-per-task) is taught via a coach-mark on first landing, not a wizard step — context beats explanation, and shorter funnels convert better. Success metric: D1 activation rate.

## Problem

We are not activating new users enough. First-run drops users into the app with no framing for Orca's mental model (worktree-per-task, multi-agent orchestration, agents report back). Users who don't open a repo, run an agent, or see parallel orchestration in their first session churn silently.

## Goal

A short, split-layout wizard (Warp-style) that:

1. Teaches what Orca is by *showing* features (live preview on the right of every step).
2. Lets users customize the 3–5 settings that matter most on day one.
3. Ends with the activation moment — adding a folder/repo — and hands off to a persistent checklist that drives remaining activation milestones.

## Non-goals

- Not a kitchen-sink settings tour. Advanced settings stay in Preferences.
- Not a persona survey. No free-text fields.
- Not a tutorial modal stack that blocks the app after the wizard ends.

## Inspiration

Warp's 6-step onboarding (`../../../orca-internal/brain/competitor/warp/warp-app-screenshots/`, screenshots 3,5,7,9,11,13,15,17): split layout, one decision per screen, live preview, dot-indicator, `Back` / `Next` with keyboard affordance, final coach-mark on the real app.

Also reviewed: **Superset** (`../../superset/apps/desktop/src/renderer/screens/main/components/StartView`, `.../_onboarding/new-project/page.tsx`), **emdash** (`../../emdash/src/renderer/components/HomeView.tsx`, `NewProjectModal.tsx`, `views/Welcome.tsx`), **t3code** (no dedicated onboarding flow found in `apps/desktop` — no welcome/first-run/tour surfaces).

## What we keep / drop from Warp


| Warp                         | Orca                               | Why                                      |
| ---------------------------- | ---------------------------------- | ---------------------------------------- |
| Split layout w/ live preview | Keep                               | Show, don't tell                         |
| Persona survey               | Drop                               | Adds friction, low activation lift       |
| Autonomy step                | Drop                               | Agents own autonomy, not Orca            |
| Theme step                   | Keep                               | Cheap, high visible impact               |
| "Get Warping" CTA            | Replace with "Add your first repo" | Land in the aha moment, not an empty app |


### What we pull from Superset / emdash / t3code

- **Full-window drop zone on step 5** (Superset `StartView`): the entire "Add your first repo" step accepts a dragged folder — big dashed target that expands on drag-over. Removes the "click, then native picker" friction for the most common path.
- **Fold "Clone" and "Sample" under "Open a folder"** (Superset `new-project/page.tsx`): one primary drop/open surface, then a 3-tile row (`Open` · `Clone` · `Sample`) that swaps the inline form — not three equal-weight buttons stacked vertically. Keeps the activation path visually dominant.
- **Debounced inline validation pattern** (emdash `NewProjectModal.tsx:73-107` debounce-validates new-repo names against GitHub via `githubValidateRepoName`): we apply the same *pattern* — not the same check — to the Clone tile's URL field for cheap client-side shape validation (looks like a git URL, host reachable). Note: emdash validates *new repo names for availability*, not clone-URL auth. There's no precedent in the reviewed repos for live clone-URL auth probing, so we deliberately don't try; the 5s-timeout fallback (§5) is the safety net.
- **Progress state inside the same surface, not a new screen** (emdash `NewProjectModal.tsx:181-190`): when clone/open is running, replace the tile contents with a spinner + live status line; don't push to a new route. Keeps the wizard feeling like one continuous flow.
- **Block dismissal during in-flight work** (emdash `NewProjectModal.tsx:168-173`: `onInteractOutside` and `onEscapeKeyDown` no-op while `isCreating`): once a clone/open starts, suppress `Esc`, `Back`, and outside-click so a half-finished `git clone` isn't orphaned. Provide an explicit `Cancel` that cleanly aborts the child process instead.
- **Framer-motion stagger on the intro card only** (emdash `Welcome.tsx`): one subtle entrance animation on step 0; the rest of the wizard is instant. Over-animated wizards feel slower than they are.
- **macOS drag region at the top of the wizard shell** (Superset `_onboarding/layout.tsx`): 48px `-webkit-app-region: drag` strip, left-padded 88px on darwin for traffic lights. We already do this elsewhere but easy to forget in a full-bleed onboarding route.
- **Auto-dismiss transient errors** (Superset `StartView/index.tsx:15-19`: 5s `setTimeout` clears the error banner): for non-blocking failures (drop-zone path resolution, ephemeral picker errors), auto-clear after 5s so a stale message doesn't camp under the drop zone. Persistent failures (clone auth) still need manual dismiss.
- **Telemetry on click intent, not just completion** (emdash `HomeView.tsx:64-68` fires `project_open_clicked` before `onOpenProject`): in step 5, fire `onboarding_step5_path_clicked` (with `path: open|clone|sample`) at click time, then `onboarding_completed` on success. Lets us measure drop-off *between* intent and completion — which is where SSH/clone failures hide.
- **Reuse one component for onboarding step 5 and the empty-state home** (Superset's `welcome/page.tsx` is literally `<StartView />`): build the drop-zone surface once and mount it both inside the wizard and as the "no projects open" home screen. Avoids two copies drifting.
- **Skip from t3code**: no dedicated onboarding flow found in `t3code/apps/desktop`. Confirms our choice to push "keyboard primer" into the post-wizard checklist rather than a dedicated step.

---

## Feature selection

### Marketed features (onorca.dev)

Parallel multi-agent worktrees · Ghostty-class terminal · agents report back (notifications) · works with every CLI agent · embedded browser + Design Mode · inline diff review · remote worktrees over SSH · Cmd-J keyboard navigation.

### Settings available today

From `src/shared/types.ts` (line 970+): `defaultTuiAgent`, `theme`, `terminalFontFamily`/`Size`/`CursorStyle`/`ThemeDark`/`ThemeLight`, `notifications.enabled`/`agentTaskComplete`/`terminalBell`/`suppressWhileFocused`, `branchPrefix`, `setupScriptLaunchMode`, `refreshLocalBaseRefOnWorktreeCreate`, `rightSidebarOpenByDefault`, `editorAutoSave`, `diffDefaultView`, `workspaceDir`, `openLinksInApp`.

### Customize-worthy criteria

(a) marketing-prominent, (b) real day-1 preference, (c) decidable in one glance, (d) wrong default causes friction.

### The three settings steps

1. **Default agent** (`defaultTuiAgent`) — Orca's signature decision.
2. **Theme** (`theme` + terminal theme) — visible, cheap.
3. **Agent notifications** (`notifications.*`) — powers "agents report back."

Then a fourth, activation step: **Add your first repo**.

### Dropped settings (and why)

- **Sidebar customization** (`worktreeCardProperties` + `groupBy` + `sortBy`) — fails criterion (c): three sub-decisions stacked on one screen is the highest cognitive load in the wizard, given to the least-informed user (zero worktrees, can't evaluate the preview). The defaults cover 95%, and the discoverability concern (users not knowing they can group by repo) is solved better by a coach-mark on first landing — when the user actually has worktrees to group. Cutting this step shortens the funnel from 5 steps to 4, the single biggest lever on D1 activation rate. Sidebar reshaping moves to the post-wizard checklist as "Shape your sidebar" once the user has ≥3 worktrees.
- **Keyboard primer** — teaching-only, no decision. Moved to the post-wizard checklist (`Try Cmd-J`) where shortcuts fire against the real app.
- `**branchPrefix**` — sensible default (`agent/`) covers 95%; advanced users will find Preferences. Surfacing it day 1 invites bikeshedding before the user has created a single worktree.
- `**workspaceDir**` — collapsed inline on §5 instead of its own step (most users accept the default `~/orca/projects`).
- `**setupScriptLaunchMode`, `editorAutoSave`, `diffDefaultView`, `rightSidebarOpenByDefault`, `openLinksInApp`** — fail criterion (d): wrong default doesn't cause day-1 friction, only mild preference drift.

---

## Flow

Split layout throughout. Left: one decision. Right: animated preview of the feature being configured. Dot indicator, `Back` / `Next`, `Cmd+Enter` = next.

**Skip semantics.** A small `Skip` link in the corner skips the *current step* (writing the current default — see §Data model), not the whole wizard. There is no "skip everything" shortcut: `Esc` is intentionally not bound, because (a) muscle memory of `Esc` to dismiss modals would silently abandon the activation moment, and (b) any user who reaches step 5 and bails has already paid the wizard's cost — losing them there is the worst outcome.

**Skip on step 4.** Step 4 has no default to write (no repo = no activation), so `Skip` on step 4 is *abandon*, not *advance*: it writes `lastCompletedStep = -1` (dismissed sentinel — see §Data model), fires `onboarding_abandoned`, closes the wizard, and lands the user on the empty-state home (which reuses the same drop-zone surface — see §What we pull). The Skip link copy on step 4 reads "Skip — I'll add one later" to make the consequence explicit.

**Keyboard.** `Cmd+Enter` advances on steps 1–3. On step 4 it triggers the primary action (open native folder picker) since there is no "Next" — the step completes only when a repo is opened/cloned/sampled, and those are async.

### 1. Default agent

- Grid of supported CLI agents (Claude Code, Codex, Cursor CLI, Gemini, Copilot, OpenCode, Pi, Amp, Droid, …).
- On mount, run `which <bin>` for each; render a "Detected" badge on installed ones.
- **Pre-selection rule** when multiple are detected: pick by a fixed priority list (Claude Code → Codex → Cursor → Gemini → …) rather than "first found," so the default is deterministic across machines and reorderings of the grid.
- If *none* are detected: don't pre-select; show an inline "Install one of these to get started" hint with a link to each agent's install docs. The user can proceed without a selection — but in that case `defaultTuiAgent` stays unset, and step 4's success handoff must not pre-fill a composer with a non-existent agent. Instead, open the tab with the composer's agent picker focused and the coach-mark *"Pick an agent, type a task, hit Enter."* This is the only branch where the composer isn't pre-filled.
- Copy: *"Orca works with every CLI agent. Pick the one you'll use most — you can switch any time."*
- Preview: composer with the chosen agent pre-filled, sending a task.

### 2. Theme

- System / Dark / Light + "sync with OS" checkbox.
- Copy: *"You'll be staring at this for hours."*
- Preview: full app screenshot in chosen theme.

### 3. Agent notifications

- Three toggles: task complete (default on) · terminal bell (default on) · suppress while Orca is focused (default on).
- **OS permission prompt:** if the user enables any toggle and macOS notification permission is `notDetermined`, request it inline at `Next`-click; if `denied`, show a one-line "Notifications are off in System Settings → Notifications → Orca" with a deep-link button, **and force-write `notifications.enabled = false`** regardless of the in-wizard toggle state. The in-app setting must reflect actual delivery: leaving `enabled = true` while the OS drops every notification silently breaks the marketed "agents report back" promise. The user re-opts-in by re-toggling after granting OS permission.
- Copy: *"Orca watches your agents and tells you when they need you."*
- Preview: a mock task-complete notification firing; title-bar dot appearing.

### 4. Add your first repo — the activation moment

- A single **Location** row at the top (Superset `PathSelector`) shows where new repos will land. Pre-filled from the user's `workspaceDir` setting (default `~/orca/projects`); editable but collapsed-by-default so it doesn't compete with the drop zone. Only the Clone and Sample paths consume it; "Open a folder" ignores it (the user's chosen folder is the location).
- **Layout precedence:** the full-window drop zone is always-on; the 3-tile row (`Open` · `Clone` · `Sample`) sits *inside* the drop zone as the default content. Dragging a folder anywhere in the wizard window (including over the tiles) triggers the drop-over state — the tiles fade to ~30% so the dashed target dominates. Dropping resolves to the "Open a folder" path. This avoids the "where do I click vs. where do I drop?" ambiguity that a separated drop-zone-plus-tile-row would create.
- Paths:
  - **Open a folder** (primary button + full-window drop target) — native folder picker; if it's a git repo, offer to create a worktree; if it's a plain folder, open as a workspace.
  - **Clone from GitHub** — paste URL → clones into the Location row above.
    - *Error Handling:* If `git clone` hangs for &gt;5s or returns an SSH auth error (e.g. requires a passphrase), fail gracefully: show an error state that says "SSH authentication failed. Try opening a repo you've already cloned locally." with a button linking back to "Open a folder". Do not attempt to build an inline SSH prompt in the wizard.
  - **Try the sample repo** — ship a tiny public demo repo so users without local code still hit the aha. Cloned into the Location row. **Contents requirement:** the repo must contain (a) a `README.md` with two suggested agent prompts, (b) a real bug or TODO in source the agent can fix in &lt;60s, and (c) a passing test suite so the user sees a green check after the agent's first PR. Without (b), the "run an agent" checklist item turns into "watch the agent ask clarifying questions," which is not the aha.
  - **Connect a remote (SSH)** — *deferred to post-wizard*. Emdash exposes "Add Remote Project" as a fourth tile (`HomeView.tsx:103-113`), and remote worktrees over SSH is a marketed Orca feature, but the SSH-key/host-config setup is heavier than the activation step warrants. Surface it from the activation checklist and the post-wizard empty state instead, so the wizard's first-repo path stays one-click.
- While clone/open is in flight, suppress `Esc` / `Back` / outside-click; show a `Cancel` button that aborts the child process cleanly (see emdash pattern above).
- On success:
  - Close the wizard.
  - If a git repo: auto-create the first worktree using default settings → open a tab. If §1 produced a `defaultTuiAgent`, pre-fill the composer with it → coach-mark: *"Type a task and hit Enter."* If §1 was skipped or no agent was detected/selected, leave `defaultTuiAgent` unset, focus the composer's agent picker, and show the coach-mark: *"Pick an agent, type a task, hit Enter."* Never pre-fill a non-existent agent.
  - **Sidebar discoverability coach-mark** (one-shot, fires after the composer coach-mark is dismissed): a small pointer on the sidebar header reads *"Worktrees group by repo — change grouping, sort, or card density here any time."* This replaces the cut step-2 settings screen; it lands at the moment the user actually has a worktree to group, where the feature is legible.
  - If a plain folder: open the folder in the editor → coach-mark: *"This is your workspace. Cmd-J to jump anywhere."*
  - Show the activation checklist (see §Activation checklist).

---

## Activation checklist (post-wizard)

Persistent, dismissible panel in the right sidebar. Each item is tied to a real telemetry event, not self-report. Items adapt based on whether a git repo or plain folder was opened.

**Code path (git repo):**

- [x] Add a repo *(just done)*
- [ ] Run your first agent task
- [ ] Open a second agent on the same task — *the aha: parallel orchestration*
- [ ] Try `Cmd+J` — jump to any worktree
- [ ] Shape your sidebar — *unlocks after ≥3 worktrees exist; deep-links to the sidebar header's grouping/sort/card-property menu*
- [ ] Review a diff in Orca
- [ ] Open a PR from Orca

**Notes path (plain folder):**

- [x] Add a folder *(just done)*
- [ ] Open a file
- [ ] Run an agent on a file
- [ ] Try `Cmd+J`

Each unchecked item has a "Show me" button that deep-links to the surface and drops a coach-mark on first visit.

Checklist collapses to a small progress pill when all items are complete; dismissible permanently via `×`.

---

## Data model

**Storage.** No new file. Add the `onboarding` block to the existing `PersistedState` in `src/main/persistence.ts`, which serializes to `orca-data.json` under Electron's `app.getPath('userData')`:


| Platform | Path                                                             |
| -------- | ---------------------------------------------------------------- |
| macOS    | `~/Library/Application Support/Orca/orca-data.json`              |
| Windows  | `%APPDATA%\Orca\orca-data.json`                                  |
| Linux    | `~/.config/Orca/orca-data.json` (or `$XDG_CONFIG_HOME/Orca/...`) |


Dev runs use `<appData>/orca-dev/` (`configure-process.ts:112`); E2E uses a per-suite override. Both inherit the same atomic temp-file+rename write path and the case-sensitive `Orca/` directory name (don't reintroduce the timing bug guarded by the comment at `persistence.ts:58-70`). Add the `onboarding` defaults to `getDefaultPersistedState` in `src/shared/constants.ts`, and merge persisted values into defaults in `Store.load()` the same way `notifications` is merged today.

Add to user settings:

```ts
onboarding: {
  closedAt: number | null           // epoch ms; null = wizard never closed (fresh install or actively in progress)
  outcome: 'completed' | 'dismissed' | 'abandoned' | null  // null until the wizard ends
  lastCompletedStep: number         // sentinel: -1 = unstarted (fresh install) or dismissed (see outcome); 1..4 = highest step the user finished
  checklist: {
    // Code path
    addedRepo: boolean
    ranFirstAgent: boolean
    ranSecondAgentOnSameTask: boolean
    triedCmdJ: boolean
    shapedSidebar: boolean
    reviewedDiff: boolean
    openedPr: boolean
    // Notes path
    addedFolder: boolean
    openedFile: boolean
    ranAgentOnFile: boolean
    // Notes path reuses triedCmdJ from above
    dismissed: boolean
  }
}
```

Skipping a step on §1–§3 writes the current default, not `null` — so skipping never leaves the app in an undefined state. Skipping on §4 is *abandon* (no default to write; see §Flow).

**Resume vs. dismiss vs. fresh.** Three states, one sentinel-plus-flag scheme:

- *Fresh install:* `lastCompletedStep = -1`, `closedAt = null`, `outcome = null`. Show the wizard from step 1; do **not** fire `resumed_from_step`. This state is also reached when `orca-data.json` doesn't exist (first launch ever) or exists but lacks an `onboarding` block (treat as fresh) — except for the existing-user backfill below.
- *In progress (user quit mid-wizard):* `lastCompletedStep ∈ 1..3`, `closedAt = null`, `outcome = null`. On next launch, resume at `lastCompletedStep + 1` and fire `onboarding_started` with `resumed_from_step = lastCompletedStep`.
- *Closed:* `closedAt !== null`. Never re-show, regardless of `lastCompletedStep`. `outcome` records why (`completed` = success on §4, `dismissed` = explicit close / step-4 skip, `abandoned` = window close without explicit dismiss).

The resume gate is therefore: `closedAt === null && lastCompletedStep > 0`. Fresh installs (`lastCompletedStep === -1`) fall through to the from-scratch branch.

---

## Telemetry


| Event                                 | When                            | Properties                                          |
| ------------------------------------- | ------------------------------- | --------------------------------------------------- |
| `onboarding_started`                  | first render of step 1          | `resumed_from_step?: number`                        |
| `onboarding_step_viewed`              | step mount                      | `step: 1..4`                                        |
| `onboarding_step_completed`           | `Next` click w/ valid value     | `step`, `value` (e.g. agent id, theme)              |
| `onboarding_step_skipped`             | `Skip` click                    | `step`                                              |
| `onboarding_step4_path_clicked`       | tile click / drop               | `path: open                                         |
| `onboarding_step4_path_failed`        | clone/open error                | `path`, `reason: ssh_auth                           |
| `onboarding_completed`                | step 4 success                  | `path`, `is_git_repo: boolean`, `total_duration_ms` |
| `onboarding_abandoned`                | window close before `completed` | `last_step`                                         |
| `activation_checklist_item_completed` | item-specific telemetry fires   | `item`, `time_since_completed_ms`                   |


**The single number we're optimizing for:** `D1 activation rate` = `% of new installs that reach onboarding_completed within 24h of first launch`. Secondary: `% who hit "Open a second agent on the same task"` within 7 days (the parallel-orchestration aha). All other events exist to debug those two.

---

## How the wizard teaches the mental model

The teaching mechanism is the *live preview pane*, not copy. Each step maps to a concrete visual:

- Step 1 (Default agent) — an agent being assigned to a task.
- Step 3 (Notifications) — a background agent firing a notification, demonstrating async execution.
- Post-wizard sidebar coach-mark — fires on first landing in a worktree; teaches worktree-per-task and the grouping/sort/card affordances at the moment they're legible (the user has a real worktree to look at).
- Checklist — closes the loop with "Open a second agent on the same task — *the aha: parallel orchestration*."

Step 2 (theme) and step 4 (add repo) don't teach mental model; they remove friction and deliver activation.

## Resolved (was: open) decisions

- **SSH clone hangs** — fail fast. &gt;5s or auth error → fallback UI pointing to "Open a folder." We don't try to PTY-capture passphrase prompts in the wizard.
- **Resume mid-wizard** — see §Data model. Resume gate: `closedAt === null && lastCompletedStep > 0`. Fresh installs (`lastCompletedStep === -1`) start from step 1, not "resume."
- **Existing users** — distinguish "no `onboarding` block because pre-onboarding build" from "no `onboarding` block because fresh install" using the same signal `Store.load()` already captures: `fileExistedOnLoad` (`persistence.ts:118`). If `orca-data.json` existed before this load *and* has no `onboarding` block, backfill `closedAt = installDate` (or `Date.now()` if install date isn't known), `outcome = 'completed'`, `lastCompletedStep = 4`. If the file didn't exist, treat as fresh. Surface new affordances via a one-shot "What's new" modal, not a forced re-onboarding.

## Still open

- **Agent detection cost** — `which` × ~15 agents needs measurement. Target &lt;200ms total on a cold launch. If it exceeds, run detection lazily on step-1 mount instead of app launch and show a 200ms shimmer. macOS `PATH` is hydrated by `src/main/startup/hydrate-shell-path.ts`.
- **Sample repo** — does one exist? If not, propose `orca-build/orca-sample` per the contents requirement in §5. Owner needed.
- **Checklist persistence across machines** — if a user installs Orca on a second machine, do we re-show the checklist? Lean: yes, keyed per-install, since shortcuts and surfaces are machine-local muscle memory.
