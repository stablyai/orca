// Private build only: `orca cloud …` command specs.
import type { CommandSpec } from '../discovery/command-spec'
import { LOCAL_COMMAND_FLAGS } from '../arguments/args'
import { ORCA_CLOUD_SANDBOX_SPEC } from '../../shared/hosted-sandbox/orca-cloud-sandbox-spec'

const CREDENTIALS_NOTE =
  'Credentials: ORCA_CLOUD_TOKEN (+ ORCA_CLOUD_API_URL), else ~/.config/orca-cloud/credentials.json (written by `orca cloud login`, and at boot inside an Orca Cloud workspace when the team allows in-workspace CLI access). These commands call Orca Cloud over HTTPS and do not need the Orca app running.'
const WORKSPACE_ARG_NOTE =
  '<workspace> is a workspace id (sbx_…), a workspace name, or `self` inside an Orca Cloud workspace.'
const JSON_NOTE =
  '--json prints { ok, schemaVersion: 1, result }; failures print { ok: false, error: { code, message, data } }.'

const PROGRESS_ACTIONS: ReadonlySet<string> = new Set(['sleep', 'wake'])

const lifecycle = (
  action: 'sleep' | 'wake' | 'archive' | 'delete' | 'destroy',
  summary: string,
  notes: string[] = [],
  extra: Partial<CommandSpec> = {}
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
  ...(action === 'delete' || action === 'destroy' ? { destructive: true } : {}),
  notes: [
    ...notes,
    ...(PROGRESS_ACTIONS.has(action)
      ? [
          'Progress goes to stderr as "- ..." lines (--progress json: NDJSON phase events; --json defaults to none). stdout carries only the result.'
        ]
      : []),
    WORKSPACE_ARG_NOTE,
    'A workspace token cannot sleep, archive or delete its own workspace.'
  ],
  examples: [`orca cloud workspace ${action} sbx_0123abcd --json`],
  ...extra
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
      'A workspace token (inside a sandbox) lists only the workspaces that workspace created.',
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
      'orca cloud workspace create [--name <name>] [--project <id-or-name>] [--repo <https-url> [--ref <ref>]] [--region <region>] [--prompt <text> [--agent claude|codex]] [--idempotency-key <key>] [--progress text|json|none] [--json]',
    allowedFlags: [
      ...LOCAL_COMMAND_FLAGS,
      'name',
      'project',
      'repo',
      'ref',
      'region',
      'agent',
      'prompt',
      'idempotency-key',
      'progress'
    ],
    notes: [
      'Returns once the sandbox is running. --prompt queues a first message for --agent (default claude), delivered as soon as the sandbox is up; follow it with `orca cloud messages`.',
      'Progress goes to stderr (--progress, default text; none with --json). A retry with the same --idempotency-key never creates a second workspace.',
      `Every sandbox is ${ORCA_CLOUD_SANDBOX_SPEC.vcpus} vCPU · ${ORCA_CLOUD_SANDBOX_SPEC.memoryGb} GB; there is no size to pick.`,
      'Inside a workspace (workspace token) the new workspace is visible to the workspace that created it.',
      CREDENTIALS_NOTE,
      JSON_NOTE
    ],
    examples: [
      'orca cloud workspace create --name child --json',
      'orca cloud workspace create --repo https://github.com/acme/app --name fix-login --agent claude --prompt "Fix the login redirect"'
    ]
  },
  lifecycle(
    'sleep',
    'Put an Orca Cloud workspace to sleep (files are kept; asleep time is not billed)'
  ),
  lifecycle('wake', 'Wake an asleep or archived Orca Cloud workspace'),
  lifecycle('archive', 'Put an Orca Cloud workspace to sleep and hide it from default lists'),
  lifecycle('delete', 'Delete an Orca Cloud workspace and its sandbox for good', [
    'This cannot be undone.'
  ]),
  // Renamed to `delete`; kept hidden so existing scripts keep working.
  lifecycle('destroy', 'Delete an Orca Cloud workspace and its sandbox for good', [], {
    hidden: true
  }),
  {
    path: ['cloud', 'message'],
    summary: 'Send a message to an agent in an Orca Cloud workspace',
    usage:
      'orca cloud message <workspace> --text <text> [--agent claude|codex] [--session <handle>] [--wait [--timeout <seconds>]] [--idempotency-key <key>] [--json]',
    allowedFlags: [
      ...LOCAL_COMMAND_FLAGS,
      'workspace',
      'text',
      'agent',
      'session',
      'wait',
      'timeout',
      'idempotency-key'
    ],
    positionalArgs: ['workspace'],
    notes: [
      'Without --session a new agent session starts with the text as its prompt; --session <handle> (from `orca cloud sessions` or a previous message) types it into that session.',
      'An asleep workspace wakes first. --wait polls until the message is delivered to the agent (default timeout 180s); it does not wait for the agent to finish.',
      'A retry with the same --idempotency-key never sends the message twice.',
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
      'Only a running workspace has live sessions; an asleep one lists none.',
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
  },
  {
    path: ['cloud', 'routine', 'list'],
    summary: 'List Orca Cloud routines with their trigger and last run',
    usage: 'orca cloud routine list [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    notes: ['Needs the routines:read scope.', JSON_NOTE],
    examples: ['orca cloud routine list', 'orca cloud routine list --json']
  },
  {
    path: ['cloud', 'routine', 'run'],
    summary: 'Run an Orca Cloud routine now',
    usage:
      'orca cloud routine run <routine> [--wait [--timeout <seconds>] [--progress text|json|none]] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'routine', 'wait', 'timeout', 'progress'],
    positionalArgs: ['routine'],
    notes: [
      '<routine> is a routine id (rtn_…) or its exact name. Only the routine’s creator can run it. Needs the routines:write scope.',
      'The run starts its own cloud workspace. Run states: Queued, Starting, Running, Posting results, Succeeded, Failed, Canceled, Timed out.',
      '--wait follows the run until it finishes (default timeout: the routine’s time limit plus 15 minutes) and exits non-zero if it fails, times out or is canceled. State changes go to stderr.',
      JSON_NOTE
    ],
    examples: [
      'orca cloud routine run "Triage new issues"',
      'orca cloud routine run rtn_0123abcd --wait --json'
    ]
  }
]
