# Orca fork: NBarger96/orca_fork

This repository is a personal fork of [`stablyai/orca`](https://github.com/stablyai/orca). It adds a small number of patches on top of upstream `main`. Keep the patches small, so that a rebase onto upstream has few conflicts.

Tracking: Feature [#1](https://github.com/NBarger96/orca_fork/issues/1) and its slices #2 (peek), #3 (fork build, this file) and #4 (upstream feature request).

## Patches

### 1. Peek: a live, read-only terminal view on hover over a sidebar agent row (#2)

Hold the pointer on an agent row in a sidebar workspace card for about 400 ms. A card opens beside the row with a live, read-only view of that agent's terminal. The card closes when the pointer leaves the row and the card, and the stream then disconnects. The real PTY keeps its columns and rows, and no keystroke reaches the agent from the card.

| File                                                                                              | What the patch does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/dashboard-popout/AgentTerminalPreview.tsx`                           | Adds two optional props, both default `true`, so the Agent Dashboard dialog does not change. `claimGrid={false}`: the preview makes no grid claim, so it never calls the terminal-preview `fit` API and shows the PTY's current grid scaled into the box. `interactive={false}`: the one `sendInput` gate drops every byte (keys, paste, IME, right-click paste, link actions), and the preview skips `terminal.focus()`.                                                                                                                                                         |
| `src/renderer/src/components/sidebar/workspace-card/activity/agent-row-terminal-peek.tsx`         | New `AgentRowTerminalPeek`. A controlled shadcn `HoverCard` that opens after a 400 ms dwell. A capture-phase window `wheel` listener restarts the dwell, so a wheel scroll opens no card. A press on the row cancels the dwell and closes the card. At open it resolves the PTY id with `getPtyIdForPaneKey`, and mounts `AgentTerminalPreview` with `claimGrid={false}` and `interactive={false}` only while the card is open. Card size `h-72 w-[480px]`. It keeps the content through the exit animation, and on close it returns focus to the element that had focus at open. |
| `src/renderer/src/components/dashboard/DashboardAgentRow.tsx`                                     | The full-mode sidebar agent row wraps itself in `AgentRowTerminalPeek`. Its only renderer is the sidebar, so the Agent Dashboard gets no peek.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/renderer/src/components/sidebar/workspace-card/activity/worktree-card-compact-agent-row.tsx` | The compact agent row and subagent child rows wrap themselves in `AgentRowTerminalPeek`. Removes the row-line native `title` tooltip, which painted over the open card.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/renderer/src/components/dashboard-popout/AgentTerminalPreview.test.tsx`                      | Test: a non-interactive preview sends no typed key or paste to the PTY and takes no focus. The test harness is typed without type assertions.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/renderer/src/components/dashboard-popout/AgentTerminalPreview.settings-geometry.test.tsx`    | Test: with `claimGrid={false}`, the preview never calls `fit` after connect or a box resize.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

File list source: `git diff --stat main...HEAD` after the #2 merge.

#### Deviations from the #1 design text

1. **No PTY id opens the card with the "unavailable" message.** The design said "If the resolver returns no PTY id, the peek does not open". The acceptance criterion says an exited PTY shows the existing "unavailable" message, and the resolver returns no id for an exited PTY. The acceptance criterion wins (coordinator decision, option A). The card connects no stream in this case.
2. **`interactive={false}` also skips `terminal.focus()`.** The design named only input. Without this, a peek takes keyboard focus from the user's terminal.
3. **Each row peeks `activationPaneKey ?? paneKey`.** Only subagent child rows set `activationPaneKey` (`worktree-subagent-child-rows.ts`). A child row's own pane key does not parse as a pane, so a child row peeks the parent pane that a click on the row activates. Other rows peek their own `paneKey`.
4. **Native tooltips.** The row-line native `title` tooltip is removed on compact rows (main row and subagent child rows). The icon, model, dot and disabled-reason tooltips stay. Full-mode `DashboardAgentRow` keeps its root `title`, which is the only place that shows the started and done times, and its label `title`.

### 2. Updater guard: a fork build never runs the auto-updater (#3)

A packaged build checks the upstream release feed, and the next upstream release replaces the fork build. A build made with `MAIN_VITE_ORCA_FORK_NO_AUTO_UPDATE=1` acts like an unpackaged run for the updater: no background check, no update nudge, no check on wake or focus, and a menu check reports "not available". The switch is read at build time: electron-vite substitutes `import.meta.env.MAIN_VITE_*` into the main bundle, so the installed app does not need the variable. Without the variable, the updater behaves as upstream.

| File                                                       | What the patch does                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/updater/fork-auto-update-switch.ts`              | New `runsAutoUpdater()`: `false` for an unpackaged run (upstream behavior) and for a build with the switch set. The first time the switch blocks the updater, it writes `[updater] Fork build: auto-update is off (MAIN_VITE_ORCA_FORK_NO_AUTO_UPDATE=1)` to the console.                                                          |
| `src/main/updater/lifecycle/updater-setup.ts`              | The `app.isPackaged` gate in `setupAutoUpdater` calls `runsAutoUpdater()`. This stops the feed URL setup, the background check, nudges and the wake and focus checks. The updater then stays uninitialized, so a remote-server update check is refused with the support reason `updater-unavailable` (`updater-remote-status.ts`). |
| `src/main/updater/lifecycle/updater-menu-checks.ts`        | The `app.isPackaged` gate in `checkForUpdatesFromMenu` calls `runsAutoUpdater()`. This stops menu checks and pinned-build and local-build checks.                                                                                                                                                                                  |
| `src/main/updater/updater.fork-auto-update-switch.test.ts` | Test: in a packaged build with the switch set, setup and menu checks set no feed URL, call no `checkForUpdates`, read no release feed and register no wake handler.                                                                                                                                                                |

Not guarded: the release-build list in the update-channel settings still reads the GitHub releases API when the user opens that list. It is a user action that only lists builds. A pick from the list goes through the guarded menu check.

## Build a packaged Windows build

This is a manual step. On the maintainer's machine, ThreatLocker denies pnpm 12's native `pnpm.exe`, the esbuild postinstall and Electron, so no agent has built the package. The build time on this machine is not measured.

Prerequisites (from `.github/CONTRIBUTING.md` and `docs/development.md`):

- Node 24.
- pnpm at the version in `package.json` `packageManager` (12.14.0 at the time of writing). If `corepack enable` fails with `EPERM`, run `npm install -g pnpm@12.14.0`.
- Bun at the version in `config/.bun-version` (1.4.4 at the time of writing).
- Python 3 and Visual Studio Build Tools with the "Desktop development with C++" workload.
- If ThreatLocker runs on the machine: an approval for pnpm, esbuild, Electron, electron-builder and the native module builds. If a step is blocked, record the step and the error in this file.

Steps, in PowerShell, at the repository root:

1. Check out the fork branch to build, for example `git switch main` after the fork patches are merged.
2. Run `git status`. Make sure that the tree is clean.
3. Run `pnpm install`. This compiles the native modules and applies the patched dependencies in `config/patches/` (listed in `pnpm-workspace.yaml` under `patchedDependencies`, which includes the patched xterm addons).
4. Run `$env:MAIN_VITE_ORCA_FORK_NO_AUTO_UPDATE = '1'`. Keep this PowerShell window open for steps 5 to 8. If you open a new window, set the variable again.
5. Run `pnpm run build:release`. This builds the WSL guest, the Windows native helpers, the CLI, the Electron bundles, the web client and the mobile web bundle.
6. Run `Get-ChildItem out\main -Recurse -Filter *.js | Select-String -SimpleMatch 'Fork build: auto-update is off' -List`. Expect at least one match. If there is no match, the switch did not reach the build: do steps 4 and 5 again.
7. Run `pnpm run ensure:electron-runtime`.
8. Run `pnpm exec electron-builder --config config/electron-builder.config.cjs --win --publish never`. The build is unsigned. Never publish it.
9. Expect `dist\orca-windows-setup.exe` (installer) and `dist\win-unpacked\Orca.exe` (unpacked app).
10. Record the build time and any blocked step in this file.

### Check the build

1. Run `dist\orca-windows-setup.exe`, or start `dist\win-unpacked\Orca.exe`.
2. To see the updater log, start the unpacked app with its output redirected: `Start-Process dist\win-unpacked\Orca.exe -RedirectStandardOutput $env:TEMP\orca-fork-out.txt -RedirectStandardError $env:TEMP\orca-fork-err.txt`. Then run `Select-String -Path $env:TEMP\orca-fork-*.txt -SimpleMatch '[updater]'`. Expect `[updater] Fork build: auto-update is off (MAIN_VITE_ORCA_FORK_NO_AUTO_UPDATE=1)` and no other updater check line. Not verified: that Electron writes main-process console output to a redirected handle on Windows.
3. Select "Check for Updates..." in the app menu or tray menu. Expect the "not available" result, with no download.
4. Optional: watch the network with a proxy or Resource Monitor. Expect no request to `github.com/stablyai/orca/releases/latest/download/latest.yml` or `github.com/stablyai/orca/releases.atom`.
5. Do the peek checks of #2 in this build. Open a workspace with a running agent, for example Claude Code, and make it print output (for example, ask it to count from 1 to 30 with a one-second pause).
   1. Hold the pointer still on the agent's sidebar row. Expect a card after about half a second, with the agent's terminal and new output that appears while you watch.
   2. Keep the card open for 10 seconds while the agent's real tab is wide. Expect no reflow in the real tab: lines do not wrap at a narrower width. The card shows the full-width grid scaled down.
   3. With the pointer over the card, type `abc` and press Enter. Click in the card, press Ctrl+V and right-click. Expect no text at the agent's prompt.
   4. Scroll the sidebar with the mouse wheel for 3 seconds over agent rows. Expect no card. Stop on a row and hold. Expect a card after about half a second.
   5. Click an agent row. Expect the agent's tab to become active. Hold the pointer on the workspace header. Expect the workspace details card as before.
   6. Hold the pointer on the row of an agent whose terminal has exited. Expect a card with the "No preview available" message and no terminal view.

## Rebase onto upstream `main`

1. Add the upstream remote once: `git remote add upstream https://github.com/stablyai/orca.git`.
2. Run `git fetch upstream`.
3. Make sure that the tree is clean (`git status`). Make a backup branch: `git branch backup/pre-rebase-<date>`.
4. Run `git rebase upstream/main` on the fork branch.
5. If there is a conflict, resolve it with the patch tables above as the reference. The likely conflicts are in `AgentTerminalPreview.tsx` (upstream changes it often) and in the two updater gate lines. If upstream renames or moves the `app.isPackaged` gates in `updater-setup.ts` or `updater-menu-checks.ts`, move the `runsAutoUpdater()` call to the new gates, then run `rg -n "app.isPackaged" src/main/updater` to find any new check entry point. These ungated hits are expected, because they are reached only after a guarded gate or only report status: `nudges/updater-nudge.ts`, `releases/updater-build-selection.ts`, `lifecycle/updater-remote-status.ts`, `lifecycle/updater-scheduling.ts` and `linux-package/linux-update-package-type.ts`. Treat any other new hit as a check path that needs `runsAutoUpdater()`.
6. Run the patch tests: `pnpm test src/renderer/src/components/dashboard-popout src/main/updater/updater.fork-auto-update-switch.test.ts --maxWorkers=2`.
7. Run `pnpm tc` and `pnpm check:changed`.
8. Push the fork branch with `git push --force-with-lease origin <branch>`.
9. Build again (section "Build a packaged Windows build"), and update the patch tables in this file if a file moved.
10. If upstream ships a peek (see the feature request drafted in #4), drop patch 1 and keep patch 2.
