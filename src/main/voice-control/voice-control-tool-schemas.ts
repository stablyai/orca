import {
  BROADCAST_TOOL_NAME,
  CLICK_ELEMENT_TOOL_NAME,
  DESCRIBE_SCREEN_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  MESSAGE_AGENT_TOOL_NAME,
  NAVIGATE_UI_TOOL_NAME,
  OPEN_URL_TOOL_NAME,
  READ_TERMINAL_TOOL_NAME,
  RUN_COMMAND_TOOL_NAME,
  SEE_SCREEN_TOOL_NAME,
  START_AGENT_TOOL_NAME,
  TYPE_INTO_TOOL_NAME,
  VOICE_NAVIGATE_VERBS
} from '../../shared/voice-control-types'

/**
 * Function tools declared on the control's realtime session. The audio model IS the
 * coordinator: it checks things itself with run_command, routes work to agents with
 * message_agent/broadcast, and answers "who's running" with list_agents.
 * `parameters` is a raw JSON-schema fragment — the caller builds it, this module only
 * keeps the shared shape.
 */

export type RealtimeToolSchema = {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false
}

function stringParams(...names: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(names.map((name) => [name, { type: 'string' }])),
    required: names,
    additionalProperties: false
  }
}

export const listAgentsToolSchema: RealtimeToolSchema = {
  type: 'function',
  name: LIST_AGENTS_TOOL_NAME,
  description:
    "List the coding agents currently running in the user's workspace, with their spoken names and what each is doing.",
  parameters: EMPTY_OBJECT_SCHEMA
}

export const messageAgentToolSchema: RealtimeToolSchema = {
  type: 'function',
  name: MESSAGE_AGENT_TOOL_NAME,
  description:
    'Send a message to one named agent, verbatim. Use the spoken name from list_agents. The reply is spoken to the user when the agent responds.',
  parameters: stringParams('name', 'message')
}

export const startAgentToolSchema: RealtimeToolSchema = {
  type: 'function',
  name: START_AGENT_TOOL_NAME,
  description:
    'Start an agent in a worktree that has none running, with its first task. "Resume that worktree", "start an agent on X", "wake up oak" — this is the path; the task is delivered on launch and the agent reports back like any messaged agent. If the worktree already has a running agent this just messages it. The agent CLI is picked for you (the worktree\'s previous agent, then the configured default, then an installed one) — pass `agent` only when the user names one.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      message: { type: 'string' },
      agent: {
        type: 'string',
        description:
          'Optional agent CLI id when the user names one — e.g. "claude", "codex", "gemini". Omit to auto-pick.'
      }
    },
    required: ['name', 'message'],
    additionalProperties: false
  }
}

export const broadcastToolSchema: RealtimeToolSchema = {
  type: 'function',
  name: BROADCAST_TOOL_NAME,
  description: 'Send the same message to every running agent. Each reply is spoken, attributed.',
  parameters: stringParams('message')
}

export const navigateUiToolSchema: RealtimeToolSchema = {
  type: 'function',
  name: NAVIGATE_UI_TOOL_NAME,
  description:
    "Show the user something on screen in Orca: bring an agent's pane forward, open a surface (settings, task list, agent dashboard, workspace board, quick-open file picker, floating terminal, a browser tab, sidebars), or leave settings with close-settings. Use this for every 'open it' / 'show me' / 'on screen' request, and for 'go back' / 'get me out of settings'.",
  parameters: {
    type: 'object',
    properties: {
      verb: { type: 'string', enum: [...VOICE_NAVIGATE_VERBS] },
      agent: {
        type: 'string',
        description: 'Spoken agent name; required for the focus-agent verb, ignored otherwise.'
      }
    },
    required: ['verb'],
    additionalProperties: false
  }
}

export const runCommandToolSchema: RealtimeToolSchema = {
  type: 'function',
  name: RUN_COMMAND_TOOL_NAME,
  description:
    "Run a shell command yourself and read its output — use it to check anything directly (git state, files, processes, the orca CLI). Runs in the named agent's workspace, or the user's default workspace when omitted. 15 second limit; long work belongs to agents via message_agent.",
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      agent: {
        type: 'string',
        description: 'Optional spoken agent name whose workspace the command runs in.'
      }
    },
    required: ['command'],
    additionalProperties: false
  }
}

