// Claude stream-json stand-in for the 4a comparison; wrappers pass the launch log first. Speaks the same initialize/turn/interrupt
// protocol as tests/e2e/fixtures/structured-claude-stub.cjs and runs the prompt's [[4a {...}]] directive (see native-chat-4a-provider-text.cjs).
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parseDirective, prose, streamText } = require('./native-chat-4a-provider-text.cjs')

const [launchLog, ...args] = process.argv.slice(2)
fs.appendFileSync(launchLog, `${JSON.stringify({ pid: process.pid, args })}\n`)

if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('2.1.280 (Claude Code)\n')
  process.exit(0)
}

function argValue(name) {
  const joined = args.find((arg) => arg.startsWith(`${name}=`))
  if (joined) {
    return joined.slice(name.length + 1)
  }
  const index = args.indexOf(name)
  return index !== -1 ? args[index + 1] : undefined
}

const sessionId = argValue('--session-id') ?? argValue('--resume') ?? randomUUID()
const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const transcriptPath = path.join(
  claudeHome,
  'projects',
  process.cwd().replace(/[^a-zA-Z0-9]/g, '-'),
  `${sessionId}.jsonl`
)
fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
let parentUuid = null
if (fs.existsSync(transcriptPath)) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').filter(Boolean)
  // Chain to the last message, as the CLI does: a fork copy ends with a parentless custom-title row.
  const last = lines
    .map((line) => JSON.parse(line))
    .findLast((row) => (row.type === 'user' || row.type === 'assistant') && !row.isSidechain)
  parentUuid = last?.uuid ?? null
}

// Fork and rewind read the provider's own transcript, so every user/assistant frame is also saved there.
// Subagent frames are sidechain rows, as the CLI records them; the main chain skips them.
function remember(frame) {
  const sidechain = Boolean(frame.parent_tool_use_id)
  const row = {
    parentUuid,
    isSidechain: sidechain,
    type: frame.type,
    message: frame.message,
    uuid: frame.uuid,
    timestamp: new Date().toISOString(),
    sessionId,
    cwd: process.cwd()
  }
  fs.appendFileSync(transcriptPath, `${JSON.stringify(row)}\n`)
  if (!sidechain) {
    parentUuid = frame.uuid
  }
}

let backlog = Promise.resolve()
function write(frame) {
  const line = `${JSON.stringify(frame)}\n`
  // Respect stdout backpressure so a 15 MiB stream measures the host, not an unbounded pipe buffer.
  backlog = backlog.then(
    () =>
      new Promise((resolve) =>
        process.stdout.write(line) ? resolve() : process.stdout.once('drain', resolve)
      )
  )
  return backlog
}

function framed(type, message, extra = {}) {
  const frame = {
    type,
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message,
    ...extra
  }
  remember(frame)
  return write(frame)
}

const assistant = (content, extra) =>
  framed('assistant', { id: randomUUID(), role: 'assistant', model: 'claude-fake', content }, extra)
const system = (subtype, fields) =>
  write({ type: 'system', subtype, ...fields, uuid: randomUUID(), session_id: sessionId })
const streamEvent = (event) =>
  write({
    type: 'stream_event',
    event,
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid: randomUUID()
  })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let current = null
const pending = []
let turnCounter = 0

async function toolRun(turn, index, outputBytes, runMs, id = `toolu_4a_${turn}_${index}`, extra) {
  await assistant(
    [{ type: 'tool_use', id, name: 'Bash', input: { command: `ls -la dir${index}` } }],
    extra
  )
  if (runMs > 0) {
    await write({
      type: 'system',
      subtype: 'task_started',
      task_id: `task-${id}`,
      tool_use_id: id,
      description: 'run',
      task_type: 'local_bash',
      uuid: randomUUID(),
      session_id: sessionId
    })
    await sleep(runMs)
  }
  await framed(
    'user',
    {
      role: 'user',
      content: [
        { tool_use_id: id, type: 'tool_result', content: prose(outputBytes, id), is_error: false }
      ]
    },
    extra
  )
  if (runMs > 0) {
    await write({
      type: 'system',
      subtype: 'task_notification',
      task_id: `task-${id}`,
      tool_use_id: id,
      status: 'completed',
      summary: 'Command completed',
      uuid: randomUUID(),
      session_id: sessionId
    })
  }
}

