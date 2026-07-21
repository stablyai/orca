## Context

On Windows hosts, if a user only installs the GitHub CLI (`gh`) or GitLab CLI (`glab`) inside a WSL (Windows Subsystem for Linux) distro and lacks the host executable (`gh.exe` / `glab.exe`), global CLI commands fail with `ENOENT`.
Currently, the system falls back to the first WSL distro returned by the `wsl --list` command, which might not be the distro containing the user's CLI installations or credentials. We need to allow routing these global calls through the user-pinned WSL distro configured in `Store`'s settings.

## Goals / Non-Goals

**Goals:**
- Connect the default fallback WSL distro for global cli commands to the user-pinned `terminalWindowsWslDistro` setting.
- Ensure dynamic updates when the user changes settings.
- Avoid introducing circular dependencies in `runner.ts` (so `runner.ts` must not directly import the settings store).

**Non-Goals:**
- Automatically installing `gh` or `glab` in WSL.
- Altering the WSL routing of commands that run inside a specific worktree / directory (those already carry correct `wslDistro` options).

## Decisions

### 1. In-Memory Setter for defaultWslDistroOverride in runner.ts
We will expose a setter function `setDefaultWslDistroOverride` in [runner.ts](file:///C:/Github/orca/src/main/git/runner.ts) which saves the override in a local variable. `resolveDefaultWslCli` will prioritize this variable over `getDefaultWslDistro()`.
- **Alternatives Considered**: 
  - Importing `persistence` directly in `runner.ts`: Rejected because it introduces circular dependencies since `persistence` and other services import git/runner helpers.
  - Passing `settings` through options on every global call: Rejected because global CLI calls are initiated from various parts of the codebase (e.g. enterprise host status check, user discovery) and updating all call sites is highly intrusive and error-prone.

### 2. Main Process Initialization and Subscription in index.ts
We will wire the initial setting application and listen to configuration updates in the main entry point [index.ts](file:///C:/Github/orca/src/main/index.ts).
- **Alternatives Considered**:
  - Wiring it inside `persistence.ts`: Rejected as main process lifecycle is managed in `index.ts` and settings/menu syncs are standardly registered there.

## Risks / Trade-offs

- **Risk**: Pinned WSL distro is not running or takes time to start.
  - **Mitigation**: Standard `wsl.exe` command execution already handles launching of the distro if it's currently stopped, matching existing behavior.
