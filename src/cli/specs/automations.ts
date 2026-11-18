import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

const AUTOMATION_TARGET_FLAGS = [
  'repo',
  'workspace',
  'project',
  'host',
  'project-host-setup',
  'source-context',
  'workspace-mode',
  'base-branch',
  'setup'
]
const AUTOMATION_SCHEDULE_FLAGS = ['trigger', 'schedule', 'time', 'day', 'timezone']
const AUTOMATION_PRECHECK_FLAGS = ['precheck', 'precheck-timeout']
const AUTOMATION_STATE_FLAGS = [
  'enabled',
  'disabled',
  'missed-run-grace-minutes',
  'reuse-session',
  'fresh-session'
]

export const AUTOMATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['automations', 'list'],
    summary: 'List scheduled Orca automations',
    usage: 'orca automations list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca automations list', 'orca automations list --json']
  },
  {
    path: ['automations', 'show'],
    summary: 'Show one Orca automation',
    usage: 'orca automations show <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: ['orca automations show 2f9e...', 'orca automations show --id 2f9e... --json']
  },
  {
    path: ['automations', 'create'],
    summary: 'Create a scheduled Orca automation',
    usage:
      'orca automations create --name <name> (--trigger <preset|cron|rrule> | --on "<source>.<event> ..."...) --prompt <text> (--provider <agent> [--setup run|skip] [--repo <selector>|--workspace <selector>|--project <id-or-name> [--host <host>]|--project-host-setup <id>] | --bot <name> [--agent <agent> [--model <id>] [--effort <level>]] [--runs-in new|chat|chat:<id>] [--results-to chat|thread|none|channel:<channel>] [--once [--by <time>]]) [--precheck <command>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'name',
      'prompt',
      'provider',
      'extra-agent-args',
      'bot',
      'agent',
      'model',
      'effort',
      'runs-in',
      'results-to',
      'on',
      'once',
      'by',
      ...AUTOMATION_PRECHECK_FLAGS,
      ...AUTOMATION_TARGET_FLAGS,
      ...AUTOMATION_SCHEDULE_FLAGS,
      ...AUTOMATION_STATE_FLAGS
    ],
    notes: [
      "Trigger accepts hourly, daily, weekdays, weekly, a 5-field cron expression, or an RRULE string. Times are the host's local time unless --timezone names a zone.",
      'When --repo is omitted, the CLI uses the enclosing Orca worktree when one can be resolved from cwd.',
      'Use --project, or --project-host-setup, to run on a specific project host setup. --project takes the project id or the display name from `orca project list`, and --host is only needed when the project is set up on more than one host.',
      '--host takes local, ssh:<target-id>, runtime:<environment-id>, or the bare host name `orca host list` prints for any of them.',
      'Use --source-context with a JSON TaskSourceContext when task/provider data should come from a specific host/account; pass null on edit to clear it.',
      'Use --workspace to run in an existing worktree. With --repo or a project target, the automation creates a new worktree per run; with no target, a local create runs in the current Orca worktree unless you pass --workspace-mode new-per-run.',
      'Use --setup run|skip for repository setup on new-per-run automations. Explicit choices override the repository setup policy and need a host running current Orca. When omitted on create, no choice is saved; current Orca skips setup.',
      'Use --precheck to run a command only before scheduled runs; exit code 0 continues, any other exit, error, or timeout skips the run.',
      'Use --precheck-timeout <seconds> to set the time limit (default 60 seconds). Skips appear in Orca run history and orca automations runs --id <automation-id> as skipped_precheck.',
      'Run now in Orca and orca automations run intentionally bypass the precheck so you can test or override the scheduled condition.',
      'Use --reuse-session only with existing-workspace automations to submit later runs to the previous live automation session when it is still available. Use --fresh-session to disable reuse.',
      "Use --bot <name> to run as a bot, in its folder with its agent; --provider and the project flags do not apply. --runs-in new (default) starts a new conversation each run, except that one a teammate asks for from their chat runs in that chat, so its results reach them there; chat continues the bot's Chat; chat:<id> (from `orca bot chats`) continues that chat, and a run fails if it was closed. --results-to says where the result goes: chat (the default), thread, none, channel:<channel> (a #name, link or id), or linear:<issue> (a bot on Linear; ENG-123 or a link); keep the default unless asked for another place. thread answers in the Slack thread, pull request or issue the event happened on, where the run can also post updates with `orca bot reply`; it is the default for an automation that only Slack, GitHub or Linear events start, and needs --runs-in new.",
      'Use --on "<source>.<event> [in=<place>,<place>] [subject=<one>] [contains="<text>"] [from=<people>]" (repeatable, bots only) to start a run each time the event happens, whoever does it (from= narrows it to some people, by @name or id; on=mine keeps a slack.reaction to reactions on your own messages); it takes the place of --trigger, and both together are refused (make two automations for a schedule and events). `orca automations trigger-options` lists the events, and `orca bot connectors` the bot\'s workspaces and teams as refs for in=.',
      "Use --agent <agent> [--model <id>] [--effort <level>] (bots only, with --runs-in new) to run a bot's automation on another agent or model than the bot's own; it keeps the bot's folder, memory, connectors and results. Use it instead of a project automation when a bot's job needs another model. Without --agent, --model and --effort apply to the bot's current agent.",
      "Use --once (bots only) for a wait: it runs a single time, on the first matching --on event, and is then deleted. Add --by <ISO time> to also run it at that time if no event came first; the run's prompt then says the deadline came. Without --by it runs only if the event happens, and ends unrun after 30 days. A wait runs in the chat that made it (or the bot's Chat if made elsewhere, or if that chat is closed when it fires) and reports there unless --runs-in or --results-to say otherwise; with --by and no --on it is a one-time reminder.",
      'Use --extra-agent-args="--model opus --effort high" to add arguments after the host\'s default agent Arguments on each fresh run. Only model, effort, and a few safe options are accepted (Antigravity, Claude, Codex, CodeBuddy, Cursor, Grok, OMP, Pi); extras cannot be combined with --reuse-session. On edit, --extra-agent-args= clears them.'
    ],
    examples: [
      'orca automations create --name "Daily review" --trigger daily --prompt "Review open changes" --provider codex',
      'orca automations create --name "Weekday triage" --trigger "0 9 * * 1-5" --prompt "Triage issues" --provider claude --repo my-repo',
      'orca automations create --name "PR review" --trigger hourly --precheck "gh pr list --json number -q .[0].number" --prompt "Review requested PRs" --provider codex',
      'orca automations create --name "Docs pass" --trigger daily --prompt "Tidy the docs" --provider claude --extra-agent-args="--model opus --effort high --add-dir docs"',
      'orca automations create --name "Nora\'s reply in #orca" --bot ranger --once --by 2026-11-06T17:00:00-05:00 --prompt "Tell me what Nora said; if the deadline came first, remind me he hasn\'t replied" --on "slack.message subject=<thread link> from=@nora"',
      'orca automations create --name "Stall investigator" --bot ranger --trigger "*/30 * * * *" --agent codex --model gpt-6.1-terra --effort high --results-to channel:C0123ABCD --prompt "Investigate stalls"',
      'orca automations create --name "Deploy pings" --bot ranger --prompt "Answer the deploy question" --on "slack.mentioned in=C0123ABCD contains=deploy"'
    ],
    repeatableFlags: ['on']
  },
  {
    path: ['automations', 'edit'],
    summary: 'Edit an Orca automation',
    usage:
      'orca automations edit <id> [--name <name>] [--trigger <preset|cron|rrule|none>] [--on "<source>.<event> ..."|none]... [--setup run|skip] [--agent <agent>|bot] [--model <id>] [--effort <level>] [--runs-in new|chat|chat:<id>] [--results-to chat|thread|none|channel:<channel>|linear:<issue>] [--once [--by <time>]] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'id',
      'name',
      'prompt',
      'provider',
      'extra-agent-args',
      'on',
      'agent',
      'model',
      'effort',
      'runs-in',
      'results-to',
      'once',
      'by',
      ...AUTOMATION_PRECHECK_FLAGS,
      ...AUTOMATION_TARGET_FLAGS,
      ...AUTOMATION_SCHEDULE_FLAGS,
      ...AUTOMATION_STATE_FLAGS
    ],
    positionalArgs: ['id'],
    repeatableFlags: ['on'],
    notes: [
      "--on replaces the bot automation's events; --on none removes them. --trigger none removes the schedule, leaving its events.",
      '--runs-in and --results-to change where a bot automation runs and where its results go, as on create; the automation keeps its id and run history.',
      "--agent, --model and --effort change a bot automation's own agent: --model or --effort alone keeps its agent and other choices; another --agent starts that agent on its defaults; --agent bot goes back to the bot's agent.",
      'Use --setup run|skip only for new-per-run automations. Omit it to preserve the saved setup choice.'
    ],
    examples: [
      'orca automations edit 2f9e... --disabled',
      'orca automations edit --id 2f9e... --trigger "30 * * * *" --json',
      'orca automations edit 2f9e... --extra-agent-args=',
      'orca automations edit 2f9e... --on "slack.mentioned in=C0123ABCD" --on "slack.reaction in=C0123ABCD contains=:rocket:"',
      'orca automations edit 2f9e... --runs-in chat --results-to channel:C0123ABCD',
      'orca automations edit 2f9e... --agent bot'
    ]
  },
  {
    path: ['automations', 'trigger-options'],
    summary: 'List the events a bot automation can start on',
    usage:
      'orca automations trigger-options [--bot <name>] [--source slack|github|linear] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'source', 'bot'],
    notes: ["Use --bot to see which sources that bot's connectors let it start on."],
    examples: [
      'orca automations trigger-options --bot Ranger',
      'orca automations trigger-options --source github'
    ]
  },
  {
    path: ['automations', 'remove'],
    aliases: [['automations', 'delete']],
    destructive: true,
    summary: 'Remove an Orca automation and its run history',
    usage: 'orca automations remove <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: ['orca automations remove 2f9e...', 'orca automations remove --id 2f9e... --json']
  },
  {
    path: ['automations', 'run'],
    summary: 'Run an Orca automation now',
    usage: 'orca automations run <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    notes: [
      'Use the full automation UUID from orca automations list; shortened prefixes are not accepted.',
      'Like Run now in Orca, this manually starts a run without executing the precheck; prechecks gate scheduled runs only.',
      'A queued or dispatching run has been accepted but may not have a workspace or terminal yet. Use orca automations runs --id <automation-id> to follow its progress.'
    ],
    examples: [
      'orca automations run 497bafa9-5a97-4f85-9e48-2b211b8f31fa',
      'orca automations run --id 497bafa9-5a97-4f85-9e48-2b211b8f31fa --json'
    ]
  },
  {
    path: ['automations', 'runs'],
    summary: 'List automation run history',
    usage:
      'orca automations runs [--id <automation-id>] [--limit <n>] [--cursor <cursor>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'limit', 'cursor'],
    notes: [
      'Without --limit or --cursor, reads the whole history in pages, so a large history from a paired server still fits in its replies.',
      'With --limit or --cursor, prints one page (newest first, at most 100 runs) and its nextCursor; pass that as --cursor for the next page.'
    ],
    examples: [
      'orca automations runs',
      'orca automations runs --id 2f9e... --json',
      'orca automations runs --limit 20 --json'
    ]
  }
]
