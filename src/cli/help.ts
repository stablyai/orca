import type { CommandSpec } from './args'
import { findCommandSpec, isCommandGroup, supportsBrowserPageFlag } from './args'

const ROOT_HELP_TEXT = `orca

Usage: orca <command> [options]

Startup:
  open                      Launch Orca and wait for the runtime to be reachable
  status                    Show app/runtime/graph readiness

Repos:
  repo list                 List repos registered in Orca
  repo add                  Add a project to Orca by filesystem path
  repo show                 Show one registered repo
  repo set-base-ref         Set the repo's default base ref for future worktrees
  repo search-refs          Search branch/tag refs within a repo

Worktrees:
  worktree list             List Orca-managed worktrees
  worktree show             Show one worktree
  worktree current          Show the Orca-managed worktree for the current directory
  worktree create           Create a new Orca-managed worktree
  worktree set              Update Orca metadata for a worktree
  worktree rm               Remove a worktree from Orca and git
  worktree ps               Show a compact orchestration summary across worktrees

Terminals:
  terminal list             List live Orca-managed terminals
  terminal show             Show terminal metadata and preview
  terminal read             Read bounded terminal output
  terminal send             Send input to a live terminal
  terminal wait             Wait for a terminal condition (exit, tui-idle)
  terminal stop             Stop terminals for a worktree
  terminal create           Create a new terminal tab in a worktree
  terminal rename           Set or clear the title of a terminal tab
  terminal split            Split an existing terminal pane
  terminal switch           Bring a terminal tab to the foreground
  terminal focus            Alias for terminal switch
  terminal close            Close a terminal pane (or tab if last pane)

Orchestration:
  orchestration send        Send an inter-agent message
  orchestration check       Check messages for a terminal
  orchestration reply       Reply to a message
  orchestration inbox       Show all messages across recipients
  orchestration task-create Create an orchestration task
  orchestration task-list   List orchestration tasks
  orchestration task-update Update a task status
  orchestration dispatch    Dispatch a task to a terminal
  orchestration dispatch-show Show dispatch context for a task
  orchestration run         Start the coordinator loop
  orchestration run-stop    Stop the active coordinator run
  orchestration gate-create Create a decision gate blocking a task
  orchestration gate-resolve Resolve a pending decision gate
  orchestration gate-list   List decision gates
  orchestration reset       Reset orchestration state

Browser Automation:
  tab create                Create a new browser tab (navigates to --url)
  tab list                  List open browser tabs
  tab show                  Show one browser tab by page id
  tab current               Show the current browser tab
  tab profile list          List browser session profiles
  tab profile create        Create a browser session profile
  tab profile delete        Delete a browser session profile
  tab profile set           Switch a browser tab to a different profile
  tab profile show          Show the profile bound to a browser tab
  tab profile use-default   Switch a browser tab back to the default profile
  tab profile clone         Clone a browser tab into another profile
  tab switch                Switch the active browser tab by --index or --page
  tab close                 Close a browser tab by --index/--page or the current tab
  snapshot                  Accessibility snapshot with element refs (e.g. @e1, @e2)
  goto                      Navigate the active tab to --url
  click                     Click element by --element ref
  fill                      Clear and fill input by --element ref with --value
  type                      Type --input text at the current focus (no element needed)
  select                    Select dropdown option by --element ref and --value
  hover                     Hover element by --element ref
  keypress                  Press a key (e.g. --key Enter, --key Tab)
  scroll                    Scroll --direction (up/down) by --amount pixels
  back                      Navigate back in browser history
  reload                    Reload the active browser tab
  screenshot                Capture viewport screenshot (--format png|jpeg)
  eval                      Evaluate --expression JavaScript in the page context
  wait                      Wait for page idle or --timeout ms
  check                     Check a checkbox by --element ref
  uncheck                   Uncheck a checkbox by --element ref
  focus                     Focus an element by --element ref
  clear                     Clear an input by --element ref
  drag                      Drag --from ref to --to ref
  upload                    Upload --files to a file input by --element ref
  dblclick                  Double-click element by --element ref
  forward                   Navigate forward in browser history
  scrollintoview            Scroll --element into view
  get                       Get element property (--what: text, html, value, url, title)
  is                        Check element state (--what: visible, enabled, checked)
  inserttext                Insert text without key events
  mouse move                Move mouse to --x --y coordinates
  mouse down                Press mouse button
  mouse up                  Release mouse button
  mouse wheel               Scroll wheel --dy [--dx]
  find                      Find element by locator (--locator role|text|label --value <v>)
  set device                Emulate device (--name "iPhone 12")
  set offline               Toggle offline mode (--state on|off)
  set headers               Set HTTP headers (--headers '{"key":"val"}')
  set credentials           Set HTTP auth (--user <u> --pass <p>)
  set media                 Set color scheme (--color-scheme dark|light)
  clipboard read            Read clipboard contents
  clipboard write           Write --text to clipboard
  dialog accept             Accept browser dialog (--text for prompt response)
  dialog dismiss            Dismiss browser dialog
  storage local get         Get localStorage value by --key
  storage local set         Set localStorage --key --value
  storage local clear       Clear localStorage
  storage session get       Get sessionStorage value by --key
  storage session set       Set sessionStorage --key --value
  storage session clear     Clear sessionStorage
  download                  Download file via --selector to --path
  highlight                 Highlight --selector on page
  exec                      Run any agent-browser command (--command "...")

Common Commands:
  orca open [--json]
  orca status [--json]
  orca worktree list [--repo <selector>] [--limit <n>] [--json]
  orca worktree create --repo <selector> --name <name> [--base-branch <ref>] [--issue <number>] [--comment <text>] [--run-hooks] [--json]
  orca worktree show --worktree <selector> [--json]
  orca worktree current [--json]
  orca worktree set --worktree <selector> [--display-name <name>] [--issue <number|null>] [--comment <text>] [--json]
  orca worktree rm --worktree <selector> [--force] [--run-hooks] [--json]
  orca worktree ps [--limit <n>] [--json]
  orca terminal list [--worktree <selector>] [--limit <n>] [--json]
  orca terminal show [--terminal <handle>] [--json]
  orca terminal read [--terminal <handle>] [--json]
  orca terminal send [--terminal <handle>] [--text <text>] [--enter] [--interrupt] [--json]
  orca terminal wait [--terminal <handle>] --for exit|tui-idle [--timeout-ms <ms>] [--json]
  orca terminal stop --worktree <selector> [--json]
  orca terminal create [--worktree <selector>] [--title <name>] [--command <text>] [--json]
  orca terminal split [--terminal <handle>] [--direction horizontal|vertical] [--json]
  orca terminal switch [--terminal <handle>] [--json]
  orca terminal close [--terminal <handle>] [--json]
  orca repo list [--json]
  orca repo add --path <path> [--json]
  orca repo show --repo <selector> [--json]
  orca repo set-base-ref --repo <selector> --ref <ref> [--json]
  orca repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]

Selectors:
  --repo <selector>         Registered repo selector such as id:<id>, name:<name>, or path:<path>
  --worktree <selector>     Worktree selector such as id:<id>, branch:<branch>, issue:<number>, path:<path>, or active/current
  --terminal <handle>       Runtime-issued terminal handle returned by \`orca terminal list --json\`

Terminal Send Options:
  --text <text>             Text to send to the terminal
  --enter                   Append Enter after sending text
  --interrupt               Send as an interrupt-style input when supported

Wait Options:
  --for exit                Wait until the target terminal exits
  --timeout-ms <ms>         Maximum wait time before timing out

Output Options:
  --json                    Emit machine-readable JSON instead of human text
  --help                    Show this help message

Behavior:
  Most commands require a running Orca runtime. If Orca is not open yet, run \`orca open\` first.
  Use selectors for discovery and handles for repeated live terminal operations.

Browser Workflow:
  1. Create or navigate:  orca tab create --url https://example.com
                          orca goto --url https://example.com
  2. Inspect the page:    orca snapshot
     (Returns an accessibility tree with element refs like e1, e2, e3)
     For concurrent workflows, prefer: orca tab list --json
     then reuse tabs[].browserPageId with --page <id> on later commands.
  3. Interact:            orca click --element e2
                          orca fill --element e5 --value "search query"
                          orca keypress --key Enter
  4. Re-inspect:          orca snapshot
     (Element refs change after navigation — always re-snapshot before interacting)

Browser Options:
  --element <ref>           Element ref from snapshot (e.g. @e3)
  --url <url>               URL to navigate to
  --value <text>            Value to fill or select
  --input <text>            Text to type at current focus (no element needed)
  --expression <js>         JavaScript expression to evaluate
  --key <key>               Key to press (Enter, Tab, Escape, Control+a, etc.)
  --direction <dir>         Scroll direction: up or down
  --amount <pixels>         Scroll distance in pixels (default: viewport height)
  --index <n>               Tab index (from \`tab list\`)
  --page <id>               Stable browser page id (preferred for concurrent workflows)
  --profile <id>            Browser profile id
  --show-profile            Include the tab's browser profile in text output
  --format <png|jpeg>       Screenshot image format
  --from <ref>              Drag source element ref
  --to <ref>                Drag target element ref
  --files <path,...>        Comma-separated file paths for upload
  --timeout <ms>            Wait timeout in milliseconds
  --worktree <selector>     Scope commands to a specific worktree's browser tabs

Examples:
  $ orca open
  $ orca status --json
  $ orca repo list
  $ orca worktree create --repo name:orca --name cli-test-1 --issue 273
  $ orca worktree show --worktree branch:Jinwoo-H/cli
  $ orca worktree current
  $ orca worktree set --worktree active --comment "waiting on review"
  $ orca worktree ps --limit 10
  $ orca terminal list --worktree path:/Users/me/orca/workspaces/orca/cli-test-1 --json
  $ orca terminal send --terminal term_123 --text "hi" --enter
  $ orca terminal wait --terminal term_123 --for exit --timeout-ms 60000 --json
  $ orca tab current --json
  $ orca tab show --page page_123 --json
  $ orca tab create --url https://example.com --profile work
  $ orca tab profile clone --page page_123 --profile work --json
  $ orca snapshot
  $ orca click --element e3
  $ orca fill --element e5 --value "hello"
  $ orca goto --url https://example.com/login
  $ orca keypress --key Enter
  $ orca eval --expression "document.title"
  $ orca tab list --json`

