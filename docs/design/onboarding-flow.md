# Onboarding flow — design

> **Mockup:** `[docs/design/onboarding-flow-mockup.html](file:///Users/jinjingliang/Documents/projects/orca/create-onboarding/docs/design/onboarding-flow-mockup.html)` — static visual reference only, not the implementation.

## TL;DR

A 4-step split-layout wizard. Steps 1–3 set the three day-1 settings that map directly to marketed features (default agent, theme, notifications); step 4 adds a repo/folder. Each step has a live preview that *shows* the feature, not a description that tells. For git repos, the wizard hands off to a first-task composer that creates the first Orca worktree on submit, so users learn worktree-per-task through their first real action instead of by reading a primer. Sidebar grouping is taught via a coach-mark after that first worktree exists — context beats explanation, and shorter funnels convert better. Success metric: D1 activation rate = repo/folder opened plus first agent task started within 24h.

## Problem

We are not activating new users enough. First-run drops users into the app with no framing for Orca's mental model (worktree-per-task, multi-agent orchestration, agents report back). Users who don't open a repo, run an agent, or see parallel orchestration in their first session churn silently. Opening code is necessary but not sufficient activation; the flow must get git users to start at least one agent task in an Orca-created worktree.

## Goal

A short, split-layout wizard (Warp-style) that:

1. Teaches what Orca is by *showing* features (live preview on the right of every step).
2. Lets users customize the 3–5 settings that matter most on day one.
3. Ends with the activation setup — adding a folder/repo — and hands off to the first agent-task moment plus a persistent checklist that drives remaining activation milestones.

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

