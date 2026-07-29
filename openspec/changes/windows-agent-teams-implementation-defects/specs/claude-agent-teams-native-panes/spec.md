## ADDED Requirements

### Requirement: Windows is a supported runtime for native teammate panes

Agent detection SHALL report Claude Agent Teams as available on Windows when its required commands are present, and the launch plan SHALL use native-panes mode rather than the in-process fallback. WSL SHALL remain unsupported, because the tmux shim calls back into the host Orca process and a WSL-side CLI cannot reach it.

#### Scenario: Detection on Windows with the agent CLI present
- **WHEN** detection runs on Windows and both the Orca CLI and the Claude CLI resolve on PATH
- **THEN** Claude Agent Teams is reported as installed

#### Scenario: Detection on Windows without the agent CLI
- **WHEN** detection runs on Windows and only the Orca CLI resolves
- **THEN** Claude Agent Teams is not reported, because the Orca shim alone does not constitute an agent

#### Scenario: Detection under WSL
- **WHEN** detection runs in a WSL runtime
- **THEN** Claude Agent Teams is not reported and no probe commands are issued

#### Scenario: Native panes launch plan on Windows
- **WHEN** the platform is Windows, the mode is native-panes, and the command is a direct Claude invocation
- **THEN** the plan sets `--teammate-mode auto` and the environment carries `TMUX` and `TMUX_PANE`

### Requirement: The launch environment preserves the caller's inherited PATH

The team launch environment SHALL read `PATH` regardless of the key casing the calling process used, and SHALL write it back under that same key. Native Windows processes expose `Path`; POSIX shells expose `PATH`. Reading only `PATH` discards the inherited value, and writing `PATH` when the child already carries `Path` leaves two keys whose precedence is undefined.

#### Scenario: Caller sends the Windows-cased key
- **WHEN** the caller supplies its environment with `Path` set
- **THEN** the returned environment exposes a single PATH-like key named `Path`, containing the shim directory followed by every inherited entry

#### Scenario: Caller sends the POSIX-cased key
- **WHEN** the caller supplies its environment with `PATH` set
- **THEN** the returned environment exposes a single PATH-like key named `PATH`, containing the shim directory followed by every inherited entry

#### Scenario: The agent CLI remains launchable
- **WHEN** a teammate is spawned using the returned environment
- **THEN** the agent CLI resolves on the composed PATH and does not fail with a missing-executable error

### Requirement: The launched agent receives an interactive terminal

On Windows the agent SHALL be launched such that its standard input is a TTY. The Orca CLI executes inside Electron-as-node, which presents stdout and stderr as TTYs but not stdin; an interactive agent inheriting that stdin stays alive without ever becoming interactive or producing output.

#### Scenario: Launching on Windows
- **WHEN** Claude Agent Teams is launched on Windows
- **THEN** the agent is started directly by the terminal rather than through the Orca CLI wrapper, and its command carries `--teammate-mode auto` so the native-panes intent is explicit in the command itself

#### Scenario: Launching on macOS or Linux
- **WHEN** Claude Agent Teams is launched on macOS or Linux
- **THEN** the existing Orca CLI launch command is unchanged

### Requirement: The Windows shim forwards argv faithfully to the dispatcher

The compiled `tmux.exe` shim SHALL invoke the Orca CLI with the `agent-teams-tmux` subcommand as the first argument, followed by its own arguments byte-for-byte, and SHALL NOT include its target's program name among those arguments. It SHALL NOT emit any response of its own; `tmux -V` is answered by the dispatcher.

Byte-for-byte fidelity is guaranteed for a **direct executable target**, which is what the packaged path resolves to. A **batch target** (`orca.cmd`, `orca-dev.cmd` — the dev path) must go through `cmd.exe`, which parses the command line a second time. Two constructs survive every quoting cmd accepts, so the shim SHALL refuse them there rather than forward something it cannot represent:

- an argument containing a **line break**, because cmd ends the command at a newline;
- an argument containing a **`%NAME%` environment reference**, because cmd expands it *after* quoting and the substituted value is re-parsed — a variable whose value contains a quote or an operator therefore escapes the quoted region entirely. Refusal is keyed on the `%NAME%` shape, not on whether the variable is currently defined, so the verdict does not depend on the environment the child inherits.

Everything else SHALL arrive unchanged on both paths, including `&`, `|`, `<`, `>`, `^`, `(`, `)`, embedded quotes, spaces, a bare trailing `%`, and tmux's own `%1`/`%99` pane ids — which are not variable references.

#### Scenario: Subcommand dispatch
- **WHEN** the shim is invoked with any tmux arguments
- **THEN** the CLI receives `agent-teams-tmux` as its first argument and dispatches to the tmux compatibility handler

#### Scenario: Arguments containing shell metacharacters, direct executable target
- **WHEN** the shim is invoked against an `.exe` target with arguments containing `&`, `|`, `>`, `^`, `%`, quotes or embedded spaces
- **THEN** each argument arrives unchanged and none is interpreted as a shell operator