export function printHelp(specs: CommandSpec[], commandPath: string[] = []): void {
  const exactSpec = findCommandSpec(specs, commandPath)
  if (exactSpec) {
    console.log(formatCommandHelp(exactSpec))
    return
  }

  if (isCommandGroup(commandPath)) {
    console.log(formatGroupHelp(specs, commandPath[0]))
    return
  }

  if (commandPath.length > 0) {
    console.log(`Unknown command: ${commandPath.join(' ')}\n`)
  }

  console.log(ROOT_HELP_TEXT)
}

export function formatCommandHelp(spec: CommandSpec): string {
  const lines = [`orca ${spec.path.join(' ')}`, '', `Usage: ${spec.usage}`, '', spec.summary]
  const displayedFlags = supportsBrowserPageFlag(spec.path)
    ? [...spec.allowedFlags, 'page']
    : spec.allowedFlags

  if (displayedFlags.length > 0) {
    lines.push('', 'Options:')
    for (const flag of displayedFlags) {
      lines.push(`  ${formatFlagHelp(flag)}`)
    }
  }

  if (spec.notes && spec.notes.length > 0) {
    lines.push('', 'Notes:')
    for (const note of spec.notes) {
      lines.push(`  ${note}`)
    }
  }

  if (spec.examples && spec.examples.length > 0) {
    lines.push('', 'Examples:')
    for (const example of spec.examples) {
      lines.push(`  $ ${example}`)
    }
  }

  return lines.join('\n')
}

