// Private build only: `orca cloud …` command specs.
import type { CommandSpec } from '../args'
import { LOCAL_COMMAND_FLAGS } from '../args'

const CREDENTIALS_NOTE =
  'Credentials: ORCA_CLOUD_TOKEN (+ ORCA_CLOUD_API_URL), else ~/.config/orca-cloud/credentials.json (written by `orca cloud login`, and at boot inside an Orca Cloud workspace when the organization allows in-workspace CLI access). These commands call Orca Cloud over HTTPS and do not need the Orca app running.'
const WORKSPACE_ARG_NOTE =
  '<workspace> is a workspace id (sbx_…), a workspace name, or `self` inside an Orca Cloud workspace.'
const JSON_NOTE =
  '--json prints { ok, schemaVersion: 1, result }; failures print { ok: false, error: { code, message, data } }.'

const PROGRESS_ACTIONS: ReadonlySet<string> = new Set(['sleep', 'wake'])

const lifecycle = (
  action: 'sleep' | 'wake' | 'archive' | 'destroy',
  summary: string,
  notes: string[] = []
): CommandSpec => ({
  path: ['cloud', 'workspace', action],
  summary,
  usage: `orca cloud workspace ${action} <workspace>${PROGRESS_ACTIONS.has(action) ? ' [--progress text|json|none]' : ''} [--json]`,
  allowedFlags: [
    ...LOCAL_COMMAND_FLAGS,
    'workspace',
    ...(PROGRESS_ACTIONS.has(action) ? ['progress'] : [])
  ],
  positionalArgs: ['workspace'],
  ...(action === 'destroy' ? { destructive: true } : {}),
  notes: [
    ...notes,
    ...(PROGRESS_ACTIONS.has(action)
      ? [
          'Progress goes to stderr as "- ..." lines (--progress json: NDJSON phase events; --json defaults to none). stdout carries only the result.'
        ]
      : []),
    WORKSPACE_ARG_NOTE,
    'A workspace token cannot sleep, archive or destroy its own workspace.'
  ],
  examples: [`orca cloud workspace ${action} sbx_0123abcd --json`]
})

