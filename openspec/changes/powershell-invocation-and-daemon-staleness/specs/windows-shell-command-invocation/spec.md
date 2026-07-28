## ADDED Requirements

### Requirement: A startup command is executable by the pane's shell

On Windows a startup command is evaluated as shell source, not passed as an argument vector. Orca SHALL ensure the command it delivers is actually invoked. PowerShell parses a leading quoted token as a string expression rather than a command, so a command naming its executable by quoted absolute path silently fails to run and reports a parser error instead.

Callers that compose a command themselves can prefix the call operator. Callers relaying a command from an external tool cannot: they receive text written for a POSIX shell and have no visibility of the pane's shell.

#### Scenario: Command begins with a quoted executable path
- **WHEN** a PowerShell startup command begins with a single- or double-quoted token
- **THEN** the call operator is prefixed so the quoted path is invoked rather than evaluated as a string

#### Scenario: Command is already invocable
- **WHEN** the command already begins with the call operator, the dot-source operator, or a bare command name
- **THEN** it is delivered unchanged, with no second operator added

#### Scenario: Arguments follow the quoted path
- **WHEN** the invoked command carries arguments such as `--agent-id <value>`
- **THEN** they reach the executable as arguments rather than being parsed as operators

#### Scenario: Non-PowerShell shells are unaffected
- **WHEN** the pane's shell is not PowerShell
- **THEN** the PowerShell-specific adjustment is not applied

### Requirement: The adjustment is applied where the shell is known

The adjustment SHALL be made at the layer that resolves the pane's shell. Layers above it — the tmux dispatcher, the agent-teams service, the runtime terminal API — have no access to the shell; the shell is resolved when the PTY is launched.

#### Scenario: A relayed command reaches the shell layer
- **WHEN** a command originating outside Orca is delivered as a pane startup command
- **THEN** it is made invocable without the relaying layer needing to know which shell will run it