/** Shapes for history/detail: an oversized ordinary message, huge completed tool originals, one above the detail cap. */
async function shapes(op, signal) {
  await assistant([{ type: 'text', text: `4A-BIG-${op.tag} ${prose(op.messageBytes, op.tag)}` }])
  for (let index = 0; index < op.hugeTools && !signal.aborted; index += 1) {
    await toolRun(0, index, op.hugeToolBytes, 0, `toolu_4a_${op.tag}_huge_${index}`)
  }
  await toolRun(0, 0, op.capToolBytes, 0, `toolu_4a_${op.tag}_cap`)
}

/** Foreground Agent calls in the CLI's frame shapes; children of parallel agents alternate, one agent's children run sparse. */
async function subagents(op, signal) {
  const agents = Array.from({ length: op.agents }, (_, index) => ({
    toolId: `toolu_4a_${op.tag}_agent_${index}`,
    taskId: `task4a${op.tag.replace(/\W/g, '')}${index}`,
    prompt: `4A-SUBAGENT-${op.tag}-${index} list the files`
  }))
  await assistant(
    agents.map((agent) => ({
      type: 'tool_use',
      id: agent.toolId,
      name: 'Agent',
      input: { description: 'List files', subagent_type: 'general-purpose', prompt: agent.prompt }
    }))
  )
  for (const agent of agents) {
    await system('task_started', {
      task_id: agent.taskId,
      tool_use_id: agent.toolId,
      description: 'List files',
      subagent_type: 'general-purpose',
      is_backgrounded: false,
      spawn_depth: 1,
      task_type: 'local_agent',
      prompt: agent.prompt
    })
    await framed(
      'user',
      { role: 'user', content: [{ type: 'text', text: agent.prompt }] },
      {
        parent_tool_use_id: agent.toolId,
        subagent_type: 'general-purpose',
        task_description: 'List files'
      }
    )
  }
  for (let child = 0; child < op.children && !signal.aborted; child += 1) {
    for (const agent of agents) {
      await toolRun(0, child, 200, 0, `${agent.toolId}_child_${child}`, {
        parent_tool_use_id: agent.toolId,
        subagent_type: 'general-purpose',
        task_description: 'List files'
      })
    }
  }
  for (const agent of agents) {
    const summary = `4A-SUBAGENT-DONE-${op.tag} ${agent.taskId}`
    await system('task_notification', {
      task_id: agent.taskId,
      tool_use_id: agent.toolId,
      status: 'completed',
      summary
    })
    await framed(
      'user',
      {
        role: 'user',
        content: [
          {
            tool_use_id: agent.toolId,
            type: 'tool_result',
            content: [{ type: 'text', text: summary }]
          }
        ]
      },
      {
        tool_use_result: {
          status: 'completed',
          prompt: agent.prompt,
          agentId: agent.taskId,
          agentType: 'general-purpose',
          content: [{ type: 'text', text: summary }]
        }
      }
    )
  }
}

async function streamReply(op, signal) {
  const text = streamText(op)
  const messageId = randomUUID()
  await streamEvent({
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: 'claude-fake',
      content: []
    }
  })
  await streamEvent({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' }
  })
  const chunk = op.chunkBytes ?? 16_384
  for (let offset = 0; offset < text.length && !signal.aborted; offset += chunk) {
    await streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: text.slice(offset, offset + chunk) }
    })
    if (op.intervalMs) {
      await sleep(op.intervalMs)
    }
  }
  if (signal.aborted) {
    return
  }
  await framed('assistant', {
    id: messageId,
    role: 'assistant',
    model: 'claude-fake',
    content: [{ type: 'text', text }]
  })
  await streamEvent({ type: 'content_block_stop', index: 0 })
  await streamEvent({ type: 'message_stop' })
}

