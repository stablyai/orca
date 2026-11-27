// What a bot turn did, read from the agent CLI's JSON event stream: its reply, commands and tool calls.

type Parsed = {
  reply: string
  shell: string[]
  tools: string[]
  steps: string[]
  sessionId?: string
  costUsd?: number
}

// The fields read from Claude's stream-json and Codex's --json events; both CLIs own the format.
type StreamEvent = {
  type?: string
  result?: string
  session_id?: string
  total_cost_usd?: number
  thread_id?: string
  message?: { content?: { type?: string; name?: string; input?: { command?: unknown } }[] }
  item?: { type?: string; command?: string; text?: string }
}

function isStreamEvent(value: unknown): value is StreamEvent {
  return typeof value === 'object' && value !== null && 'type' in value
}

function events(stdout: string): StreamEvent[] {
  return stdout.split('\n').flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line)
      return isStreamEvent(parsed) ? [parsed] : []
    } catch {
      return []
    }
  })
}

export function parseClaude(stdout: string): Parsed {
  const all = events(stdout)
  const result = all.findLast((event) => event.type === 'result')
  const shell: string[] = []
  const tools: string[] = []
  const steps: string[] = []
  for (const event of all) {
    for (const block of event.type === 'assistant' ? (event.message?.content ?? []) : []) {
      if (block.type === 'tool_use') {
        const command = typeof block.input?.command === 'string' ? block.input.command : null
        if (command) {
          shell.push(command)
        }
        tools.push(block.name === 'Bash' ? 'shell' : (block.name ?? 'tool'))
        steps.push(`  [${block.name}] ${command ?? JSON.stringify(block.input).slice(0, 300)}`)
      }
    }
  }
  return {
    reply: String(result?.result ?? ''),
    shell,
    tools,
    steps,
    sessionId: result?.session_id,
    costUsd: result?.total_cost_usd
  }
}

export function parseCodex(stdout: string): Parsed {
  const all = events(stdout)
  const items = all.flatMap((event) =>
    event.type === 'item.completed' && event.item ? [event.item] : []
  )
  const shell = items
    .filter((item) => item.type === 'command_execution')
    .map((item) => String(item.command))
  // Anything but its words and thinking is a tool call: a command, an MCP call, a file edit, a search.
  const tools = items.flatMap((item) =>
    item.type === 'agent_message' || item.type === 'reasoning' || item.type === 'todo_list'
      ? []
      : [item.type === 'command_execution' ? 'shell' : String(item.type)]
  )
  return {
    reply: String(items.findLast((item) => item.type === 'agent_message')?.text ?? ''),
    shell,
    tools,
    steps: shell.map((command) => `  [shell] ${command}`),
    sessionId: all.find((event) => event.type === 'thread.started')?.thread_id
  }
}
