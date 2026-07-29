## ADDED Requirements

### Requirement: A teammate pane is launched without emitting shell syntax

Claude Code supplies a teammate's launch instruction as a POSIX shell string of the form `cd <dir> && env KEY=VALUE … <command>`. When an instruction matches that recognised shape, Orca SHALL decompose it into a working directory, environment assignments and a bare command, supply each through its own spawn options, and SHALL NOT hand the `&&` operator or the `env` prefix to the pane's shell — only a POSIX shell can interpret them, and a pane may be running PowerShell, cmd or a POSIX shell.

The prohibition is scoped to recognised shapes. An instruction that does not match is passed through unchanged rather than rejected or rewritten, which is a deliberate fallback: Orca cannot know what an unrecognised instruction means, and guessing would break commands that work today. Such an instruction may therefore still contain shell syntax, and whether it runs depends on the pane's shell.

#### Scenario: Full prefix present
- **WHEN** the supplied instruction contains both a `cd` clause and an `env` clause
- **THEN** the directory becomes the pane's working directory, each assignment becomes an environment entry, and the pane's command is the remainder alone, containing no `&&` and no `env`

#### Scenario: Only a directory clause
- **WHEN** the instruction contains a `cd` clause with no `env` clause
- **THEN** the directory is applied and the remainder becomes the command

#### Scenario: Only an environment clause
- **WHEN** the instruction contains an `env` clause with no `cd` clause
- **THEN** the assignments are applied and the pane keeps its inherited working directory

#### Scenario: Directory containing spaces
- **WHEN** the directory is quoted because it contains spaces
- **THEN** the quotes are removed and the full path is used

#### Scenario: An unrecognised instruction
- **WHEN** the instruction does not match the supported shape
- **THEN** it is passed through unchanged — including any shell syntax it contains — so only the shapes Claude actually emits are reinterpreted

### Requirement: The command text survives decomposition verbatim

The remaining command SHALL be preserved exactly as supplied, including any quoting. Reconstructing it from parsed tokens would discard quotes and split a single argument — a prompt containing spaces would arrive as several arguments.

#### Scenario: Command contains a quoted argument
- **WHEN** the command portion contains an argument wrapped in quotes because it contains spaces
- **THEN** the command is delivered with that quoting intact and the argument stays a single argument

#### Scenario: Environment parsing stops at the command
- **WHEN** the command itself contains a token that resembles an assignment, such as a long option written with `=`
- **THEN** that token is treated as part of the command and not as an environment assignment

### Requirement: A teammate's own working directory is honoured

When an explicit working directory is supplied, the pane SHALL start there rather than inheriting the splitting pane's directory. A teammate may belong to a different worktree, and starting an agent in the wrong repository is a silent, damaging failure.

#### Scenario: Directory differs from the splitting pane's
- **WHEN** a teammate pane is created with an explicit working directory
- **THEN** the pane starts in that directory

#### Scenario: No directory supplied
- **WHEN** no explicit working directory is supplied
- **THEN** the pane inherits the workspace directory, as before

### Requirement: The holding pane does not block on an interactive prompt

Claude creates a placeholder pane and replaces it moments later with the real teammate command. On Windows that placeholder command resolves to a cmdlet that waits for input, leaving a pane stuck on a prompt. Orca SHALL start the placeholder as a plain shell there instead.

#### Scenario: Placeholder on Windows
- **WHEN** the placeholder command is supplied on Windows
- **THEN** the pane starts with no command, holding the pane open without prompting

#### Scenario: Placeholder on macOS or Linux
- **WHEN** the placeholder command is supplied on a POSIX platform
- **THEN** it runs as supplied, matching upstream behaviour

#### Scenario: A real command that merely resembles the placeholder
- **WHEN** the supplied command is the placeholder name followed by arguments
- **THEN** it is treated as a real command and left untouched

#### Scenario: Platform is an explicit input
- **WHEN** the placeholder rule is evaluated
- **THEN** the platform is supplied as a parameter rather than read from the running process, so both branches are assertable on any host