export const describeScreenToolSchema: RealtimeToolSchema = {
  type: 'function',
  name: DESCRIBE_SCREEN_TOOL_NAME,
  description:
    "See what is on the user's Orca screen right now: the active view and workspace, open tabs (with the focused one marked), and sidebar state. Use it for 'what am I looking at?', 'what's on my screen?', or to orient before navigating.",
  parameters: EMPTY_OBJECT_SCHEMA
}

export const seeScreenToolSchema: RealtimeToolSchema = {
  type: 'function',
  name: SEE_SCREEN_TOOL_NAME,
  description:
    "Read the actual Orca UI on the user's screen: every visible button, chip, link, field, tab, and row as an indented tree with refs — list contents included (issue titles, file names). Use it when describe_screen's overview is not enough, when the user asks what is listed or shown, and ALWAYS before click_element or type_into: refs come from the latest see_screen.",
  parameters: EMPTY_OBJECT_SCHEMA
}

// The tree prints refs as [@e12]; the model sometimes transcribes without the sigil
// (live: "e36" looped on Unknown ref twice). The description pins the exact shape at
// the source; the driver additionally tolerates the missing @.
const REF_PARAM = {
  type: 'string',
  description:
    'The element ref exactly as shown in the latest see_screen, sigil included — e.g. "@e12".'
}

export const clickElementToolSchema: RealtimeToolSchema = {
  type: 'function',
  name: CLICK_ELEMENT_TOOL_NAME,
  description:
    "Click a UI element by its ref from the latest see_screen — chips, buttons, tabs, links, rows. 'Click X', 'filter to mine', 'press that button' → see_screen first, then this. Returns the fresh screen after the click.",
  parameters: {
    type: 'object',
    properties: { ref: REF_PARAM },
    required: ['ref'],
    additionalProperties: false
  }
}

export const typeIntoToolSchema: RealtimeToolSchema = {
  type: 'function',
  name: TYPE_INTO_TOOL_NAME,
  description:
    'Type text into a text field by its ref from the latest see_screen. Not for terminal panes — use run_command for shell input. Returns the fresh screen after typing.',
  parameters: {
    type: 'object',
    properties: {
      ref: REF_PARAM,
      text: { type: 'string', description: 'The text to insert.' }
    },
    required: ['ref', 'text'],
    additionalProperties: false
  }
}

export const readTerminalToolSchema: RealtimeToolSchema = {
  type: 'function',
  name: READ_TERMINAL_TOOL_NAME,
  description:
    "Read the visible text of the terminal pane(s) currently on the user's Orca screen — what's actually showing, like test output or a command result. Terminal panes are excluded from see_screen's tree; this is how you see them. For running NEW shell commands, use run_command.",
  parameters: EMPTY_OBJECT_SCHEMA
}

// Live failure this exists for: "open that issue" became navigate_ui new-browser-tab
// (blank page) → a guessed, nonexistent `orca browser open` → a losing fight with the
// address bar. Navigating to a URL is a first-class tool, never a UI workaround.
export const openUrlToolSchema: RealtimeToolSchema = {
  type: 'function',
  name: OPEN_URL_TOOL_NAME,
  description:
    'Open a web page as a foreground browser tab on the user\'s Orca screen — "open that issue", "pull up the PR", "show me that docs page". http(s) URLs only. This is the ONLY way to navigate the browser to a URL: never type into the address bar and never guess a CLI command for it.',
  parameters: stringParams('url')
}

export const COORDINATOR_TOOLS: RealtimeToolSchema[] = [
  listAgentsToolSchema,
  runCommandToolSchema,
  messageAgentToolSchema,
  startAgentToolSchema,
  broadcastToolSchema,
  navigateUiToolSchema,
  describeScreenToolSchema,
  seeScreenToolSchema,
  clickElementToolSchema,
  typeIntoToolSchema,
  readTerminalToolSchema,
  openUrlToolSchema
]
