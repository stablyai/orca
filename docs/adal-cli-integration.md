# AdaL CLI in Orca

AdaL CLI is a terminal-first AI coding agent. Orca can show AdaL in the default-agent picker, detect it when it is installed, and launch it inside an Orca-managed worktree.

AdaL supports codebase understanding, implementation, debugging, project context, multiple AI models, MCP servers, skills, plugins, web search, image generation, and local models. See the [AdaL documentation](https://docs.sylph.ai/) for the complete feature set.

## Before you begin

You need:

- Orca installed.
- A project or Git repository to work on.
- A supported terminal environment.
- An AdaL account with an active plan. Eligible new users can claim a 7-day free Pro trial from the [AdaL Dashboard](https://adal.sylph.ai/dashboard).

A Git repository is recommended because Orca uses isolated worktrees for parallel development.

## Step 1: Install AdaL CLI

Native installation is recommended because it manages AdaL's runtime and updates consistently across platforms.

### macOS, Linux, and WSL

Run this command in a terminal:

```bash
curl -fsSL https://adal.sylph.ai/install.sh | bash
```

### Windows PowerShell

```powershell
irm https://adal.sylph.ai/install/windows | iex
```

### Windows Command Prompt

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://adal.sylph.ai/install/windows | iex"
```

If `irm` is not recognized, you are probably using Command Prompt instead of PowerShell. Use the Command Prompt command above or open PowerShell.

Official installation reference: [AdaL Quickstart](https://docs.sylph.ai/getting-started/quickstart).

## Step 2: Verify AdaL

Open a new terminal after installation and run:

```bash
adal --help
```

On macOS, Linux, or WSL, you can also verify the executable location:

```bash
command -v adal
```

On Windows PowerShell:

```powershell
Get-Command adal
```

If Orca was already open while AdaL was installed, restart Orca so its desktop process receives the updated `PATH`.

## Step 3: Authenticate AdaL

Run AdaL from any project directory:

```bash
adal
```

On first launch, AdaL opens a browser window for authentication. Complete sign-in and return to the terminal.

AdaL requires an active plan to use the CLI. Review available plans at [Pricing](https://adalagent.ai/#pricing).

## Step 4: Select AdaL in Orca

In Orca's **Pick your default agent** onboarding step:

1. Find **AdaL** in the agent list.
2. Select the AdaL card.
3. Continue through onboarding.

### When AdaL is installed

AdaL appears in:

```text
Detected on your system
```

### When AdaL is not installed

AdaL remains available in the additional-agent list. You can select the card and use Orca's **Install instructions** link to open the official AdaL documentation.

After installing AdaL, restart Orca and return to the agent picker. AdaL should then appear as detected.

## Step 5: Launch AdaL from an Orca worktree

When AdaL is selected for a project, Orca:

1. Creates or selects the Git worktree.
2. Opens a terminal whose working directory is that worktree.
3. Launches AdaL interactively:

   ```bash
   adal
   ```

4. Delivers the initial task through Orca's terminal startup flow.

The workspace context is inherited through the working directory:

```text
Orca worktree
    ↓
Terminal current working directory
    ↓
AdaL process working directory
    ↓
AdaL project/session context
```

AdaL continues to own its normal authentication, session, streaming, and runtime lifecycle.

## What you can do with AdaL in Orca

Once AdaL is running, you can use its normal CLI capabilities.

### Understand and modify a codebase

Try prompts such as:

```text
Summarize this codebase
```

```text
Find the authentication flow and explain how it works
```

```text
Add validation to the user registration endpoint and update the tests
```

AdaL can inspect project files, plan changes, implement edits, and help debug issues.

### Initialize project context

Use:

```text
/init
```

AdaL generates project context in `AGENTS.md`, which can capture repository conventions and instructions for future work.

### Use multiple models

Use:

```text
/model
```

to switch the active AI model. AdaL supports Claude, GPT, Gemini, GLM, MiniMax, and local models; availability depends on the account and configuration.

### Use files and shell commands as context

Target a file with `@`:

```text
@src/api.ts add request validation
```

Run a shell command with `!`:

```text
!git status
```

### Use planning and research modes

Press `Tab` to switch between:

```text
Regular → Plan → Deep Research
```

Use Plan mode for larger changes that benefit from an explicit implementation plan before editing.

### Continue in the AdaL IDE

Use:

```text
/ide
```

to open the same session in the AdaL agentic IDE. If AdaL Desktop is installed, it opens the Desktop app; otherwise, AdaL opens the browser workspace.

This is useful for visual work, diff review, and tasks that benefit from an IDE-style layout.

### Use MCP servers, skills, and plugins

AdaL supports:

- MCP servers.
- Skills and plugins.
- Web search.
- Image generation.
- Local models.
- Project context through `AGENTS.md`.

Configure these through the relevant features documented at [docs.sylph.ai](https://docs.sylph.ai/).

## Essential AdaL commands

| Command | What it does |
| --- | --- |
| `/help` | Show all commands |
| `/model` | Switch the AI model |
| `/init` | Generate project context in `AGENTS.md` |
| `/ide` | Open the same session in AdaL Desktop or the browser workspace |
| `/resume` | Resume a previous conversation |
| `/compact` | Compress memory when the context is full |
| `/quit` | Exit AdaL |

## Essential shortcuts

| Shortcut | What it does |
| --- | --- |
| `?` | Show all shortcuts |
| `Tab` | Toggle Regular, Plan, and Deep Research modes |
| `Shift+Tab` | Toggle auto-accept edits |
| `Ctrl+C` | Cancel agent streaming or a running operation |
| `Esc` | Clear the input |

## Input prefixes

| Prefix | What it does | Example |
| --- | --- | --- |
| `@` | Add a file as context | `@src/api.ts add validation` |
| `!` | Run a shell command | `!git status` |

## Worktree management

AdaL also provides worktree commands for users who want to manage branches from the CLI:

```bash
adal worktree create -b <name>
adal worktree create -b <name> <start-point>
adal worktree list
adal worktree delete <name>
```

When AdaL is launched by Orca, Orca remains responsible for the Orca-managed worktree and terminal lifecycle.

## Terminal setup

AdaL works in modern native terminals and integrated terminals, including:

- iTerm2.
- cmux.
- VS Code terminal.
- Windows Terminal.
- Linux terminals.
- macOS Terminal on macOS 26 or later for full theme support.

A larger terminal window gives AdaL more room to display code and diffs.

AdaL themes require truecolor support. Check your terminal with:

```bash
echo $COLORTERM
```

The output should be `truecolor` or `24bit`.

If necessary, enable truecolor in `.zshrc` or `.bashrc`:

```bash
export COLORTERM=truecolor
```

## Interactive mode in Orca

Orca launches the interactive command:

```bash
adal
```

It does not use AdaL's one-shot query mode as the default worktree terminal because Orca needs a persistent interactive session for:

- Ongoing conversation.
- Approvals.
- Slash commands.
- Queued messages.
- Session continuation.
- Follow-up tasks.

## Troubleshooting

### AdaL does not appear as detected

Verify the command outside Orca:

```bash
adal --help
```

Then restart Orca. The Orca desktop process may have been started before AdaL was added to `PATH`.

### AdaL is listed but Orca shows it as unavailable

This means AdaL is present in Orca's catalog but was not found in the environment visible to Orca. Install AdaL using the official instructions, restart Orca, and refresh the agent selection.

### Authentication does not open

Run AdaL directly:

```bash
adal
```

Complete browser authentication and confirm that the CLI works before launching it from Orca.

### AdaL cannot use the project

Confirm that the project path is accessible and that AdaL works directly from the same directory:

```bash
cd /path/to/project
adal
```

When launched from an Orca worktree, AdaL receives that worktree as its current working directory.

### Colors or layout look incorrect

Use a modern terminal with truecolor support. Check:

```bash
echo $COLORTERM
```

For macOS Terminal, AdaL recommends macOS 26 or later for full theme support; iTerm2 or the VS Code terminal are alternatives.

### The initial task does not appear

Confirm that AdaL reaches its interactive input screen when run directly. Then close and relaunch the Orca worktree so the terminal startup flow can run again.

## Current Orca integration scope

The Orca integration provides:

- AdaL in the default-agent onboarding catalog.
- AdaL detection through the installed `adal` command.
- Default-agent selection and persistence.
- AdaL launch inside an Orca-managed worktree.
- Interactive terminal hosting.
- Generic launch and process metadata.

The current integration does not add:

- A native AdaL chat panel inside Orca.
- AdaL-specific status hooks.
- AdaL session-history scanning in Orca.
- AdaL model, account, or usage controls inside Orca.
- AdaL-specific orchestration APIs.

These are separate future integrations and are not required for AdaL to be selected and launched from Orca.

## Official AdaL references

- [AdaL documentation](https://docs.sylph.ai/)
- [AdaL Quickstart](https://docs.sylph.ai/getting-started/quickstart)
- [Workflows and examples](https://docs.sylph.ai/getting-started/workflows-and-examples)
- [Slash commands](https://docs.sylph.ai/features/slash-commands)
- [Keyboard shortcuts](https://docs.sylph.ai/features/keyboard-shortcuts)
- [AdaL Dashboard](https://adal.sylph.ai/dashboard)