export function formatGroupHelp(specs: CommandSpec[], group: string): string {
  const groupSpecs = specs.filter((spec) => spec.path[0] === group)
  const lines = [`orca ${group}`, '', `Usage: orca ${group} <command> [options]`, '', 'Commands:']
  for (const spec of groupSpecs) {
    lines.push(`  ${spec.path.slice(1).join(' ').padEnd(18)} ${spec.summary}`)
  }
  lines.push('', `Run \`orca ${group} <command> --help\` for command-specific usage.`)
  return lines.join('\n')
}

export function formatFlagHelp(flag: string): string {
  const helpByFlag: Record<string, string> = {
    'base-branch': '--base-branch <ref>    Base branch/ref to create the worktree from',
    command: '--command <text>       Command to run in the terminal on startup',
    comment: '--comment <text>       Comment stored in Orca metadata',
    cursor: '--cursor <n>           Line cursor from a previous read (returns only new output)',
    direction: '--direction <dir>      Direction: horizontal|vertical (split) or up|down (scroll)',
    'display-name': '--display-name <name>  Override the Orca display name',
    title: '--title <text>         Custom title for the terminal tab (omit to reset)',
    enter: '--enter                Append Enter after sending text',
    force: '--force                Force worktree removal when supported',
    for: '--for exit|tui-idle    Wait condition to satisfy',
    help: '--help                 Show this help message',
    interrupt: '--interrupt            Send as an interrupt-style input when supported',
    issue: '--issue <number|null>  Linked GitHub issue number',
    json: '--json                 Emit machine-readable JSON',
    limit: '--limit <n>            Maximum number of rows to return',
    name: '--name <name>          Name for the new worktree',
    path: '--path <path>          Filesystem path to the repo',
    query: '--query <text>        Search text for matching refs',
    ref: '--ref <ref>            Base ref to persist for the repo',
    repo: '--repo <selector>      Repo selector such as id:<id>, name:<name>, or path:<path>',
    terminal: '--terminal <handle>  Runtime-issued terminal handle',
    text: '--text <text>          Text to send to the terminal',
    'timeout-ms': '--timeout-ms <ms>     Maximum wait time before timing out',
    worktree:
      '--worktree <selector>  Worktree selector such as id:<id>, branch:<branch>, issue:<number>, path:<path>, or active/current',
    // Browser automation flags
    element: '--element <ref>        Element ref from snapshot (e.g. e3)',
    url: '--url <url>            URL to navigate to',
    value: '--value <text>         Value to fill or select',
    input: '--input <text>         Text to type at current focus',
    expression: '--expression <js>     JavaScript expression to evaluate',
    amount: '--amount <pixels>      Scroll distance in pixels',
    index: '--index <n>            Tab index to switch to',
    page: '--page <id>            Stable browser page id from `orca tab list --json`',
    profile: '--profile <id>        Browser profile id',
    'show-profile': '--show-profile        Include tab profile in text output',
    format: '--format <png|jpeg>    Screenshot image format'
  }

  return helpByFlag[flag] ?? `--${flag}`
}
