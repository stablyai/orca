# Niubash terminals

[Niubash](https://github.com/unixwin/niubash) is a native Bash-compatible shell, not an
AI agent. Its executable is `niu.exe` on Windows and `niu` on macOS/Linux. Install it
separately and add its directory to the execution host's `PATH`; Orca does not bundle
or install Niubash.

## Windows

- Open the new-terminal menu and choose **Niubash** when Orca detects it.
- To make it the default, open **Settings → Terminal → Windows Shell → Niubash**.
  This affects new panes only. Initial Windows setup also offers the detected shell.
- From the Orca CLI, use `orca terminal create --help` for workspace arguments and
  pass `--shell niu` (or `--shell niu.exe`). `--command niu` would instead start it
  inside the default shell.

Orca launches an interactive Niubash process directly in the workspace directory.
It uses POSIX command quoting but preserves native Windows paths and the
semicolon-separated `PATH`; it never sends Niubash through Git Bash's MSYS wrappers
or `cygpath`. Your `~/.niubashrc` remains Niubash's own configuration.

Windows setup scripts without a shebang remain batch scripts. Shell setup scripts
run through Niubash with native paths rather than Git Bash's `/c/...` spelling.

## macOS and Linux

Set the existing default-shell path setting to your installed `niu` executable, or
use it as your account's shell. Orca's shell-profile discovery includes Niubash when
it is on `PATH`. Windows-specific shell choices are not shown on these hosts.

## Remote execution and compatibility

Availability belongs to the execution host, not the client desktop. Install Niubash
on each host that needs it. The remote capability response has an optional
`niubashAvailable` field; older hosts without Niubash discovery retain their existing
shell choices. Local Windows shell preferences never override SSH command quoting.
Windows Niubash is not offered for WSL-only projects.

This is terminal-shell support, not a new agent integration. It does not add
Niubash-specific agent hooks or promise Bash-specific Orca shell wrappers work under
Niubash. Those wrappers are not injected into Niubash.
