import { existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

// Scripted `codex app-server`: one streamed reply that waits for the test, an approval, then Stop.
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.158.0\n')
  process.exit(0)
}
if (!process.argv.includes('app-server')) {
  process.stderr.write(`unsupported: ${process.argv.slice(2).join(' ')}\n`)
  process.exit(2)
}

const reportPath = process.env.ORCA_CODEX_CONTRACT_REPORT_PATH
const ackPath = process.env.ORCA_CODEX_CONTRACT_ACK_PATH
const threadId = 'wsl-lane-codex-thread'
const turnId = 'wsl-lane-codex-turn'
const report = {
  argv: process.argv.slice(1),
  execPath: process.execPath,
  cwd: process.cwd(),
  env: Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('ORCA_') || key === 'CODEX_HOME')
  ),
  methods: [],
  turnInputs: [],
  approvalResponses: []
}
// Model and skills probes run without a chat session; only the chat's child owns the report.
const writeReport = () => {
  if (reportPath && process.env.ORCA_AGENT_SESSION_ID) {
    writeFileSync(reportPath, JSON.stringify(report))
  }
}
writeReport()

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const notify = (method, params) => send({ method, params: { threadId, ...params } })
let answerApproval = () => {}

function endTurn(status) {
  notify('thread/status/changed', { status: { type: 'idle' } })
  notify('turn/completed', { turn: { id: turnId, status } })
}

async function runTurn(clientUserMessageId) {
  notify('thread/status/changed', { status: { type: 'active' } })
  notify('turn/started', { turn: { id: turnId, status: 'inProgress' } })
  const echo = { type: 'userMessage', id: 'wsl-user', clientId: clientUserMessageId, content: [] }
  notify('item/started', { turnId, item: echo })
  notify('item/completed', { turnId, item: echo })
  notify('item/started', { turnId, item: { type: 'agentMessage', id: 'wsl-reply', text: '' } })
  const delta = (text) =>
    notify('item/agentMessage/delta', { turnId, itemId: 'wsl-reply', delta: text })
  delta('Guest codex ')
  while (ackPath && !existsSync(ackPath)) {
    await delay(10)
  }
  delta('reply.')
  notify('item/completed', {
    turnId,
    item: { type: 'agentMessage', id: 'wsl-reply', text: 'Guest codex reply.' }
  })
  const answered = new Promise((resolve) => {
    answerApproval = resolve
  })
  send({
    id: 'wsl-approval',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId,
      turnId,
      itemId: 'wsl-command',
      command: 'pwd',
      reason: 'WSL lane approval',
      availableDecisions: ['accept', 'decline', 'cancel']
    }
  })
  report.approvalResponses.push(await answered)
  writeReport()
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }
  if (frame.method === undefined) {
    if (frame.id === 'wsl-approval') {
      answerApproval(frame.result)
    }
    return
  }
  report.methods.push(frame.method)
  writeReport()
  if (frame.id === undefined) {
    return
  }
  const reply = (result) => send({ id: frame.id, result })
  switch (frame.method) {
    case 'thread/start':
    case 'thread/resume':
      return reply({ thread: { id: threadId }, model: 'lane-model' })
    case 'turn/start':
      report.turnInputs.push(frame.params.input)
      writeReport()
      reply({ turn: { id: turnId, status: 'inProgress' } })
      return void runTurn(frame.params.clientUserMessageId)
    case 'turn/interrupt':
      reply({})
      return endTurn('interrupted')
    case 'model/list':
      return reply({
        data: [
          {
            model: 'lane-model',
            displayName: 'Lane model',
            isDefault: true,
            supportedReasoningEfforts: []
          }
        ],
        nextCursor: null
      })
    case 'config/read':
      return reply({ config: {} })
    case 'account/read':
      return reply({ account: null, requiresOpenaiAuth: false })
    case 'skills/list':
      return reply({ data: [] })
    case 'thread/backgroundTerminals/list':
    case 'thread/turns/list':
      return reply({ data: [], nextCursor: null })
    case 'initialize':
    case 'skills/extraRoots/set':
      return reply({})
    default:
      send({ id: frame.id, error: { code: -32601, message: 'method not found' } })
  }
})
process.stdin.on('end', () => process.exit(0))
setTimeout(
  () => process.exit(3),
  Number(process.env.ORCA_CODEX_CONTRACT_TIMEOUT_MS ?? 120_000)
).unref()
