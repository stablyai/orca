import { stripTerminalControl } from '../../../src/shared/terminal-control-stripping'
import type { LiveAgent } from './live-alert-types'

/** The expanded notification shows about this much; the chip and pill show far less. */
export const STATUS_TEXT_MAX = 120
export const SUB_TEXT_MAX = 60
const ELLIPSIS = '…'

const PERMISSION_LABELS: Record<string, string> = {
  bash: 'command',
  edit: 'edit',
  write: 'edit',
  read: 'read',
  external_directory: 'outside access',
  webfetch: 'web fetch',
  websearch: 'web search',
  doom_loop: 'repeated call',
  task: 'subagent'
}
const PATH_PERMISSIONS = new Set(['edit', 'write', 'read', 'external_directory'])

const AGENT_LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  opencode2: 'OpenCode',
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
  copilot: 'Copilot',
  amp: 'Amp',
  aider: 'Aider',
  kiro: 'Kiro',
  unknown: 'Agent'
}

const COMMAND_TOOLS = new Set(['bash', 'shell', 'command', 'exec_command', 'local_shell'])
const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'multiedit', 'apply_patch', 'notebookedit'])
const READ_TOOLS = new Set(['read', 'view'])
const SEARCH_TOOLS = new Set(['grep', 'glob', 'search', 'list', 'ls'])
const WEB_TOOLS = new Set(['webfetch', 'websearch', 'web_fetch', 'web_search'])

/** Terminal text and tool input can carry escapes, control bytes and line breaks; a status has none. */
export function sanitizeStatusText(value: string | null | undefined): string {
  if (!value) {
    return ''
  }
  const visible = stripTerminalControl(value.replace(/\t/g, ' '))
  return visible.replace(/\s+/g, ' ').trim()
}

export function truncateStatusText(value: string, max: number): string {
  if (value.length <= max) {
    return value
  }
  return `${value.slice(0, max - 1).trimEnd()}${ELLIPSIS}`
}

/** The first line that has any text, sanitized. */
export function firstLine(value: string | null | undefined): string {
  if (!value) {
    return ''
  }
  for (const line of value.split(/\r\n|\r|\n/)) {
    const text = sanitizeStatusText(line)
    if (text) {
      return text
    }
  }
  return ''
}

// Agent replies are Markdown; a status line keeps the words and drops the markup.
function stripMarkdown(value: string): string {
  return value.replace(/^[#>*\s-]+/, '').replace(/\*\*|__|`/g, '')
}

/** The first sentence of the first line, without Markdown. */
export function firstSentence(value: string | null | undefined): string {
  const line = stripMarkdown(firstLine(value))
  const match = /^(.+?[.!?])(?:\s|$)/.exec(line)
  return (match?.[1] ?? line).trim()
}

/** The last path segment; trailing glob segments such as `dir/*` name the directory instead. */
export function pathBasename(value: string): string {
  const segments = value.split(/[\\/]/).filter((segment) => segment && !/^\*+$/.test(segment))
  return segments.at(-1) ?? value
}

export function permissionLabel(toolName: string): string {
  const name = toolName.trim()
  return PERMISSION_LABELS[name.toLowerCase()] ?? name.replace(/_/g, ' ')
}

/** "Allow outside access: note.txt" for a permission prompt. */
export function approvalLine(toolName: string, toolInput: string | null): string {
  const input = firstLine(toolInput)
  // OpenCode joins several patterns with ", "; the first names the target well enough.
  const isPath = PATH_PERMISSIONS.has(toolName.trim().toLowerCase())
  const target = isPath ? pathBasename(input.split(', ')[0]) : input
  const label = permissionLabel(toolName)
  return target ? `Allow ${label}: ${target}` : `Allow ${label}`
}

export function agentLabel(agentType: string | null): string {
  const name = agentType?.trim()
  if (!name) {
    return 'Agent'
  }
  return AGENT_LABELS[name.toLowerCase()] ?? `${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

function toolLine(toolName: string, input: string): string {
  const tool = toolName.toLowerCase()
  if (COMMAND_TOOLS.has(tool)) {
    return input ? `Running ${input}` : 'Running a command'
  }
  if (EDIT_TOOLS.has(tool)) {
    return input ? `Editing ${pathBasename(input)}` : 'Editing files'
  }
  if (READ_TOOLS.has(tool)) {
    return input ? `Reading ${pathBasename(input)}` : 'Reading files'
  }
  if (SEARCH_TOOLS.has(tool)) {
    return input ? `Searching ${input}` : 'Searching files'
  }
  if (WEB_TOOLS.has(tool)) {
    return 'Searching the web'
  }
  if (tool === 'task') {
    return 'Running a subagent'
  }
  return `Using ${toolName}`
}

/** What a working agent is doing, from its own fields. */
export function rawWorkingLine(agent: LiveAgent): string {
  const toolName = sanitizeStatusText(agent.toolName)
  if (toolName) {
    return toolLine(toolName, firstLine(agent.toolInput))
  }
  const sentence = firstSentence(agent.lastAssistantMessage)
  if (sentence) {
    return sentence
  }
  const prompt = firstLine(agent.prompt)
  return prompt ? `Working on: ${prompt}` : 'Working'
}

/** The precise ask of a waiting agent. */
export function waitingLine(agent: LiveAgent): string {
  if (agent.need === 'approval' && agent.toolName) {
    return approvalLine(agent.toolName, agent.toolInput)
  }
  return 'Waiting for your answer'
}

/** How a finished agent ended, from the first line of its last reply. */
export function finishedLine(agent: LiveAgent): string {
  const line = stripMarkdown(firstLine(agent.lastAssistantMessage)).trim()
  if (line) {
    return line
  }
  if (agent.phase === 'failed') {
    return 'Failed'
  }
  return agent.phase === 'stopped' ? 'Stopped' : 'Finished'
}