async function runOp(op, signal) {
  const turn = (turnCounter += 1)
  const tag = op.tag ?? `t${turn}`
  if (op.op === 'history') {
    for (let index = 1; index <= (op.tools ?? 8) && !signal.aborted; index += 1) {
      await toolRun(
        turn,
        index,
        op.toolOutputBytes ?? 2000,
        op.toolRunMs ?? 0,
        op.toolIdPrefix ? `toolu_4a_${op.toolIdPrefix}_${index}` : undefined
      )
    }
    await assistant([{ type: 'text', text: `4A-TAIL-${tag} ${prose(op.replyBytes ?? 1500, tag)}` }])
    return
  }
  if (op.op === 'shapes' || op.op === 'subagents') {
    await (op.op === 'shapes' ? shapes : subagents)(op, signal)
    await assistant([{ type: 'text', text: `4A-TAIL-${tag} Stub reply.` }])
    return
  }
  if (op.op === 'stream') {
    if (op.toolOutputBytes) {
      await toolRun(turn, 0, op.toolOutputBytes, op.toolRunMs ?? 250)
    }
    await streamReply({ ...op, tag }, signal)
    return
  }
  if (op.op === 'hold') {
    const deadline = Date.now() + (op.ms ?? 60_000)
    while (!signal.aborted && Date.now() < deadline) {
      await sleep(10)
    }
  }
  if (!signal.aborted) {
    await assistant([{ type: 'text', text: `4A-TAIL-${tag} ${op.text ?? 'Stub reply.'}` }])
  }
}

async function startTurn(frame) {
  const controller = new AbortController()
  current = controller
  // The CLI's --replay-user-messages echo, which opens the turn.
  // One uuid for the echo and the transcript row, so fork and rewind can find this prompt.
  const echo = { ...frame, uuid: frame.uuid ?? randomUUID(), session_id: sessionId, isReplay: true }
  remember({ type: 'user', uuid: echo.uuid, message: frame.message })
  await write(echo)
  const content = frame.message?.content ?? frame.message
  const prompt = Array.isArray(content)
    ? content.map((block) => block?.text ?? '').join('\n')
    : content
  const op = parseDirective(prompt) ?? { op: 'reply' }
  await runOp(op, controller.signal)
  if (controller.signal.aborted) {
    return
  }
  await write({
    type: 'result',
    subtype: 'success',
    uuid: randomUUID(),
    session_id: sessionId,
    is_error: false,
    terminal_reason: 'completed',
    result: 'done'
  })
  current = null
  const next = pending.shift()
  if (next) {
    void startTurn(next)
  }
}

function interruptTurn() {
  if (!current) {
    return
  }
  current.abort()
  current = null
  void write({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: sessionId,
    parent_tool_use_id: null
  })
  const next = pending.shift()
  if (next) {
    void startTurn(next)
  }
}

const initializeResponse = {
  commands: [],
  models: [{ value: 'default', displayName: 'Default', description: '' }],
  account: {},
  output_style: 'default',
  available_output_styles: ['default']
}

let buffer = ''
let initSent = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += String(chunk)
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    let frame
    try {
      frame = line ? JSON.parse(line) : null
    } catch {
      frame = null
    }
    if (frame?.type === 'user') {
      if (current) {
        pending.push(frame)
      } else {
        void startTurn(frame)
      }
      continue
    }
    if (frame?.type !== 'control_request') {
      continue
    }
    const subtype = frame.request?.subtype
    if (subtype === 'interrupt') {
      interruptTurn()
    }
    void write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: frame.request_id,
        response: subtype === 'initialize' ? initializeResponse : {}
      }
    })
    if (subtype === 'initialize' && !initSent) {
      initSent = true
      void write({
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        uuid: randomUUID(),
        model: 'claude-fake',
        cwd: process.cwd(),
        tools: [],
        mcp_servers: [],
        permissionMode: 'default',
        slash_commands: [],
        apiKeySource: 'none',
        output_style: 'default'
      })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
