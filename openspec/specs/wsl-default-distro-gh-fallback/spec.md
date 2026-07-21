# wsl-default-distro-gh-fallback Specification

## Purpose
TBD - created by archiving change wsl-default-distro-gh-fallback. Update Purpose after archive.
## Requirements
### Requirement: Pin Fallback Distro to Preference
The system MUST route global CLI command executions (such as rate limits and project discovery) through the user-pinned `terminalWindowsWslDistro` setting if host executables are missing and a WSL environment is available.

#### Scenario: Fallback executes in pinned WSL distro
- **WHEN** the host GitHub CLI executable is missing, and the user has set `terminalWindowsWslDistro` to `Ubuntu`
- **THEN** global gh commands SHALL fall back to and execute inside the `Ubuntu` WSL distro.

