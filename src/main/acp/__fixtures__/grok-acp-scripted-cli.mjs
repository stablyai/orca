import { existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

// Scripted `grok agent stdio`: one streamed reply that waits for the test, an approval, then Stop.
if (process.argv.includes('--version')) {
  process.stdout.write('0.1.0\n')
  process.exit(0)
}

const reportPath = process.env.ORCA_ACP_CONTRACT_REPORT_PATH
const ackPath = process.env.ORCA_ACP_CONTRACT_ACK_PATH
const sessionId = 'wsl-lane-grok-session'
const report = {
  argv: process.argv.slice(1),
  execPath: process.execPath,
  cwd: process.cwd(),
  env: Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('ORCA_') || key === 'GROK_HOME')
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
  const meta = { promptId: frame.params._meta?.promptId }
  const update = (fields) =>
    send({ method: 'session/update', params: { sessionId, update: fields, _meta: meta } })
  const text = (value) =>
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
  const stopped = new Promise((resolve) => {
    cancelled = resolve
  })
  text('Guest grok ')
  while (ackPath && !existsSync(ackPath)) {
    await delay(10)
  }
  text('reply.')
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'wsl-tool',
    title: 'pwd',
    kind: 'execute',
    status: 'pending'
  })
  const answer = await request('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 'wsl-tool', title: 'pwd', kind: 'execute' },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
    ]
  })
  report.permissionResponses.push(answer)
  writeReport()
  await stopped
  send({ id: frame.id, result: { stopReason: 'cancelled' } })
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
        _meta: {
          modelState: {
            currentModelId: 'lane-model',
            availableModels: [{ modelId: 'lane-model', name: 'Lane model' }]
          }
        }
      })
    case 'session/new':
      return reply({ sessionId })
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