- **Full-window drop zone on step 4** (Superset `StartView`): the entire "Add your first repo" step accepts a dragged folder — big dashed target that expands on drag-over. Removes the "click, then native picker" friction for the most common path.
- **Fold "Clone" under "Open a folder"** (Superset `new-project/page.tsx`): one primary drop/open surface, then a 3-tile row (`Open` · `Clone` · `Remote`) that swaps the inline form — not two equal-weight buttons stacked vertically. Keeps the activation path visually dominant. (Superset uses three tiles; we drop "Sample repo" as a wizard tile — see step 4 — and surface it on the post-wizard empty state instead.)
- **Debounced inline validation pattern** (emdash `NewProjectModal.tsx:73-107` debounce-validates new-repo names against GitHub via `githubValidateRepoName`): we apply the same *interaction pattern* — not the same network check — to the Clone tile's URL field for cheap client-side shape validation (looks like a supported git URL, has a repo-ish path segment, derives a non-empty folder name). Do not probe host reachability before the user clicks Clone: private enterprise URLs and SSH remotes must not be contacted on paste. Auth/network validation happens only after explicit Clone intent; the idle/auth fallback in step 4 is the safety net.
- **Progress state inside the same surface, not a new screen** (emdash `NewProjectModal.tsx:181-190`): when clone/open is running, replace the tile contents with a spinner + live status line; don't push to a new route. Keeps the wizard feeling like one continuous flow.
- **Block dismissal during in-flight work** (emdash `NewProjectModal.tsx:168-173`: `onInteractOutside` and `onEscapeKeyDown` no-op while `isCreating`): once a clone/open starts, suppress `Esc`, `Back`, and outside-click so a half-finished `git clone` isn't orphaned. Provide an explicit `Cancel` that cleanly aborts the child process instead.
- **Framer-motion stagger on the intro card only** (emdash `Welcome.tsx`): one subtle entrance animation on step 0; the rest of the wizard is instant. Over-animated wizards feel slower than they are.
- **macOS drag region at the top of the wizard shell** (Superset `_onboarding/layout.tsx`): 48px `-webkit-app-region: drag` strip, left-padded 88px on darwin for traffic lights. We already do this elsewhere but easy to forget in a full-bleed onboarding route.
- **Auto-dismiss transient errors** (Superset `StartView/index.tsx:15-19`: 5s `setTimeout` clears the error banner): for non-blocking failures (drop-zone path resolution, ephemeral picker errors), auto-clear after 5s so a stale message doesn't camp under the drop zone. Persistent failures (clone auth) still need manual dismiss.
- **Telemetry on click intent, not just completion** (emdash `HomeView.tsx:64-68` fires `project_open_clicked` before `onOpenProject`): in step 4, fire `onboarding_step4_path_clicked` (with `path: open_folder|clone_url|sample_repo`) at click/drop time, then `onboarding_completed` on success. Lets us measure drop-off *between* intent and completion — which is where SSH/clone failures hide.
- **Reuse one component for onboarding step 4 and the empty-state home** (Superset's `welcome/page.tsx` is literally `<StartView />`): build the drop-zone surface once and mount it both inside the wizard and as the "no projects open" home screen. Avoids two copies drifting.
- **Skip from t3code**: no dedicated onboarding flow found in `t3code/apps/desktop`. Confirms our choice to push "keyboard primer" into the post-wizard checklist rather than a dedicated step.

---

## Feature selection

### Marketed features (onorca.dev)

Parallel multi-agent worktrees · Ghostty-class terminal · agents report back (notifications) · works with every CLI agent · embedded browser + Design Mode · inline diff review · remote worktrees over SSH · keyboard navigation.

### Settings available today

From `src/shared/types.ts` (line 970+): `defaultTuiAgent`, `theme`, `terminalFontFamily`/`Size`/`CursorStyle`/`ThemeDark`/`ThemeLight`, `notifications.enabled`/`agentTaskComplete`/`terminalBell`/`notifyWhenFocused`, `branchPrefix`, `setupScriptLaunchMode`, `refreshLocalBaseRefOnWorktreeCreate`, `rightSidebarOpenByDefault`, `editorAutoSave`, `diffDefaultView`, `workspaceDir`, `openLinksInApp`.

### Customize-worthy criteria

(a) marketing-prominent, (b) real day-1 preference, (c) decidable in one glance, (d) wrong default causes friction.

### The three settings steps

1. **Default agent** (`defaultTuiAgent`) — Orca's signature decision.
2. **Theme** (`theme`) — visible, cheap.
3. **Agent notifications** (`notifications.*`) — powers "agents report back."

Then a fourth activation-setup step: **Add your first repo**.

### Dropped settings (and why)

- **Sidebar customization** (`worktreeCardProperties` + `groupBy` + `sortBy`) — fails criterion (c): three sub-decisions stacked on one screen is the highest cognitive load in the wizard, given to the least-informed user (zero worktrees, can't evaluate the preview). The defaults cover 95%, and the discoverability concern (users not knowing they can group by repo) is solved better by a coach-mark on first landing — when the user actually has worktrees to group. Cutting this step shortens the funnel from 5 steps to 4, the single biggest lever on D1 activation rate. Sidebar reshaping moves to the post-wizard checklist as "Shape your sidebar" once the user has ≥3 worktrees.
- **Keyboard primer** — teaching-only, no decision. Moved to the post-wizard checklist (`Try the jump shortcut`) where shortcuts fire against the real app.
- `**branchPrefix**` — current default (`git-username`) covers 95%; advanced users will find Preferences. Surfacing it day 1 invites bikeshedding before the user has created a single worktree.
- `**workspaceDir**` — collapsed inline on step 4 instead of its own step (most users accept the current default `~/orca/workspaces`).
- `**setupScriptLaunchMode`, `editorAutoSave`, `diffDefaultView`, `rightSidebarOpenByDefault`, `openLinksInApp`** — fail criterion (d): wrong default doesn't cause day-1 friction, only mild preference drift.

---

## Flow

Split layout throughout. Left: one decision. Right: animated preview of the feature being configured. Dot indicator, `Back` / `Next`, platform-aware keyboard affordance (`⌘+Enter` on macOS, `Ctrl+Enter` on Windows/Linux) = next.

**Skip semantics.** A small `Skip` link in the corner skips the *current step* (writing the current default — see §Data model), not the whole wizard. There is no "skip everything" shortcut: `Esc` is intentionally not bound, because (a) muscle memory of `Esc` to dismiss modals would silently abandon the repo-add setup, and (b) any user who reaches step 4 and bails has already paid the wizard's cost — losing them there is the worst outcome.

**Skip on step 4.** Step 4 has no default to write (no repo = no activation), so `Skip` on step 4 is *dismiss*, not *advance*: it writes `closedAt = Date.now()`, `outcome = 'dismissed'`, and `lastCompletedStep = -1`, fires `onboarding_dismissed`, closes the wizard, and lands the user on the empty-state home (which reuses the same drop-zone surface — see §What we pull). The Skip link copy on step 4 reads "Skip — I'll add one later" to make the consequence explicit. This is a terminal closed state; it must never be treated like a fresh install on next launch.

**Keyboard.** `⌘+Enter` advances on steps 1–3 on macOS; `Ctrl+Enter` does the same on Windows/Linux. On step 4 the same platform-aware shortcut triggers the primary action (open native folder picker) since there is no "Next" — the step completes only when a repo is opened or cloned, and those are async. UI labels must use `⌘` / `⇧` on macOS and `Ctrl+` / `Shift+` elsewhere; do not hardcode `Cmd` copy for non-macOS users.

### 1. Default agent

- Grid of supported CLI agents (Claude Code, Codex, Cursor CLI, Gemini, Copilot, OpenCode, Pi, Amp, Droid, …).
- On mount, call the existing renderer store path `ensureDetectedAgents()` (backed by `preflight:detectAgents`, `TUI_AGENT_CONFIG`, and the session cache), then render a "Detected" badge on installed agents. Do not add a second wizard-only `which` implementation; detection, launch commands, and catalog ordering must stay in one shared source.
- **Pre-selection rule** when multiple are detected: pick the first detected agent in `AGENT_CATALOG` priority order (Claude Code → Codex → Cursor → Gemini → …) rather than "first found," so the default is deterministic across machines and reorderings of async detection results.
- If *none* are detected: don't pre-select; show an inline "Install one of these to get started" hint with a link to each agent's install docs. The user can proceed without a selection — but in that case write `defaultTuiAgent = 'blank'`, not `null`. In today's composer, `null` means "auto-select the first detected agent" while `'blank'` means "no agent"; using `null` here would break the "never pre-fill a non-existent agent" promise. Step 4's success handoff must open the tab with the composer's agent picker focused and the coach-mark *"Pick an agent, type a task, hit Enter."* If the existing composer cannot focus an empty picker when `defaultTuiAgent = 'blank'`, add an explicit handoff override rather than changing the meaning of `null`.
- Copy: *"Orca works with every CLI agent. Pick the one you'll use most — you can switch any time."*
- Preview: composer with the chosen agent pre-filled, sending a task.

### 2. Theme

- System / Dark / Light. No separate "sync with OS" checkbox: `theme = 'system'` is the sync-with-OS choice, and adding a second boolean would create an unpersisted, contradictory state.
- **Surface that terminal theming has more knobs than this step exposes.** Below the three swatches, a one-line note links to `Settings → Terminal` for font family/size, cursor style, and the dark/light terminal palettes (`terminalFontFamily`/`Size`/`CursorStyle`/`ThemeDark`/`ThemeLight`). Without this hint, users assume the wizard's three swatches are the full theming surface and miss the marketed Ghostty-class terminal customization. Do not promote those knobs to wizard steps — they fail criterion (c) (not decidable in one glance) and bloat the funnel.
- **"Import from Ghostty" button** next to the note. Reads `~/.config/ghostty/config` (and `$XDG_CONFIG_HOME/ghostty/config`) and maps recognized keys onto Orca settings: `font-family` → `terminalFontFamily`, `font-size` → `terminalFontSize`, `cursor-style` → `terminalCursorStyle`, `theme` → `terminalThemeDark`/`terminalThemeLight` when the named theme matches a bundled Orca palette. Skip unrecognized keys silently rather than failing the whole import. Disabled with a hover tooltip ("No Ghostty config found at `~/.config/ghostty/config`") when the file doesn't exist; never auto-import without explicit click. On success, show inline confirmation ("Imported font + cursor from Ghostty") rather than navigating away. This is a shortcut for Ghostty-migrating users — it does not replace the `Settings → Terminal` link, which everyone needs.
- Copy: *"Pick the look that feels easiest to work in."*
- Preview: full app screenshot in chosen theme.

### 3. Agent notifications

- Three toggles, all default on: task complete · terminal bell · notify even when Orca is focused (persisted as `notifyWhenFocused`).
- **OS permission prompt:** if the user enables any toggle and macOS notification permission is `notDetermined`, request it inline at `Next`-click; if `denied`, show a one-line "Notifications are off in System Settings → Notifications → Orca" with a deep-link button, **and force-write `notifications.enabled = false`** regardless of the in-wizard toggle state. The in-app setting must reflect actual delivery: leaving `enabled = true` while the OS drops every notification silently breaks the marketed "agents report back" promise. The user re-opts-in by re-toggling after granting OS permission.
- **Startup prompt ownership:** the current app has `triggerStartupNotificationRegistration()` in `src/main/ipc/notifications.ts`, guarded by `ui.notificationPermissionRequested`. On fresh onboarding installs, defer that startup registration until after onboarding step 3 resolves; otherwise the OS prompt may fire before the wizard reaches the notifications step. Add a main-process IPC/read API for notification permission status and request state, and make both the startup registration path and onboarding path share the same `notificationPermissionRequested` guard so they cannot double-prompt.
- Copy: *"Orca watches your agents and tells you when they need you."*
- Preview: a mock task-complete notification firing; title-bar dot appearing.
- **Do not add an "agent status visibility" toggle here.** `showTitlebarAgentActivity` is already on by default, and the richer surfaces (`experimentalAgentDashboard`, `worktreeCardProperties.inline-agents`) fail criterion (c) — not decidable with zero worktrees. Step 3's frame is async notifications, not in-app status; status visibility is taught by the post-wizard sidebar coach-mark when the user has a real worktree.

### 4. Add your first repo — activation setup

- A single **Location** row at the top (Superset `PathSelector`) shows where new repos will land. Pre-filled from the user's `workspaceDir` setting (default `~/orca/workspaces`); editable but collapsed-by-default so it doesn't compete with the drop zone. Only the Clone path consumes it; "Open a folder" and "Open remote" ignore it (the user's chosen folder, or the remote path on the SSH target, is the location).
- **Layout precedence:** the full-window drop zone is always-on; the 3-tile row (`Open` · `Clone` · `Remote`) sits *inside* the drop zone as the default content. Dragging a folder anywhere in the wizard window (including over the tiles) triggers the drop-over state — the tiles fade to ~30% so the dashed target dominates. Dropping resolves to the "Open a folder" path. This avoids the "where do I click vs. where do I drop?" ambiguity that a separated drop-zone-plus-tile-row would create.
- Paths:
  - **Open a folder** (primary button + full-window drop target) — native folder picker; if it's a git repo, add/reuse the repo and continue to the git handoff below; if it's a plain folder, open as a workspace.
  - **Clone from GitHub** — paste URL → clones into the Location row above.
    - *Inline validation:* before Clone is clicked, validate only local syntax and derived folder name. Accept `https://`, `git@host:org/repo.git`, `ssh://`, and other git-accepted URL shapes that produce a non-empty target directory. Do not call GitHub, DNS, `git ls-remote`, or any reachability probe on paste.
    - *Error Handling:* If `git clone` emits an SSH auth/passphrase prompt, returns an SSH auth error, or goes idle for &gt;5s before first progress/output, fail gracefully: abort the clone, clean up the partial target directory, and show an error state that says "SSH authentication failed. Try opening a repo you've already cloned locally." with a button linking back to "Open a folder". Do not fail a clone merely because total wall-clock time exceeds 5s; large public repos and slow networks can legitimately take longer while still making progress. Do not attempt to build an inline SSH prompt in the wizard.
  - **Sample repo** — *cut from the wizard.* The cohort it served (devs trying Orca with zero local code) is small, and a third tile dilutes the two paths that actually drive activation. The "run an agent in &lt;60s" need it addressed is met for git users via their own repo, and for empty-folder users via the post-wizard empty-state home, which can surface a "Try the sample repo" affordance to anyone whose first opened folder yields nothing for an agent to act on. Build the sample-repo path once on the empty-state surface (which already reuses the step-4 component — see §What we pull) rather than as a wizard tile.
  - **Open remote (SSH)** — third tile, reuses the existing `RemoteStep` flow (`src/renderer/src/components/sidebar/AddRepoSteps.tsx:181-299`). Pick a pre-configured SSH target from `window.api.ssh.listTargets()`, enter a remote path, and call `window.api.repos.addRemote()`. Remote worktrees over SSH is a marketed Orca feature; surfacing it day-1 lets users who tried Orca *because* of remote dev hit their actual use case instead of being routed to a "Connect later" hint. **Cold-start case:** if the user has zero SSH targets configured, the tile opens the existing inline "Add in Settings" affordance (no new wizard-only target form); on save, returns to the tile. We do *not* build a wizard-local SSH host editor — that duplicates Settings → SSH and risks the two drifting. Inline validation is local-only (path is non-empty); reachability/auth probes only run after explicit click, mirroring the Clone path.
- While clone/open is in flight, suppress `Esc` / `Back` / outside-click; show a `Cancel` button that aborts the child process cleanly (see emdash pattern above).
- On success:
  - Close the wizard.
  - If a git repo: run the Git repo handoff below. If step 1 produced a concrete `defaultTuiAgent`, pre-fill the first-task composer with it → coach-mark: *"Type a task and hit Enter."* If step 1 was skipped or no agent was detected/selected, `defaultTuiAgent` is `'blank'`, focus the composer's agent picker, and show the coach-mark: *"Pick an agent, type a task, hit Enter."* Never pre-fill a non-existent agent.
  - **Sidebar discoverability coach-mark** (one-shot, fires after the first Orca worktree is created): a small pointer on the sidebar header reads *"Worktrees group by repo — change grouping, sort, or card density here any time."* This replaces the cut step-2 settings screen; it lands at the moment the user actually has a worktree to group, where the feature is legible.
  - If a plain folder: open the folder in the editor → platform-aware coach-mark: *"This is your workspace. Press ⌘+J to jump anywhere."* on macOS, or *"This is your workspace. Press Ctrl+Shift+J to jump anywhere."* on Windows/Linux.
  - Show the activation checklist (see §Activation checklist).

#### Git repo handoff algorithm

The activation handoff must be deterministic; implementation should not invent branch/worktree behavior at call sites. The handoff should not run agents directly in the user's primary checkout. It should teach worktree-per-task by making the first submitted task create the first onboarding worktree.

1. Add or reuse the repo through the same repo IPC/store path as the existing add-repo dialog so `repo_added` semantics, duplicate suppression, authorized-root rebuilds, and SSH/local path handling stay centralized.
2. Fetch worktrees for the repo. If the repo already has Orca worktrees, open the most recently active one and focus the normal workspace composer. If there are no Orca worktrees yet, open a first-task composer bound to the repo but not to the primary checkout; no branch or worktree is created until the user submits a task.
3. On first-task submit, create one worktree from the default base-ref resolution path used by `createWorktree`, using the user's current `branchPrefix` and the display name `onboarding` unless the prompt-to-name helper derives a better bounded workspace name. This is the first visible worktree-per-task lesson: the user asked for a task, Orca creates an isolated workspace for it.
4. When creating a worktree, pass `telemetrySource: 'onboarding'` (add this enum value before emitting) and `from_existing_branch = false` unless the base-ref path explicitly chooses an existing local branch.
5. Respect existing setup-hook policy. If setup scripts are configured to run automatically, show progress in place; if setup fails, land in the worktree anyway with a recoverable warning and keep the composer focusable. Setup failure must not turn a successful repo add into a failed onboarding completion.
6. Open the workspace tab and focus the composer. If `defaultTuiAgent = 'blank'`, focus the agent picker; otherwise focus the task input with the selected agent visible. If the tab open fails after repo persistence, do not re-run clone/add on retry; offer "Open the repo in Orca" from the existing persisted repo.
7. Write `outcome = 'completed'`, `closedAt = Date.now()`, `lastCompletedStep = 4`, and emit `onboarding_completed` after the repo/folder is persisted and the destination surface is open. For git repos, this event means the wizard funnel completed, not full activation. Full D1 activation is counted only after the first post-onboarding `agent_started` fires from the onboarding repo/worktree within 24h.

---

## Activation checklist (post-wizard)

Persistent, dismissible panel in the right sidebar. Each item is tied to a product-state signal and mirrored by bounded telemetry, not self-report. Items adapt based on whether a git repo or plain folder was opened and whether an agent was detected during step 1.

**Code path (git repo):**

- [x] Add a repo *(just done)*
- [ ] Install or choose an agent *(only shown when step 1 wrote `defaultTuiAgent = 'blank'`; completes when an agent becomes detected or the user picks a concrete default agent)*
- [ ] Run your first agent task
- [ ] Open a second agent on the same task — *the aha: parallel orchestration*
- [ ] Try the jump shortcut — `⌘+J` on macOS, `Ctrl+Shift+J` on Windows/Linux
- [ ] Shape your sidebar — *unlocks after ≥3 worktrees exist; deep-links to the sidebar header's grouping/sort/card-property menu*
- [ ] Review a diff in Orca
- [ ] Open a PR from Orca

**Notes path (plain folder):**

- [x] Add a folder *(just done)*
- [ ] Open a file
- [ ] Install or choose an agent *(only shown when step 1 wrote `defaultTuiAgent = 'blank'`)*
- [ ] Run an agent on a file
- [ ] Try the jump shortcut — `⌘+J` on macOS, `Ctrl+Shift+J` on Windows/Linux

Each unchecked item has a "Show me" button that deep-links to the surface and drops a coach-mark on first visit.

Checklist collapses to a small progress pill when all items are complete; dismissible permanently via `×`.

### Checklist signal contract

Checklist state persists locally, but completion must be driven by explicit product signals so analytics and UI cannot drift. Add `activation_checklist_item_completed` only when the local boolean flips from false to true; never emit raw paths, repo names, branch names, prompt text, file names, URLs, or free-form errors.

| Checklist item | Completion signal | Notes |
| -------------- | ----------------- | ----- |
| `addedRepo` | `onboarding_completed` with `is_git_repo = true` or existing `repo_added` from the onboarding surface | Existing-user repo adds outside onboarding do not back-complete first-run onboarding. |
| `addedFolder` | `onboarding_completed` with `is_git_repo = false` | Folder-mode completion uses the same persisted `onboarding.checklist` block. |
| `choseAgent` | Step 1 wrote a concrete `defaultTuiAgent`, Agents settings later writes a concrete `defaultTuiAgent`, or `ensureDetectedAgents()` returns a non-empty set after a previous blank state | This item is hidden when the wizard already selected a concrete agent. |
| `ranFirstAgent` | First `agent_started` event whose launch source is `onboarding`, `new_workspace_composer`, `tab_bar_quick_launch`, or `workspace_jump_palette` after onboarding completion | This is the D1 activation moment for git users. Requires adding `onboarding` to `launchSourceSchema` if the handoff emits directly from onboarding. |
| `ranSecondAgentOnSameTask` | A second `agent_started` in the same repo/worktree context within 7 days of the first-agent checklist completion, with a different pane/tab id and a bounded local `activationTaskId` generated for the onboarding worktree | The local `activationTaskId` is a random id stored in app state; never derive it from prompt text, branch name, file path, or issue title. |
| `triedCmdJ` | Worktree jump palette opened by the platform shortcut (`⌘+J` on macOS, `Ctrl+Shift+J` on Windows/Linux) after onboarding completion | Opening by mouse does not complete this item. |
| `shapedSidebar` | User changes `groupBy`, `sortBy`, or `worktreeCardProperties` from the sidebar header after the item unlocks at ≥3 worktrees | Settings-pane changes can also complete it if the deep-link lands there in the future. |
| `reviewedDiff` | Diff/source-control view opened for an onboarding repo worktree after at least one changed file exists | Merely opening an empty diff panel should not complete it. |
| `openedPr` | Existing PR-open success path returns success for an onboarding repo/worktree | Emit only a bounded result enum; no PR URL. |
| `openedFile` | Editor opens any file from the folder added during onboarding | Store only the boolean. |
| `ranAgentOnFile` | `agent_started` after a file-context launch from the onboarding folder | Store only the boolean and bounded agent kind. |

---

## Data model

**Storage.** No new file. Add the `onboarding` block as a top-level field on the existing `PersistedState` in `src/main/persistence.ts`, which serializes to `orca-data.json` under Electron's `app.getPath('userData')`:


| Platform | Path                                                             |
| -------- | ---------------------------------------------------------------- |
| macOS    | `~/Library/Application Support/Orca/orca-data.json`              |
| Windows  | `%APPDATA%\Orca\orca-data.json`                                  |
| Linux    | `~/.config/Orca/orca-data.json` (or `$XDG_CONFIG_HOME/Orca/...`) |


Dev runs use `<appData>/orca-dev/` (`configure-process.ts:112`); E2E uses a per-suite override. Both inherit the same atomic temp-file+rename write path and the case-sensitive `Orca/` directory name (don't reintroduce the timing bug guarded by the comment at `persistence.ts:58-70`). Add the `onboarding` defaults to `getDefaultPersistedState` in `src/shared/constants.ts`, and merge persisted values into defaults in `Store.load()` with a dedicated deep merge for the checklist.

Add to top-level persisted state:

```ts
onboarding: {
  closedAt: number | null           // epoch ms; null = wizard never closed (fresh install or actively in progress)
  outcome: 'completed' | 'dismissed' | null  // null until the wizard ends
  lastCompletedStep: number         // sentinel: -1 = unstarted or closed before step completion; 1..4 = highest step the user finished
  checklist: {
    // Code path
    addedRepo: boolean
    choseAgent: boolean
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

Skipping a step on steps 1–3 writes the current default, not `null` — so skipping never leaves the app in an undefined state. If no agent is detected/selected on step 1, the current default is `defaultTuiAgent = 'blank'`, not `null`, because `null` currently means auto-select. Skipping on step 4 is *dismiss* (no repo to write; see §Flow), sets `closedAt`, and never re-shows the wizard automatically.

**Resume vs. dismiss vs. fresh.** Three states, one sentinel-plus-flag scheme:

- *Fresh install:* `lastCompletedStep = -1`, `closedAt = null`, `outcome = null`. Show the wizard from step 1; do **not** fire `resumed_from_step`. This state is also reached when `orca-data.json` doesn't exist (first launch ever) or exists but lacks an `onboarding` block (treat as fresh) — except for the existing-user backfill below.
- *In progress (user quit/crash mid-wizard):* `lastCompletedStep ∈ 1..3`, `closedAt = null`, `outcome = null`. On next launch, resume at `lastCompletedStep + 1` and fire `onboarding_started` with `resumed_from_step = lastCompletedStep`. App quit is not a terminal state; the user has not explicitly dismissed onboarding.
- *Closed:* `closedAt !== null`. Never re-show, regardless of `lastCompletedStep`. `outcome` records why (`completed` = success on step 4, `dismissed` = explicit close / step-4 skip).

The resume gate is therefore: `closedAt === null && lastCompletedStep > 0`. Fresh installs (`lastCompletedStep === -1`) fall through to the from-scratch branch.

---

## Telemetry


| Event                                 | When                            | Properties                                          |
| ------------------------------------- | ------------------------------- | --------------------------------------------------- |
| `onboarding_started`                  | first render of step 1          | `resumed_from_step?: number`                        |
| `onboarding_step_viewed`              | step mount                      | `step: 1..4`                                        |
| `onboarding_step_completed`           | `Next` click w/ valid value     | `step`, `value_kind`, optional bounded enum value   |
| `onboarding_step_skipped`             | `Skip` click                    | `step`                                              |
| `onboarding_step4_path_clicked`       | tile click / drop               | `path: open_folder \| clone_url`                    |
| `onboarding_step4_path_failed`        | clone/open error                | `path`, `reason: ssh_auth \| timeout \| cancelled \| invalid_path \| unknown` |
| `onboarding_completed`                | step 4 success                  | `path`, `is_git_repo: boolean`, `total_duration_ms` |
| `onboarding_dismissed`                | explicit close / step-4 skip    | `last_step`                                         |
| `activation_checklist_item_completed` | item-specific telemetry fires   | `item`, `time_since_completed_ms`                   |


**Strict telemetry registry requirement.** As of this design pass, the current telemetry registry in `src/shared/telemetry-events.ts` accepts `app_opened`, `repo_added`, `workspace_created`, `agent_started`, `agent_error`, `settings_changed`, `telemetry_opted_in`, and `telemetry_opted_out`; it does not yet accept onboarding events. Implementation must add the onboarding schemas to that file before emitting them. The schemas must stay Zod-first, `.strict()`, and enum-bounded: no raw file paths, clone URLs, repo names, prompt text, or free-form error strings. Reuse existing closed enums where they fit, such as the telemetry agent-kind mapping, and add new closed enums for onboarding path, failure reason, outcome, and checklist item. Also add `onboarding` to `workspaceSourceSchema` before using it as `createWorktree` telemetry source, and to `launchSourceSchema` before attributing an `agent_started` event directly to the onboarding handoff.

**The single number we're optimizing for:** `D1 activation rate` = `% of new installs that add a repo/folder and start their first relevant agent task within 24h of first launch`. For git users, this means `onboarding_completed` plus `ranFirstAgent`; for plain-folder users, this means `onboarding_completed` plus `ranAgentOnFile`. Secondary: `% who hit "Open a second agent on the same task"` within 7 days (the parallel-orchestration aha). `onboarding_completed` alone is wizard completion, not activation. All other events exist to debug those two.

---

## How the wizard teaches the mental model

The teaching mechanism is the *live preview pane*, not copy. Each step maps to a concrete visual:

- Step 1 (Default agent) — an agent being assigned to a task.
- Step 3 (Notifications) — a background agent firing a notification, demonstrating async execution.
- Post-wizard sidebar coach-mark — fires on first landing in a worktree; teaches worktree-per-task and the grouping/sort/card affordances at the moment they're legible (the user has a real worktree to look at).
- Checklist — closes the loop with "Open a second agent on the same task — *the aha: parallel orchestration*."

Step 2 (theme) and step 4 (add repo) don't teach mental model by themselves; they remove friction and set up the first task, where the worktree-per-task lesson happens.

## Resolved (was: open) decisions

- **SSH clone hangs** — fail fast on SSH auth/passphrase prompts, SSH auth errors, or &gt;5s idle before first progress/output → abort + cleanup + fallback UI pointing to "Open a folder." Do not fail active clones merely because total elapsed time exceeds 5s. We don't try to PTY-capture passphrase prompts in the wizard.
- **Resume mid-wizard** — see §Data model. Resume gate: `closedAt === null && lastCompletedStep > 0`. Fresh installs (`lastCompletedStep === -1`) start from step 1, not "resume."
- **Existing users** — distinguish "no `onboarding` block because pre-onboarding build" from "no `onboarding` block because fresh install" using the same signal `Store.load()` already captures: `fileExistedOnLoad` (`persistence.ts:118`). If `orca-data.json` existed before this load *and* has no `onboarding` block, backfill `closedAt = installDate` (or `Date.now()` if install date isn't known), `outcome = 'completed'`, `lastCompletedStep = 4`. If the file didn't exist, treat as fresh. Surface new affordances via a one-shot "What's new" modal, not a forced re-onboarding.

## Still open

- **Agent detection cost** — `ensureDetectedAgents()` needs measurement with the full `TUI_AGENT_CONFIG` set. Target &lt;200ms total once PATH is hydrated. If it exceeds, keep detection lazy on step-1 mount and show a 200ms shimmer rather than blocking app launch. macOS `PATH` is hydrated by `src/main/startup/hydrate-shell-path.ts`.
- **Sample repo** — no longer a wizard tile (see step 4). Still needed on the post-wizard empty-state home as a fallback for users who opened an empty folder. Does an Orca-owned sample exist? If not, propose `orca-build/orca-sample`. Contents requirement remains: a `README.md` with two suggested agent prompts, a real bug/TODO an agent can fix in &lt;60s, and a passing test suite. Owner needed.
- **Checklist persistence across machines** — if a user installs Orca on a second machine, do we re-show the checklist? Lean: yes, keyed per-install, since shortcuts and surfaces are machine-local muscle memory.