export const CLOUD_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['cloud', 'whoami'],
    summary: 'Show the Orca Cloud account, role and scopes these credentials act as',
    usage: 'orca cloud whoami [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    notes: [CREDENTIALS_NOTE, JSON_NOTE],
    examples: ['orca cloud whoami', 'orca cloud whoami --json']
  },
  {
    path: ['cloud', 'login'],
    summary: 'Save an Orca Cloud API key or session token for the CLI',
    usage: 'orca cloud login [--token <token>] [--api-url <url>] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'token', 'api-url'],
    notes: [
      'Checks the token with Orca Cloud, then writes ~/.config/orca-cloud/credentials.json (mode 0600).',
      'Without --token the token is read from piped stdin, which keeps it out of shell history.',
      '--api-url is needed on first login; later logins reuse the saved URL.'
    ],
    examples: [
      'printf %s "$ORCA_KEY" | orca cloud login --api-url https://cloud.example.com',
      'orca cloud login --token orca_sk_… --api-url https://cloud.example.com'
    ]
  },
  {
    path: ['cloud', 'logout'],
    summary: 'Delete the saved Orca Cloud credentials file',
    usage: 'orca cloud logout [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    destructive: true
  },
  {
    path: ['cloud', 'workspace', 'list'],
    summary: 'List Orca Cloud workspaces',
    usage:
      'orca cloud workspace list [--project <id-or-name>] [--include-archived] [--all] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'project', 'include-archived', 'all'],
    notes: [
      '--all also lists archived and hidden workspaces.',
      'A workspace token (inside a VM) lists only the workspaces that workspace created.',
      JSON_NOTE
    ],
    examples: ['orca cloud workspace list', 'orca cloud workspace list --all --json']
  },
  {
    path: ['cloud', 'workspace', 'show'],
    summary: 'Show one Orca Cloud workspace',
    usage: 'orca cloud workspace show <workspace> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'workspace'],
    positionalArgs: ['workspace'],
    notes: [WORKSPACE_ARG_NOTE, JSON_NOTE],
    examples: ['orca cloud workspace show self --json']
  },
  {
    path: ['cloud', 'workspace', 'create'],
    summary: 'Create an Orca Cloud workspace and wait until it is running',
    usage:
      'orca cloud workspace create [--name <name>] [--project <id-or-name>] [--repo <https-url> [--ref <ref>]] [--size standard|large] [--region <region>] [--agent claude|codex --prompt <text>] [--json]',
    allowedFlags: [
      ...LOCAL_COMMAND_FLAGS,
      'name',
      'project',
      'repo',
      'ref',
      'size',
      'region',
      'agent',
      'prompt'
    ],
    notes: [
      'Returns once the VM is running. --prompt queues a first message for --agent (default claude), delivered as soon as the VM is up; follow it with `orca cloud messages`.',
      'Inside a workspace (workspace token) the new workspace is recorded with origin "vm" and is visible to the workspace that created it.',
      CREDENTIALS_NOTE,
      JSON_NOTE
    ],
    examples: [
      'orca cloud workspace create --name child --json',
      'orca cloud workspace create --repo https://github.com/acme/app --name fix-login --agent claude --prompt "Fix the login redirect"'
    ]
  },
  lifecycle('sleep', 'Put an Orca Cloud workspace to sleep (disk kept, not billed)'),
  lifecycle('wake', 'Wake a sleeping or archived Orca Cloud workspace'),
  lifecycle('archive', 'Sleep an Orca Cloud workspace and hide it from default lists'),
  lifecycle('destroy', 'Destroy an Orca Cloud workspace and its disk', ['This cannot be undone.']),
  {
    path: ['cloud', 'message'],
    summary: 'Send a message to an agent in an Orca Cloud workspace',
    usage:
      'orca cloud message <workspace> --text <text> [--agent claude|codex] [--session <handle>] [--wait [--timeout <seconds>]] [--json]',
    allowedFlags: [
      ...LOCAL_COMMAND_FLAGS,
      'workspace',
      'text',
      'agent',
      'session',
      'wait',
      'timeout'
    ],
    positionalArgs: ['workspace'],
    notes: [
      'Without --session a new agent session starts with the text as its prompt; --session <handle> (from `orca cloud sessions` or a previous message) types it into that session.',
      'A sleeping workspace is woken first. --wait polls until the message is delivered to the agent (default timeout 180s); it does not wait for the agent to finish.',
      WORKSPACE_ARG_NOTE,
      JSON_NOTE
    ],
    examples: [
      'orca cloud message my-ws --text "Run the tests and fix failures" --wait',
      'orca cloud message sbx_0123abcd --session term_abc --text "Also update the changelog" --json'
    ]
  },
  {
    path: ['cloud', 'messages'],
    summary: 'List recent messages sent to an Orca Cloud workspace, or show one',
    usage: 'orca cloud messages <workspace> [<message-id>] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'workspace', 'message'],
    positionalArgs: ['workspace', 'message'],
    notes: [
      'Shows delivery status (queued, delivering, delivered, failed) and the session handle.',
      WORKSPACE_ARG_NOTE,
      JSON_NOTE
    ],
    examples: ['orca cloud messages my-ws', 'orca cloud messages sbx_0123abcd msg_abc --json']
  },
  {
    path: ['cloud', 'sessions'],
    summary: 'List agent sessions running in an Orca Cloud workspace',
    usage: 'orca cloud sessions <workspace> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'workspace'],
    positionalArgs: ['workspace'],
    notes: [
      'Only a running workspace has live sessions; a sleeping one lists none.',
      WORKSPACE_ARG_NOTE,
      JSON_NOTE
    ],
    examples: ['orca cloud sessions my-ws --json']
  },
  {
    path: ['cloud', 'projects', 'list'],
    summary: 'List Orca Cloud projects (repo + environment defaults for new workspaces)',
    usage: 'orca cloud projects list [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    notes: [JSON_NOTE]
  }
]
