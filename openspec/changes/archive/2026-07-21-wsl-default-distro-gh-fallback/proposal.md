## Why

On Windows hosts, if a user only installs the GitHub CLI (`gh`) or GitLab CLI (`glab`) inside a WSL (Windows Subsystem for Linux) distro and lacks the host executable (`gh.exe` / `glab.exe`), global CLI commands (which lack a repository `cwd` to derive a WSL context) fail with `ENOENT`. This is because they currently attempt host execution and fall back to the first WSL distro returned by the `wsl --list` command, which might not be the distro containing the user's CLI installations or configurations, leading to errors or missing command failures.

## What Changes

- Introduce a setter/getter mechanism to override the default WSL distro used for host command fallbacks.
- Update `resolveDefaultWslCli` in `src/main/git/runner.ts` to prioritize the overridden default WSL distro over the first listed WSL distro.
- Wire the initialization and updates of the overridden default WSL distro to follow `terminalWindowsWslDistro` from the global `Store` settings in `src/main/index.ts`.

## Capabilities

### New Capabilities
- `wsl-default-distro-gh-fallback`: Pins the fallback WSL distro for global cli command executions (like `gh` / `glab`) to match the user's `terminalWindowsWslDistro` preference.

### Modified Capabilities

## Impact

- `src/main/git/runner.ts`: Add `setDefaultWslDistroOverride(distro: string | null)` and update `resolveDefaultWslCli`.
- `src/main/index.ts`: Update `setDefaultWslDistroOverride` with initial setting at startup and hook it to settings changes.