#### Scenario: An embedded quote cannot start a new command on the batch path
- **WHEN** the shim is invoked against a `.cmd` target with an argument containing a double quote followed by `&` and a further command
- **THEN** the quote arrives as a literal character, no second command runs, and the argument list is unchanged — CRT-style `\"` escaping is not sufficient here because `cmd.exe` does not honour it (BatBadBut, CVE-2024-24576)

#### Scenario: A line break is refused on the batch path
- **WHEN** the shim is invoked against a `.cmd` target with an argument containing a carriage return or newline
- **THEN** the shim exits non-zero with a message naming line breaks, rather than letting `cmd.exe` execute the remainder as a separate command

#### Scenario: An environment reference is refused on the batch path
- **WHEN** the shim is invoked against a `.cmd` target with an argument containing `%NAME%`
- **THEN** the shim exits non-zero naming `%NAME%`, rather than letting cmd substitute a value whose contents are then re-parsed as command syntax

#### Scenario: Pane ids and bare percents still pass on the batch path
- **WHEN** the shim is invoked against a `.cmd` target with `%1`, `%99` or `100%`
- **THEN** each arrives unchanged, because none is a variable reference

#### Scenario: An environment reference is forwarded to a direct executable target
- **WHEN** the shim is invoked against an `.exe` target with an argument containing `%NAME%`
- **THEN** it arrives unchanged — the restriction belongs to `cmd.exe`, not to the shim, and the packaged path is unaffected

#### Scenario: No fabricated version response
- **WHEN** the shim forwards any command
- **THEN** it writes no version string of its own to stdout or stderr

#### Scenario: Exit codes propagate
- **WHEN** the forwarded target exits non-zero
- **THEN** the shim returns that same exit code

#### Scenario: Target is a batch file
- **WHEN** the resolved shim target is a `.cmd` or `.bat` file, as on the dev path
- **THEN** the shim still invokes it successfully rather than failing to start

#### Scenario: Target cannot be started
- **WHEN** the resolved shim target does not exist
- **THEN** the shim exits non-zero and writes a reason to stderr

### Requirement: The shim wins a bare-name lookup against a competing tmux

Orca's shim SHALL be the executable a bare-name `tmux` spawn resolves to, even when another `tmux` executable exists elsewhere on PATH. Windows process creation appends `.exe` and never `.cmd`, so a batch-only shim is invisible to such a spawn and a competing multiplexer would silently receive Orca's pane commands.

#### Scenario: A competing tmux executable is installed
- **WHEN** the shim directory is first on PATH, a different `tmux.exe` exists in a later entry, and a process spawns `tmux` by bare name
- **THEN** Orca's shim answers, both with and without shell resolution

### Requirement: Shim installation degrades instead of failing

Placing the shim executable SHALL never block a terminal launch, and SHALL not rewrite an unchanged file.

#### Scenario: Packaged shim present
- **WHEN** the shim directory is prepared and the packaged executable exists
- **THEN** it is copied in alongside the script shims

#### Scenario: Packaged shim absent but a dev build exists
- **WHEN** the packaged executable is missing and a locally built one is available
- **THEN** the local build is used, so building the shim during development takes effect

#### Scenario: No shim executable anywhere
- **WHEN** neither is available
- **THEN** the script shims are still written, no executable is placed, and no error is raised

#### Scenario: Repeated preparation
- **WHEN** the shim directory is prepared again with an unchanged source
- **THEN** the existing executable is left in place, on every platform

### Requirement: send-keys honours the tmux key names it accepts

`send-keys` SHALL translate the tmux key names it recognises into their terminal sequences. An unmapped name is emitted as literal text, which types the key's own name into the pane instead of acting on it.

#### Scenario: Cursor and navigation keys
- **WHEN** `send-keys` receives `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PPage`, `NPage`, `IC`, `DC` or `BTab`
- **THEN** each is translated to its corresponding terminal sequence

#### Scenario: Common aliases
- **WHEN** `send-keys` receives `PageUp`, `PageDown`, `Insert` or `Delete`
- **THEN** each is translated as its canonical tmux equivalent

#### Scenario: Control chords
- **WHEN** `send-keys` receives any `C-<letter>` chord
- **THEN** it is translated to the matching ASCII control character, including the chords tmux spells separately

#### Scenario: Literal mode is unaffected
- **WHEN** `send-keys` is given the literal flag
- **THEN** key names are sent as text rather than translated

#### Scenario: Unrecognised names pass through
- **WHEN** `send-keys` receives a name that is not a known key
- **THEN** it is emitted as literal text, so ordinary prompt words are never dropped

### Requirement: Packaging accepts prefix-only Node builtins

The packaged-runtime verifier SHALL treat `node:`-prefixed builtins as builtins even when the runtime omits them from its builtin-module list. `node:sqlite`, `node:test` and `node:sea` are absent from that list on every current Node version, so a legitimate import of one is otherwise reported as a package missing from the bundle and packaging aborts.

#### Scenario: Main bundle imports a prefix-only builtin
- **WHEN** the packaged main bundle requires `node:sqlite`
- **THEN** verification passes without requiring a copied `node_modules` entry for it

#### Scenario: Main bundle imports a real package that was not copied
- **WHEN** the packaged main bundle requires a third-party package with no copied `node_modules` entry
- **THEN** verification still fails and names that package
