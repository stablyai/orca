import { existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

// Scripted `opencode acp` (1.x dialect, frames as in src/main/acp/fixtures/opencode-v1-*.jsonl):
// one streamed reply that waits for the test, a shell approval, then Stop.
const VERSION = '1.18.31'
if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}
// 1.x lists models through the CLI (`models --verbose`): one id, then its metadata as JSON.
if (process.argv[2] === 'models') {
  process.stdout.write('lane/model\n{\n  "name": "Lane model"\n}\n')
  process.exit(0)
}

const reportPath = process.env.ORCA_ACP_CONTRACT_REPORT_PATH
const ackPath = process.env.ORCA_ACP_CONTRACT_ACK_PATH
const sessionId = 'ses_wsl_lane_opencode'
const messageId = 'msg_wsl_lane_opencode_reply'
const report = {
  argv: process.argv.slice(1),
  execPath: process.execPath,
  cwd: process.cwd(),
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.startsWith('ORCA_') || key.startsWith('OPENCODE_') || key === 'XDG_DATA_HOME'
    )
  ),
  methods: [],
  prompts: [],
  permissionResponses: []
}
// The model-catalog probe runs without a chat session; only the chat's child owns the report.
const writeReport = () => {
  if (reportPath && process.env.ORCA_AGENT_SESSION_ID) {
    writeFileSync(reportPath, JSON.stringify(report))
  }
}
writeReport()

const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
const pending = new Map()
let nextRequestId = 0
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextRequestId++
    pending.set(id, resolve)
    send({ id, method, params })
  })
let cancelled = () => {}

async function prompt(frame) {
  const update = (fields) =>
    send({ method: 'session/update', params: { sessionId, update: fields } })
  // OpenCode stamps each chunk with its message id, which history catch-up keys on.
  const text = (value) =>
    update({
      sessionUpdate: 'agent_message_chunk',
      messageId,
      content: { type: 'text', text: value }
    })
  const stopped = new Promise((resolve) => {
    cancelled = resolve
  })
  text('Guest opencode ')
  while (ackPath && !existsSync(ackPath)) {
    await delay(10)
  }
  text('reply.')
  const toolCallId = 'call_00_wsl_lane_pwd'
  update({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'bash',
    kind: 'execute',
    status: 'pending',
    locations: [{ path: process.cwd() }],
    rawInput: { cwd: process.cwd() }
  })
  const answer = await request('session/request_permission', {
    sessionId,
    toolCall: {
      toolCallId,
      title: 'pwd',
      kind: 'execute',
      status: 'pending',
      locations: [],
      rawInput: { command: 'pwd' }
    },
    options: [
      { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
    ]
  })
  report.permissionResponses.push(answer)
  writeReport()
  await stopped
  send({
    id: frame.id,
    result: {
      stopReason: 'cancelled',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      _meta: {}
    }
  })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }
  if (frame.method === undefined) {
    pending.get(frame.id)?.(frame.result)
    pending.delete(frame.id)
    return
  }
  report.methods.push(frame.method)
  writeReport()
  const reply = (result) => send({ id: frame.id, result })
  switch (frame.method) {
    case 'initialize':
      return reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        agentInfo: { name: 'OpenCode', version: VERSION }
      })
    case 'session/new':
      return reply({
        sessionId,
        models: {
          currentModelId: 'lane/model',
          availableModels: [{ modelId: 'lane/model', name: 'lane/Lane model' }]
        }
      })
    case 'session/load':
      return reply({})
    case 'session/prompt':
      report.prompts.push(frame.params.prompt)
      writeReport()
      return void prompt(frame)
    case 'session/cancel':
      return cancelled()
    default:
      if (frame.id !== undefined) {
        send({ id: frame.id, error: { code: -32601, message: 'Method not found' } })
      }
  }
})
process.stdin.on('end', () => process.exit(0))
setTimeout(
  () => process.exit(3),
  Number(process.env.ORCA_ACP_CONTRACT_TIMEOUT_MS ?? 120_000)
).unref()
