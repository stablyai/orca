import type { CommandSpec } from './args'
import { findCommandSpec, isCommandGroup, supportsBrowserPageFlag } from './args'
import { unknownCommandData } from './command-suggestion'
import { ROOT_HELP_TEXT_PRIMARY } from './root-help-text-primary'
import { ROOT_HELP_TEXT_SECONDARY } from './root-help-text-secondary'

const ROOT_HELP_TEXT = [ROOT_HELP_TEXT_PRIMARY, ROOT_HELP_TEXT_SECONDARY].join('\n')

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
    const { nextSteps } = unknownCommandData(specs, commandPath)
    const recovery = nextSteps.map((step) => `Next step: ${step}`).join('\n')
    console.log(`Unknown command: ${commandPath.join(' ')}${recovery ? `\n${recovery}` : ''}\n`)
  }

  console.log(ROOT_HELP_TEXT)
}

export function formatCommandHelp(spec: CommandSpec): string {
  const lines = [`orca ${spec.path.join(' ')}`, '', `Usage: ${spec.usage}`, '', spec.summary]
  const displayedFlags =
    spec.argumentMode === 'passthrough'
      ? []
      : supportsBrowserPageFlag(spec.path)
        ? [...spec.allowedFlags, 'page']
        : spec.allowedFlags

  if (displayedFlags.length > 0) {
    lines.push('', 'Options:')
    for (const flag of displayedFlags) {
      lines.push(`  ${formatCommandFlagHelp(flag, spec.path)}`)
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

function formatCommandFlagHelp(flag: string, commandPath: string[]): string {
  const command = commandPath.join(' ')
  if (command === 'skills install' && flag === 'agent') {
    return '--agent <names>        Comma-separated install targets; default is detected agents'
  }
  if (command === 'terminal close' && flag === 'tab') {
    return '--tab                  Close the whole tab and wait for durable persistence'
  }
  if (command === 'linear issue' && flag === 'id') {
    return '--id <id>             Linear issue key, id, or URL'
  }
  if (command === 'linear issue' && flag === 'workspace') {
    return '--workspace <id>      Connected Linear workspace id'
  }
  if (command === 'linear search' && flag === 'query') {
    return '--query <text>        Text to search across Linear issues'
  }
  if (command === 'linear search' && flag === 'workspace') {
    return '--workspace <id|all>  Connected Linear workspace id, or all'
  }
  if (command === 'linear list-issues' && flag === 'cursor') {
    return '--cursor <cursor>      Opaque cursor from a previous list-issues page; issued cursors bind the workspace, raw Linear cursors need --workspace'
  }
  if (command === 'linear list-issues' && flag === 'priority') {
    return '--priority <0-4>       0=none, 1=urgent, 2=high, 3=medium, 4=low'
  }
  if (command === 'linear list-issues' && flag === 'limit') {
    return '--limit <n>            Max issues to return; omit to return every match'
  }
  if (command === 'artifacts list' && flag === 'cursor') {
    return '--cursor <cursor>      Opaque cursor returned by a previous artifacts page'
  }
  if (command === 'orchestration worker-read' && flag === 'cursor') {
    return '--cursor <cursor>      Opaque cursor returned by a previous worker-read page'
  }
  if (command === 'orchestration worker-list' && flag === 'terminal-state') {
    return '--terminal-state <state> Terminal accounting filter: active, reclaimable, retained, release_pending, release_unknown, or released'
  }
  if (command === 'linear list-issues' && flag === 'workspace') {
    return '--workspace <id|all>  Connected Linear workspace id, or all'
  }
  if (command.startsWith('linear ') && flag === 'workspace') {
    return '--workspace <id>      Connected Linear workspace id'
  }
  if (command.startsWith('linear ') && flag === 'body') {
    return '--body <text>         Linear comment or issue body'
  }
  if (command.startsWith('linear ') && flag === 'body-file') {
    return '--body-file <path|->  Read Linear body from a file or stdin'
  }
  if (command.startsWith('linear ') && flag === 'write-id') {
    return '--write-id <uuid>     Retry id from linear_write_unconfirmed'
  }
  if (command.startsWith('linear ') && flag === 'to') {
    return '--to <state>          Exact Linear workflow state name'
  }
  if (command === 'linear comment add' && flag === 'reply-to') {
    return '--reply-to <id>       Comment id to reply to'
  }
  if (command === 'linear attach' && flag === 'url') {
    return '--url <url>           Absolute http(s) link to attach'
  }
  if (command === 'linear attach' && flag === 'title') {
    return '--title <text>        Attachment title'
  }
  if (command === 'linear create' && flag === 'title') {
    return '--title <text>        New Linear issue title'
  }
  if (command === 'linear create' && flag === 'team') {
    return '--team <key>          Linear team key'
  }
  if (command === 'linear create' && flag === 'parent') {
    return '--parent <id>         Parent Linear issue key, id, or URL'
  }
  if (command === 'linear create' && flag === 'parent-current') {
    return '--parent-current      Use the current linked issue as parent'
  }
  if (command === 'worktree create' && flag === 'parent-worktree') {
    return '--parent-worktree <selector> Parent selector such as identity:<identity>, active/current, id:<repo-id>::<path>, branch:<branch>, issue:<number>, path:<path>, folder:<id>, or worktree:<worktreeId>'
  }
  if (command === 'orchestration task-create' && flag === 'task-title') {
    return '--task-title <text>  Concise title for the orchestration task'
  }
  if (command === 'orchestration task-create' && flag === 'display-name') {
    return '--display-name <text> UI label shown for dispatched worker rows'
  }
  // Why: the shared --agent help describes launching a TUI agent in a terminal,
  // which is the wrong meaning here — this selects the account provider.
  if (command === 'account add' && flag === 'agent') {
    return '--agent <id>           Account provider: claude or codex (default claude)'
  }
  // Why: the shared --force help describes worktree removal; here it overrides the
  // pending-input refusal that protects a user's unsent composer draft.
  if (command === 'terminal send' && flag === 'force') {
    return '--force                Append to unsent Claude Code/Codex composer input instead of refusing (pending-input)'
  }
  if (flag === 'key' && command === 'computer hotkey') {
    return '--key <key-combo>      Modifier chord with one key, e.g. CmdOrCtrl+A'
  }
  if (flag === 'key' && command === 'computer press-key') {
    return '--key <key>            Single key, e.g. Return, Escape, Tab, Left, or PageUp'
  }
  return formatFlagHelp(flag)
}

export function formatFlagHelp(flag: string): string {
  const helpByFlag: Record<string, string> = {
    agent: '--agent <id>          Launch a known TUI agent in the first terminal',
    'base-branch': '--base-branch <ref>    Base branch/ref to create the worktree from',
    command: '--command <text>       Command to run in the terminal on startup',
    comment: '--comment <text>       Comment stored in Orca metadata',
    cursor: '--cursor <n>           Line cursor from a previous read (returns only new output)',
    action: '--action <name>       Secondary accessibility action name',
    activate: '--activate             Reveal the new worktree in the Orca app',
    app: '--app <app>            App name, bundle ID, or pid:N',
    direction:
      '--direction <dir>      Direction: up|down|left|right for scroll, horizontal|vertical for split',
    'display-name': '--display-name <name>  Override the Orca display name',
    'element-index': '--element-index <n>   Element index from get-app-state',
    title: '--title <text>         Custom title for the terminal tab (omit to reset)',
    enter: '--enter                Append Enter after sending text',
    force:
      '--force                Force worktree removal when supported; does not force branch deletion',
    focus: '--focus                Reveal the created terminal session in Orca',
    for: '--for exit|tui-idle    Wait condition to satisfy',
    'from-element-index': '--from-element-index <n> Source element index from get-app-state',
    'from-x': '--from-x <x>           Source window-local x coordinate',
    'from-y': '--from-y <y>           Source window-local y coordinate',
    help: '--help                 Show this help message',
    'include-visual-layouts':
      '--include-visual-layouts Include tab and pane topology in JSON output',
    interrupt: '--interrupt            Send as an interrupt-style input when supported',
    id: '--id <id>             Identifier for a target item or permission',
    issue: '--issue <number|null>  Linked GitHub issue number',
    'linear-issue':
      '--linear-issue <id|url|null> Linked Linear issue identifier or URL; null clears on set',
    json: '--json                 Emit machine-readable JSON',
    key: '--key <key>            Key argument for this command',
    limit: '--limit <n>            Maximum number of rows to return',
    local: '--local                Target the current project instead of the global install',
    skill: '--skill <name>         Bundled skill to act on; repeat for several',
    mode: '--mode <mode>          Mode such as edit, diff, or both',
    model: '--model <id>          Provider model id for a new agent launch',
    effort: '--effort <level>      Reasoning effort for the selected model',
    'mouse-button': '--mouse-button <btn>   Mouse button: left, right, or middle',
    modifiers: '--modifiers <chord>  Modifier keys held only for this click',
    name: '--name <name>          Name for the new worktree or automation',
    'no-parent': '--no-parent            Force no parent lineage for unrelated work',
    'no-screenshot': '--no-screenshot       Skip screenshot capture after the operation',
    pages: '--pages <n>           Number of scroll pages',
    'parent-worktree':
      '--parent-worktree <selector> Parent worktree selector such as identity:<identity>, id:<repo-id>::<path>, branch:<branch>, issue:<number>, path:<path>, or active/current',
    path: '--path <path>          Path argument for the command',
    prompt: '--prompt <text>        Prompt text for agent-backed commands',
    query: '--query <text>        Search text for matching refs',
    ref: '--ref <ref>            Base ref to persist for the repo',
    repo: '--repo <selector>      Repo selector such as id:<id>, name:<name>, or path:<path>',
    'restore-window':
      '--restore-window     Bring the target app/window forward before the operation',
    session: '--session <id>        Snapshot namespace for a related computer-use workflow',
    setup: '--setup run|skip|inherit Setup policy for repo-defined setup hooks',
    terminal: '--terminal <handle>  Runtime-issued terminal handle',
    text: '--text <text>          Text payload to send or type',
    'text-stdin': '--text-stdin          Read text payload from stdin',
    'task-id': '--task-id <id>        Task id to include in orchestration payload JSON',
    'task-title': '--task-title <text>    Concise title for an orchestration task',
    'dispatch-id': '--dispatch-id <id>    Dispatch id to include in orchestration payload JSON',
    'files-modified': '--files-modified <csv> Comma-separated files for orchestration payload JSON',
    'report-path': '--report-path <path>  Report path to include in orchestration payload JSON',
    phase: '--phase <text>        Worker phase to include in orchestration payload JSON',
    'timeout-ms': '--timeout-ms <ms>     Maximum wait time before timing out',
    'to-element-index': '--to-element-index <n> Destination element index from get-app-state',
    'to-x': '--to-x <x>             Destination window-local x coordinate',
    'to-y': '--to-y <y>             Destination window-local y coordinate',
    worktree:
      '--worktree <selector>  Worktree selector such as identity:<identity>, id:<repo-id>::<path>, name:<displayName>, branch:<branch>, issue:<number>, path:<path>, or active/current',
    workspace: '--workspace <selector> Existing worktree selector for automation runs',
    'workspace-status':
      '--workspace-status <id> Board status id (defaults: todo, in-progress, in-review, completed)',
    staged: '--staged               Open staged source-control changes',
    provider: '--provider <agent>     Agent id such as codex, claude, or gemini',
    'source-context':
      '--source-context <json|null> Explicit TaskSourceContext for automation task/provider data',
    trigger: '--trigger <schedule>   Automation schedule preset, cron, or RRULE',
    schedule: '--schedule <schedule>  Alias for --trigger',
    time: '--time <HH:MM>        Time used with daily/weekdays/weekly presets',
    day: '--day <0-6>           Day used with weekly preset, Sunday=0',
    timezone: '--timezone <tz>       IANA timezone for the automation',
    enabled: '--enabled              Enable the automation',
    disabled: '--disabled             Disable the automation',
    'reuse-session':
      '--reuse-session        Reuse the previous live session for existing-workspace runs',
    'fresh-session': '--fresh-session        Disable session reuse for future runs',
    'workspace-mode': '--workspace-mode <mode> existing or new-per-run',
    'missed-run-grace-minutes': '--missed-run-grace-minutes <n> Missed-run grace window',
    'value-stdin': '--value-stdin         Read set-value payload from stdin',
    'window-id': '--window-id <id>      Target a window id from list-windows',
    'window-index': '--window-index <n>   Target a window index from list-windows',
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
    'no-ua-spoof': "--no-ua-spoof         Keep Electron's native user agent",
    format: '--format <png|jpeg>    Screenshot image format'
  }

  if (flag === 'current') {
    return '--current              Use the current Orca worktree linked Linear issue'
  }
  if (flag === 'comments') {
    return '--comments             Include threaded Linear comments'
  }
  if (flag === 'children') {
    return '--children             Include recursive child issues'
  }
  if (flag === 'depth') {
    return '--depth <n>            Child issue depth for --children/--full'
  }
  if (flag === 'attachments') {
    return '--attachments          Include attachment metadata and URLs'
  }
  if (flag === 'relations') {
    return '--relations            Include blocking, related, and duplicate links'
  }
  if (flag === 'activity') {
    return '--activity             Include issue field-change history'
  }
  if (flag === 'full') {
    return '--full                 Include all supported V1 issue context within caps'
  }

  return helpByFlag[flag] ?? `--${flag}`
}
