import type { McpToolArg, McpToolDefinition } from './mcp-tool-input'

// Long waits block the client's tool call; keep them short and poll instead.
const TERMINAL_WAIT_MAX_MS = 120_000

const WORKTREE_SELECTOR =
  'Worktree selector: id:<worktreeId>, path:<absolute path>, branch:<name>, issue:<number>, or active. Use worktree_list to find ids.'
const TERMINAL_HANDLE = 'Terminal handle (term_...) from terminal_list or an agent launch result.'

const AGENT_OPTION_ARGS: readonly McpToolArg[] = [
  { name: 'model', flag: 'model', type: 'string', description: 'Provider model id.' },
  {
    name: 'effort',
    flag: 'effort',
    type: 'string',
    description: 'Reasoning effort for the model. Requires model.'
  },
  {
    name: 'surface',
    flag: 'surface',
    type: 'string',
    enum: ['chat', 'terminal'],
    description: 'Start the agent as a chat or a terminal instead of the user setting.'
  }
]

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'orca_status',
    title: 'Orca status',
    description:
      'Check that Orca is running and reachable. Call this first when another tool reports runtime_unavailable.',
    command: ['status'],
    args: [],
    readOnly: true
  },
  {
    name: 'worktree_list',
    title: 'List worktrees',
    description:
      'List Orca-managed worktrees and folder workspaces with their ids, paths and branches.',
    command: ['worktree', 'list'],
    args: [
      {
        name: 'repo',
        flag: 'repo',
        type: 'string',
        description: 'Only this repo: id:<repoId>, name:<name> or path:<path>.'
      },
      { name: 'limit', flag: 'limit', type: 'integer', description: 'Maximum rows to return.' }
    ],
    readOnly: true
  },
  {
    name: 'worktree_ps',
    title: 'Agent overview',
    description:
      'Compact summary across worktrees: each live agent with its terminal handle and state. Use it to poll launched agents. An idle agent finished its turn and is waiting for input; it is not dead.',
    command: ['worktree', 'ps'],
    args: [
      { name: 'limit', flag: 'limit', type: 'integer', description: 'Maximum rows to return.' },
      {
        name: 'agentWait',
        flag: 'agent-wait',
        type: 'boolean',
        description: 'Add the wait verdict (working, idle, waiting for approval) to each agent row.'
      }
    ],
    readOnly: true
  },
  {
    name: 'worktree_create',
    title: 'Create worktree',
    description:
      'Create a new git worktree, optionally starting an agent in it with a first prompt. Returns as soon as the worktree exists; the agent keeps working in the background. Write the prompt as one self-contained instruction: what done looks like, which files, how to verify.',
    command: ['worktree', 'create'],
    args: [
      {
        name: 'name',
        flag: 'name',
        type: 'string',
        required: true,
        description: 'Worktree name.'
      },
      {
        name: 'repo',
        flag: 'repo',
        type: 'string',
        description:
          'Repo selector (id:<repoId> from worktree_list). Required unless the server runs inside an Orca worktree.'
      },
      {
        name: 'baseBranch',
        flag: 'base-branch',
        type: 'string',
        description: 'Starting ref; defaults to the repo base branch.'
      },
      {
        name: 'agent',
        flag: 'agent',
        type: 'string',
        description: 'Agent to start in the new worktree, for example claude or codex.'
      },
      {
        name: 'prompt',
        flag: 'prompt',
        type: 'string',
        description: 'First prompt for the agent. Requires agent.'
      },
      ...AGENT_OPTION_ARGS,
      {
        name: 'noParent',
        flag: 'no-parent',
        type: 'boolean',
        description: 'Do not record the new worktree as a child of the current one.'
      }
    ],
    readOnly: false
  },
  {
    name: 'agent_launch',
    title: 'Launch agent',
    description:
      'Start an agent in an existing worktree. Returns the new terminal or chat handle at once; the agent works in the background. To continue an agent that is idle, use terminal_send on its terminal instead: a new launch starts without the earlier context.',
    command: ['agent', 'launch'],
    args: [
      {
        name: 'agent',
        flag: 'agent',
        type: 'string',
        required: true,
        description: 'Agent id, for example claude or codex.'
      },
      {
        name: 'worktree',
        flag: 'worktree',
        type: 'string',
        required: true,
        description: WORKTREE_SELECTOR
      },
      {
        name: 'prompt',
        flag: 'prompt',
        type: 'string',
        description:
          'First prompt: one self-contained instruction with what done looks like, which files, and how to verify.'
      },
      ...AGENT_OPTION_ARGS
    ],
    readOnly: false
  },
  {
    name: 'terminal_list',
    title: 'List terminals',
    description: 'List live Orca terminals with their handles, titles and worktrees.',
    command: ['terminal', 'list'],
    args: [
      { name: 'worktree', flag: 'worktree', type: 'string', description: WORKTREE_SELECTOR },
      { name: 'limit', flag: 'limit', type: 'integer', description: 'Maximum rows to return.' }
    ],
    readOnly: true
  },
  {
    name: 'terminal_read',
    title: 'Read terminal',
    description:
      "Read a terminal's output. Pass the nextCursor from the previous read as cursor to get only new output. Use screen for the rendered screen of a TUI agent.",
    command: ['terminal', 'read'],
    args: [
      {
        name: 'terminal',
        flag: 'terminal',
        type: 'string',
        required: true,
        description: TERMINAL_HANDLE
      },
      {
        name: 'cursor',
        flag: 'cursor',
        type: 'string',
        description: 'nextCursor from a previous read (a string of digits).'
      },
      { name: 'limit', flag: 'limit', type: 'integer', description: 'Maximum lines to return.' },
      {
        name: 'screen',
        flag: 'screen',
        type: 'boolean',
        description: 'Read the rendered screen instead of accumulated output. Not with cursor.'
      }
    ],
    readOnly: true
  },
  {
    name: 'terminal_send',
    title: 'Send to terminal',
    description:
      'Type text into a terminal. With enter, a prompt to a running agent is submitted as a follow-up turn that keeps its context. Prefer this over a new launch for an idle agent.',
    command: ['terminal', 'send'],
    args: [
      {
        name: 'terminal',
        flag: 'terminal',
        type: 'string',
        required: true,
        description: TERMINAL_HANDLE
      },
      { name: 'text', flag: 'text', type: 'string', description: 'Text to send.' },
      {
        name: 'enter',
        flag: 'enter',
        type: 'boolean',
        description: 'Press Enter after the text to submit it.'
      },
      {
        name: 'interrupt',
        flag: 'interrupt',
        type: 'boolean',
        description: 'Send Ctrl+C first.'
      }
    ],
    readOnly: false
  },
  {
    name: 'terminal_wait',
    title: 'Wait for terminal',
    description: `Block until an agent goes idle (for: tui-idle) or a command exits (for: exit), at most timeoutMs (default and maximum ${TERMINAL_WAIT_MAX_MS} ms). A timeout error only means the agent is still working: call again or poll with worktree_ps; do not relaunch it.`,
    command: ['terminal', 'wait'],
    args: [
      {
        name: 'terminal',
        flag: 'terminal',
        type: 'string',
        required: true,
        description: TERMINAL_HANDLE
      },
      {
        name: 'for',
        flag: 'for',
        type: 'string',
        required: true,
        enum: ['tui-idle', 'exit'],
        description: 'Condition to wait for.'
      },
      {
        name: 'timeoutMs',
        flag: 'timeout-ms',
        type: 'integer',
        maximum: TERMINAL_WAIT_MAX_MS,
        // An omitted timeout would block for the CLI's five-minute default.
        defaultValue: TERMINAL_WAIT_MAX_MS,
        description: 'Maximum time to wait in milliseconds.'
      }
    ],
    readOnly: true,
    maxRuntimeMs: TERMINAL_WAIT_MAX_MS + 30_000
  },
  {
    name: 'orchestration_run_list',
    title: 'List orchestration runs',
    description: 'List orchestration runs with their ids and objectives, newest first.',
    command: ['orchestration', 'run-list'],
    args: [
      { name: 'limit', flag: 'limit', type: 'integer', description: 'Maximum rows to return.' }
    ],
    readOnly: true
  },
  {
    name: 'orchestration_task_list',
    title: 'List orchestration tasks',
    description:
      'List the tasks of one orchestration run with their status, for supervising multi-agent work.',
    command: ['orchestration', 'task-list'],
    args: [
      {
        name: 'run',
        flag: 'run',
        type: 'string',
        required: true,
        description: 'Run id from orchestration_run_list.'
      },
      {
        name: 'status',
        flag: 'status',
        type: 'string',
        enum: ['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'],
        description: 'Only tasks in this status.'
      },
      {
        name: 'ready',
        flag: 'ready',
        type: 'boolean',
        description: 'Only tasks ready to dispatch.'
      }
    ],
    readOnly: true
  }
]
