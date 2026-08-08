# VS Code WSL Workspace Launch

## Problem

On Windows, choosing **Open in VS Code** for a workspace stored under a WSL UNC path opens the folder in a Windows VS Code environment instead of a Remote - WSL window ([issue #7649](https://github.com/stablyai/orca/issues/7649)). The renderer passes the workspace path and configured editor command unchanged (`src/renderer/src/components/sidebar/WorktreeOpenInMenu.tsx:103-121`), and the main process delegates launch argument construction to `resolveExternalEditorLaunchSpec` (`src/main/ipc/shell.ts:101-110`). The builder currently gives every non-Cursor executable only the original path (`src/main/external-editor-launch.ts:109-116`).

The deterministic reproduction for `\\wsl.localhost\Ubuntu\home\aliuq\project` produces `code <UNC path>` with no remote authority. VS Code's supported Windows CLI form is `code --remote wsl+<distro> <Linux path>`.

## Root cause

`resolveExternalEditorLaunchSpec` does not distinguish a VS Code launch targeting a WSL UNC workspace. Orca already has a shared parser for both modern `\\wsl.localhost\...` and legacy `\\wsl$\...` paths (`src/shared/wsl-paths.ts:1-20`), but the editor launcher never uses it. VS Code therefore receives the Windows-visible UNC folder and correctly opens it as a local Windows workspace.

## Non-goals

- Change the Open in menu, settings UI, IPC payload, file-manager behavior, or SSH/remote-runtime behavior.
- Infer WSL identity for ordinary drive-letter paths from project runtime settings.
- Rewrite user-defined compound shell commands or add remote flags to Cursor, VSCodium, or arbitrary editors.
- Install or configure the VS Code WSL extension.

## Design

1. In the external-editor launch-spec builder, parse the target path with the shared WSL UNC parser when the host platform is Windows.
2. For direct/executable VS Code Stable or Insiders launchers only, reuse the existing normalized launcher-basename check and translate a recognized WSL target into `['--remote', 'wsl+<distro>', '<linuxPath>']`. The exact allowlist recognizes Stable's `code`, Insiders' `code-insiders`, and the direct `Code - Insiders.exe` basename without matching unrelated `code-*` editors. Matching is case-insensitive and strips every Windows launcher suffix already supported by Orca (`.cmd`, `.exe`, and `.bat`).
3. Keep local paths, non-Windows hosts, non-VS-Code applications, and compound commands on their existing argument paths. The existing main-process spawn and Windows shim handling remain unchanged.
4. Replace the temporary reproduction harness with focused regression cases in `src/main/external-editor-launch.test.ts` covering modern and legacy WSL UNC forms plus unaffected local/custom-editor behavior.

## Data flow

- Worktree menu selects VS Code and sends `(workspacePath, 'code')` over existing IPC.
- Main process validates the absolute existing host path.
- Launch-spec builder resolves the VS Code executable.
- On Windows + WSL UNC + VS Code, the builder emits the Remote - WSL authority and Linux-native folder path.
- Existing Windows spawn wrapping launches VS Code with those arguments.

## Edge cases

- Modern `\\wsl.localhost\<distro>\...` and legacy `\\wsl$\<distro>\...` paths both preserve the distro spelling and convert separators to a POSIX path.
- Distro names and Linux folder paths containing spaces remain single arguments because launch-spec construction and Windows shim wrapping preserve argument-array boundaries.
- A WSL distro root maps to `/`.
- Windows drive-letter and ordinary UNC paths stay local.
- macOS/Linux behavior stays unchanged even for strings that resemble WSL UNC paths.
- Cursor retains `--new-window`; other custom editors retain their existing single path argument.
- Compound commands remain user-owned and are not rewritten because inserting flags safely would require parsing arbitrary shell syntax.
- SSH and remote-runtime workspaces remain blocked from local path opening by the existing renderer guard; this change does not alter that boundary.
- If the VS Code WSL extension is unavailable, launch behavior is left to VS Code and Orca retains its existing spawn-success contract.

## Test plan

- Unit: demonstrate the pre-fix launch spec lacks `--remote` for a modern WSL UNC path.
- Unit: assert the fixed modern UNC launch is `--remote`, `wsl+Ubuntu`, `/home/...`.
- Unit: assert legacy `\\wsl$` and distro-root paths produce the same Remote - WSL form.
- Unit: assert direct and resolved Windows VS Code Stable and Insiders launchers are matched case-insensitively across `.exe`, `.cmd`, and `.bat` suffixes.
- Unit: assert distro names and Linux folder paths containing spaces remain intact arguments through launch-spec construction and Windows shim forwarding.
- Unit: assert a Windows local path remains unchanged and explicit `darwin` and `linux` hosts do not acquire WSL remote arguments.
- Unit: assert Cursor and another custom editor are not given VS Code remote arguments.
- Integration/Electron: create a throwaway repo in the installed Ubuntu WSL distro, add/open it in Orca, choose Open in VS Code, and verify the VS Code remote indicator and an integrated-terminal Linux probe.
- Adjacent smoke: open a local Windows workspace in VS Code and verify it remains a local Windows window.
- Repository gates: focused Vitest files, `pnpm typecheck`, `pnpm lint`, and `pnpm check:max-lines-ratchet`.

## UI quality bar

Not UI-visible in Orca. The existing menu, labels, loading behavior, and errors do not change. The user-visible acceptance criterion is external: the launched VS Code window must identify the selected WSL distro and its terminal must run Linux.

## Review screenshots

1. Golden path: VS Code opened from a throwaway WSL workspace, showing the Remote - WSL indicator and a terminal Linux probe.
2. Adjacent local path: VS Code opened from a local Windows workspace, showing a local Windows terminal/environment.

## Rollout

1. Add launch-spec regression tests and observe the WSL case fail against the desired arguments.
2. Add the scoped VS Code + Windows + WSL argument translation.
3. Run focused and repository-wide static/test gates.
4. Validate WSL and local launches end to end, retaining local screenshots outside the PR.

## Lightweight Eng Review

- Scope: Kept to the launch-spec seam; no renderer, IPC, persistence, runtime-routing, or settings changes are needed because WSL filesystem identity is encoded in the UNC path.
- Architecture/data flow: Reuse `parseWslUncPath` in the main-process pure argument builder, then leave executable resolution, Windows shim wrapping, spawn lifecycle, and renderer guards unchanged.
- Failure modes covered:
  - Modern and legacy WSL UNC aliases route to the correct distro and Linux path.
  - Local/ordinary UNC paths and non-Windows platforms do not acquire remote flags.
  - Case variants and supported Windows VS Code shim suffixes are recognized without classifying custom editors or compound shell commands as VS Code.
  - Distro and folder names containing spaces survive the Windows shim as distinct arguments.
  - Missing VS Code WSL support still follows the existing launch contract rather than adding a new partial-failure protocol.
- Test coverage required:
  - Pure launch-spec regression cases in `src/main/external-editor-launch.test.ts` for WSL aliases/root, launcher case/suffix variants, and unaffected branches.
  - `src/main/ipc/shell.test.ts` plus the existing Windows shim contract to prove remote arguments, including spaces, are forwarded as distinct values.
  - Live Windows + Ubuntu WSL + VS Code smoke for the actual environment boundary.
- Performance/blast radius: One regex parse per external-editor click only; no startup, polling, watcher, terminal, or renderer cost. Blast radius is limited to direct VS Code launches of WSL UNC paths on Windows.
- UI quality bar: Not UI-visible in Orca; VS Code must visibly attach to the requested WSL distro and run a Linux terminal.
- Required review screenshots:
  1. WSL VS Code window with distro indicator and Linux terminal probe.
  2. Local Windows VS Code window demonstrating unchanged local launch behavior.
- Residual risks: VS Code without the WSL extension may reject or prompt on the valid remote launch; this is external dependency behavior and should not cause Orca to fall back silently to the wrong Windows environment.
