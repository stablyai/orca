import { describe, expect, it } from 'vitest'
import {
  agentLabel,
  approvalLine,
  finishedLine,
  permissionLabel,
  rawWorkingLine,
  sanitizeStatusText,
  truncateStatusText,
  waitingLine
} from './live-agent-status-text'
import type { LiveAgent } from './live-alert-types'

function agent(overrides: Partial<LiveAgent> = {}): LiveAgent {
  return {
    key: 'agent-1',
    hostId: 'host-1',
    hostName: 'Desk',
    worktreeId: 'wt-1',
    workspace: 'demo-repo',
    executionHost: null,
    paneKey: 'tab-1:leaf-1',
    phase: 'working',
    need: null,
    agentType: 'opencode',
    prompt: '',
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    stateStartedAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('status text cleanup', () => {
  it('drops ANSI escapes, control bytes and line breaks', () => {
    const raw = '\u001b[32mok\u001b[0m\r\n  next\tline\u0007'
    expect(sanitizeStatusText(raw)).toBe('ok next line')
  })

  it('truncates long text with an ellipsis', () => {
    expect(truncateStatusText('abcdefghij', 5)).toBe('abcd…')
    expect(truncateStatusText('abc', 5)).toBe('abc')
  })
})

describe('rawWorkingLine', () => {
  it('uses the first sentence of an OpenCode reply when no tool is named', () => {
    const reply = 'Creating hello.txt now. Then ping.'
    expect(rawWorkingLine(agent({ lastAssistantMessage: reply }))).toBe('Creating hello.txt now.')
  })

  it('drops Markdown from the reply', () => {
    const line = rawWorkingLine(agent({ lastAssistantMessage: '- **Editing** `app.js`' }))
    expect(line).toBe('Editing app.js')
  })

  it('falls back to the prompt, then to a plain word', () => {
    const line = rawWorkingLine(agent({ prompt: 'Write a file\nthen test it' }))
    expect(line).toBe('Working on: Write a file')
    expect(rawWorkingLine(agent())).toBe('Working')
  })

  const toolCases: [string, string | null, string][] = [
    ['Bash', 'npm test\n--watch', 'Running npm test'],
    ['edit', 'src/app.js', 'Editing app.js'],
    ['Read', 'C:\\repo\\README.md', 'Reading README.md'],
    ['grep', 'TODO', 'Searching TODO'],
    ['WebFetch', null, 'Searching the web'],
    ['task', null, 'Running a subagent'],
    ['TodoWrite', null, 'Using TodoWrite']
  ]
  it.each(toolCases)('describes the %s tool', (toolName, toolInput, expected) => {
    expect(rawWorkingLine(agent({ toolName, toolInput }))).toBe(expected)
  })
})

describe('waiting and finished lines', () => {
  const approvalCases: [string, string | null, string][] = [
    ['external_directory', 'F:/demo/note.txt', 'Allow outside access: note.txt'],
    ['external_directory', 'F:/demo-outside/*', 'Allow outside access: demo-outside'],
    ['bash', 'rm -rf build\necho done', 'Allow command: rm -rf build'],
    ['edit', 'src\\app.js', 'Allow edit: app.js'],
    ['custom_tool', null, 'Allow custom tool']
  ]
  it.each(approvalCases)('asks to allow %s', (toolName, toolInput, expected) => {
    expect(approvalLine(toolName, toolInput)).toBe(expected)
  })

  it('waits on an answer when no permission is named', () => {
    const line = waitingLine(agent({ phase: 'waiting', need: 'input' }))
    expect(line).toBe('Waiting for your answer')
  })

  it('ends with the first line of the last reply', () => {
    const done = agent({ phase: 'done', lastAssistantMessage: 'Created hello.txt.\nMore.' })
    expect(finishedLine(done)).toBe('Created hello.txt.')
    expect(finishedLine(agent({ phase: 'failed' }))).toBe('Failed')
    expect(finishedLine(agent({ phase: 'done' }))).toBe('Finished')
  })

  it('labels agents and permissions', () => {
    expect(agentLabel('opencode')).toBe('OpenCode')
    expect(agentLabel('claude')).toBe('Claude Code')
    expect(agentLabel('newagent')).toBe('Newagent')
    expect(agentLabel(null)).toBe('Agent')
    expect(permissionLabel('doom_loop')).toBe('repeated call')
    expect(permissionLabel('some_new_permission')).toBe('some new permission')
  })
})
