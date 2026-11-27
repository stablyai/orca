#!/usr/bin/env node
// Watch bridge (spike): lets the standalone Watch app list and answer terminal Claude Code permission
// prompts over plain HTTPS. Reads agent status from the local Orca runtime and answers by typing the
// option's key into that terminal through the version-matched `orca` CLI. Binds to loopback only; expose
// it with `tailscale funnel`. Every request needs a bearer token: the Watch token in ~/.orca/watch-bridge-token
// or the Siri token in ~/.orca/siri-bridge-token, each limited to its own endpoints.
import { createHash, createPrivateKey, randomBytes, sign, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect as connectHttp2 } from 'node:http2'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PORT = Number(process.env.ORCA_WATCH_BRIDGE_PORT ?? 6790)
const ORCA_CLI = process.env.ORCA_CLI ?? '/Applications/Orca.app/Contents/Resources/bin/orca'
const RUNTIME_METADATA = join(homedir(), 'Library/Application Support/orca/orca-runtime.json')
const TOKEN_PATH = join(homedir(), '.orca', 'watch-bridge-token')
const SIRI_TOKEN_PATH = join(homedir(), '.orca', 'siri-bridge-token')
const DEVICES_PATH = join(homedir(), '.orca', 'watch-bridge-devices.json')
const APNS_DIR = join(homedir(), '.orca', 'watch-apns')
const APNS_TEAM_ID = process.env.ORCA_WATCH_APNS_TEAM_ID ?? '28HX49S37H'
const APNS_TOPIC = process.env.ORCA_WATCH_APNS_TOPIC ?? 'com.cjna.orca.watch'
const POLL_MS = 2000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function loadToken(path) {
  if (!existsSync(path)) {
    mkdirSync(join(homedir(), '.orca'), { recursive: true })
    writeFileSync(path, randomBytes(32).toString('base64url'), { mode: 0o600 })
  }
  chmodSync(path, 0o600)
  return Buffer.from(readFileSync(path, 'utf8').trim())
}

// Each client gets only the endpoints it uses: the Watch can't send free text to an idle agent.
const CLIENTS = [
  {
    name: 'watch',
    token: loadToken(TOKEN_PATH),
    scopes: new Set(['prompts', 'answer', 'register'])
  },
  {
    name: 'siri',
    token: loadToken(SIRI_TOKEN_PATH),
    scopes: new Set(['prompts', 'answer', 'agents', 'message'])
  }
]

function authorizedClient(req) {
  const header = req.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  return (
    CLIENTS.find(
      (client) => given.length === client.token.length && timingSafeEqual(given, client.token)
    ) ?? null
  )
}

// Writes type into terminals, so a leaked token can't be used to flood them.
const WRITE_LIMIT_PER_MINUTE = 20
const writeLog = new Map()
function allowWrite(client) {
  const now = Date.now()
  const recent = (writeLog.get(client.name) ?? []).filter((at) => now - at < 60_000)
  if (recent.length >= WRITE_LIMIT_PER_MINUTE) {
    writeLog.set(client.name, recent)
    return false
  }
  recent.push(now)
  writeLog.set(client.name, recent)
  return true
}

// One newline-delimited JSON request over the runtime's private Unix socket, as the CLI does.
function runtimeCall(method, params) {
  const metadata = JSON.parse(readFileSync(RUNTIME_METADATA, 'utf8'))
  const transport = metadata.transports.find((entry) => entry.kind === 'unix')
  return new Promise((resolve, reject) => {
    const socket = createConnection(transport.endpoint)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`${method} timed out`))
    }, 5000)
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('connect', () =>
      socket.write(
        `${JSON.stringify({ id: 'watch-bridge', authToken: metadata.authToken, method, params })}\n`
      )
    )
    socket.on('data', (chunk) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end === -1) {
        return
      }
      clearTimeout(timer)
      socket.end()
      const frame = JSON.parse(buffer.slice(0, end))
      if (frame.ok) {
        resolve(frame.result)
      } else {
        reject(new Error(frame.error?.message ?? `${method} failed`))
      }
    })
  })
}

async function orca(...args) {
  const { stdout } = await run(ORCA_CLI, [...args, '--json'], { timeout: 8000 })
  const frame = JSON.parse(stdout)
  if (!frame.ok) {
    throw new Error(frame.error?.message ?? `orca ${args[0]} ${args[1]} failed`)
  }
  return frame.result
}

async function waitingClaudeTerminals() {
  const { snapshots } = await runtimeCall('session.tabs.listAll', {})
  return snapshots
    .flatMap((snapshot) => snapshot.tabs ?? [])
    .map((tab) => ({ tab, status: tab.agentStatus }))
    .filter(
      ({ status }) =>
        status?.agentType === 'claude' &&
        status.state === 'waiting' &&
        status.terminalHandle &&
        status.interactivePrompt?.includes('"approval"')
    )
}

// Claude Code draws: "Do you want to …?" then "❯ 1. Yes" / "  2. …" (wrapped lines indented further).
export function parsePermissionDialog(lines) {
  const questionAt = lines.findLastIndex((line) => /^\s*Do you want to /.test(line))
  if (questionAt === -1) {
    return null
  }
  const options = []
  for (const line of lines.slice(questionAt + 1)) {
    const option = line.match(/^\s*(?:❯\s*)?(\d)\.\s+(.*)$/)
    if (option) {
      options.push({ id: option[1], label: option[2].trim() })
    } else if (options.length > 0 && /^\s{4,}\S/.test(line)) {
      options.at(-1).label += ` ${line.trim()}`
    } else if (options.length > 0) {
      break
    }
  }
  if (options.length === 0) {
    return null
  }
  const ruleAt = lines.slice(0, questionAt).findLastIndex((line) => /^─{10,}/.test(line))
  const context = lines
    .slice(ruleAt + 1, questionAt)
    .map((line) => line.trim())
    .filter((line) => line && !/^╌+$/.test(line))
  return { question: lines[questionAt].trim(), options, context }
}

async function pendingPrompts() {
  const prompts = []
  for (const { tab, status } of await waitingClaudeTerminals()) {
    const handle = status.terminalHandle
    const screen = await orca('terminal', 'read', '--terminal', handle, '--screen').catch(
      () => null
    )
    const dialog = screen && parsePermissionDialog(screen.terminal?.tail ?? [])
    if (!dialog) {
      continue
    }
    const identity = [
      handle,
      status.stateStartedAt,
      status.toolName,
      status.toolInput,
      dialog.question
    ]
    const workspace = workspaceName(status.worktreeId)
    prompts.push({
      id: createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 20),
      kind: 'approval',
      title: dialog.question,
      detail: [`${status.toolName}: ${status.toolInput ?? ''}`, ...dialog.context]
        .join('\n')
        .slice(0, 1200),
      source: [agentDisplayName(status.terminalTitle || tab.title, status.agentType, ''), workspace]
        .filter(Boolean)
        .join(' · '),
      options: dialog.options.map((option) => ({ ...option, label: option.label.slice(0, 90) })),
      allowsText: true,
      createdAt: status.stateStartedAt,
      spoken: spokenAction(status.toolName, status.toolInput),
      handle
    })
  }
  return prompts
}

async function stillWaiting(handle, since) {
  const terminals = await waitingClaudeTerminals()
  return terminals.some(
    ({ status }) => status.terminalHandle === handle && status.stateStartedAt === since
  )
}

// --- Siri: every terminal agent, with text short enough to speak. ---

// Turns agent markdown into one or two sentences Siri can read aloud.
export function speakable(text, max) {
  if (typeof text !== 'string') {
    return ''
  }
  const plain = text
    .replace(/<\/?pastedcontent[^>]*>/gi, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' (code omitted) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+(.*?)[.:]?\s*$/gm, '$1.')
    .replace(/^\s{0,3}([-*+>]|\d+\.)\s+/gm, '')
    .replace(/[*_~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= max) {
    return plain
  }
  const cut = plain.slice(0, max)
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  if (sentenceEnd > max * 0.4) {
    return cut.slice(0, sentenceEnd + 1)
  }
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max)}…`
}

// Folder workspaces are "folder:<uuid>", which Siri would read out character by character.
function workspaceName(worktreeId) {
  const name = basename((worktreeId ?? '').split('::').at(-1) ?? '')
  return name.startsWith('folder:') ? '' : name
}

// Siri says this after "wants to use": a file name not a path, a host not a URL, the first command of a chain.
export function spokenAction(toolName, toolInput) {
  const tool = toolName || 'a tool'
  const input = String(toolInput ?? '').trim()
  if (!input) {
    return tool
  }
  if (tool === 'Bash') {
    const commands = input.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean)
    const first = commands[0].replace(/https?:\/\/([^/\s]+)\S*/g, '$1').replace(/\s+/g, ' ')
    const cut = first.lastIndexOf(' ', 60)
    const command = first.length <= 60 ? first : `${first.slice(0, cut > 0 ? cut : 60)}…`
    const more = commands.length - 1
    return `Bash: ${command}${more > 0 ? `, and ${more} more` : ''}`
  }
  if (/^(Edit|MultiEdit|Write|Read|NotebookEdit)$/.test(tool)) {
    return `${tool} on ${basename(input.split('\n')[0])}`
  }
  const host = input.match(/https?:\/\/([^/\s]+)/)
  return host ? `${tool} on ${host[1]}` : `${tool}: ${speakable(input, 60)}`
}

// Claude Code and others put a spinner or status glyph before the terminal title.
export function agentDisplayName(title, agentType, workspace) {
  const cleaned = (title ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim()
  if (cleaned && cleaned.toLowerCase() !== String(agentType).toLowerCase()) {
    return cleaned.slice(0, 60)
  }
  return [agentType, workspace].filter(Boolean).join(' in ')
}

function isApprovalWait(status) {
  return status.state === 'waiting' && Boolean(status.interactivePrompt?.includes('"approval"'))
}

async function terminalAgents() {
  const { snapshots } = await runtimeCall('session.tabs.listAll', {})
  return snapshots
    .flatMap((snapshot) => snapshot.tabs ?? [])
    .filter((tab) => tab.type === 'terminal' && tab.agentStatus?.terminalHandle)
    .map((tab) => {
      const status = tab.agentStatus
      const workspace = workspaceName(status.worktreeId)
      const agentType = status.agentType ?? 'agent'
      const message = status.lastAssistantMessageIsToolOutput
        ? status.lastCompletedAssistantMessage
        : status.lastAssistantMessage || status.lastCompletedAssistantMessage
      return {
        id: status.paneKey,
        name: agentDisplayName(status.terminalTitle || tab.title, agentType, workspace),
        workspace,
        agentType,
        state: status.state,
        stateStartedAt: status.stateStartedAt,
        needsApproval: isApprovalWait(status),
        task: speakable(status.prompt, 160),
        lastMessage: speakable(message, 400),
        handle: status.terminalHandle
      }
    })
    .sort((a, b) => b.stateStartedAt - a.stateStartedAt)
}

const withoutHandle = ({ handle: _handle, ...rest }) => rest

async function typeReply(handle, text, declineFirst) {
  if (declineFirst) {
    // Esc declines the tool call; the reply then goes in as the next message.
    await orca('terminal', 'send', '--terminal', handle, '--text', '\u001b')
    await sleep(600)
  }
  // A leading dash would be read as a CLI flag.
  const safe = text.trim().slice(0, 2000).replace(/^-/, ' -')
  await orca('terminal', 'send', '--terminal', handle, '--text', safe, '--enter')
}

// One write at a time: a key typed while another answer is landing could hit the wrong screen.
let answerChain = Promise.resolve()
function enqueue(task) {
  const next = answerChain.then(task)
  answerChain = next.catch(() => {})
  return next
}

function messageAgent(body) {
  return enqueue(async () => {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) {
      return { status: 400, body: { error: 'Say what to send' } }
    }
    const agent = (await terminalAgents()).find((entry) => entry.id === body.agentId)
    console.log(`message agent=${body.agentId} found=${Boolean(agent)} state=${agent?.state}`)
    if (!agent) {
      return { status: 404, body: { error: 'That agent is gone' } }
    }
    if (agent.state === 'working') {
      return { status: 409, body: { error: `${agent.name} is still working` } }
    }
    // Orca keeps a finished agent's status after it exits, so check Claude is still on screen.
    if (agent.agentType !== 'claude' || !(await showsClaudeInput(agent.handle))) {
      return { status: 409, body: { error: `${agent.name} isn't running anymore` } }
    }
    await typeReply(agent.handle, text, agent.needsApproval)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(400)
      const now = (await terminalAgents()).find((entry) => entry.id === agent.id)
      if (!now || now.stateStartedAt !== agent.stateStartedAt) {
        return { status: 200, body: { ok: true, confirmed: true, name: agent.name } }
      }
    }
    return { status: 200, body: { ok: true, confirmed: false, name: agent.name } }
  })
}

// Claude Code draws its input box between two horizontal rules; a bare shell never does.
async function showsClaudeInput(handle) {
  const screen = await orca('terminal', 'read', '--terminal', handle, '--screen').catch(() => null)
  const lines = (screen?.terminal?.tail ?? []).filter((line) => line.trim())
  return lines.slice(-8).filter((line) => /^\s*─{10,}/.test(line)).length >= 2
}

function answerPrompt(body) {
  return enqueue(async () => {
    // Re-read right before typing: a key sent to a changed screen would answer something else.
    const prompt = (await pendingPrompts()).find((entry) => entry.id === body.promptId)
    console.log(
      `answer ${body.decision} option=${body.optionId ?? '-'} prompt=${body.promptId} found=${Boolean(prompt)}`
    )
    if (!prompt) {
      return { status: 409, body: { error: 'This prompt is no longer waiting' } }
    }
    if (body.decision === 'option') {
      if (!prompt.options.some((option) => option.id === body.optionId)) {
        return { status: 400, body: { error: 'Unknown option' } }
      }
      await orca('terminal', 'send', '--terminal', prompt.handle, '--text', body.optionId)
    } else if (body.decision === 'text' && typeof body.text === 'string' && body.text.trim()) {
      await typeReply(prompt.handle, body.text, true)
    } else {
      return { status: 400, body: { error: 'Unsupported answer' } }
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(400)
      if (!(await stillWaiting(prompt.handle, prompt.createdAt))) {
        return { status: 200, body: { ok: true, confirmed: true } }
      }
    }
    return { status: 200, body: { ok: true, confirmed: false } }
  })
}

// --- Push: one APNs alert per newly waiting prompt, straight to the Watch app's own token. ---

function loadDevices() {
  try {
    return JSON.parse(readFileSync(DEVICES_PATH, 'utf8'))
  } catch {
    return []
  }
}

function saveDevices(devices) {
  writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2), { mode: 0o600 })
  chmodSync(DEVICES_PATH, 0o600)
}

function registerDevice(body) {
  const deviceToken = String(body.deviceToken ?? '')
  const environment = body.environment === 'production' ? 'production' : 'development'
  if (!/^[0-9a-f]{64,200}$/.test(deviceToken)) {
    return { status: 400, body: { error: 'Bad device token' } }
  }
  const devices = loadDevices().filter((device) => device.deviceToken !== deviceToken)
  devices.push({ deviceToken, environment, registeredAt: Date.now() })
  saveDevices(devices)
  console.log(`registered Watch push token …${deviceToken.slice(-6)} (${environment})`)
  return { status: 200, body: { ok: true } }
}

function loadApnsKey() {
  const file =
    existsSync(APNS_DIR) && readdirSync(APNS_DIR).find((name) => /^AuthKey_\w{10}\.p8$/.test(name))
  if (!file) {
    return null
  }
  return {
    keyId: file.slice(8, 18),
    key: createPrivateKey(readFileSync(join(APNS_DIR, file), 'utf8'))
  }
}

let apnsJwt = null
function apnsAuthorization(apnsKey) {
  // Apple accepts a provider token for up to an hour; refresh well before that.
  if (apnsJwt && Date.now() - apnsJwt.issuedAt < 40 * 60 * 1000) {
    return apnsJwt.value
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const issuedAt = Date.now()
  const unsigned = `${encode({ alg: 'ES256', kid: apnsKey.keyId })}.${encode({ iss: APNS_TEAM_ID, iat: Math.floor(issuedAt / 1000) })}`
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: apnsKey.key,
    dsaEncoding: 'ieee-p1363'
  })
  apnsJwt = { issuedAt, value: `bearer ${unsigned}.${signature.toString('base64url')}` }
  return apnsJwt.value
}

function sendApns(apnsKey, device, payload, collapseId) {
  const host =
    device.environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com'
  return new Promise((resolve) => {
    const client = connectHttp2(`https://${host}`)
    const timer = setTimeout(() => {
      client.destroy()
      resolve({ status: 0, reason: 'timeout' })
    }, 10000)
    client.on('error', (error) => resolve({ status: 0, reason: error.message }))
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${device.deviceToken}`,
      authorization: apnsAuthorization(apnsKey),
      'apns-topic': APNS_TOPIC,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 600),
      'apns-collapse-id': collapseId
    })
    let status = 0
    let body = ''
    request.on('response', (headers) => (status = headers[':status']))
    request.setEncoding('utf8')
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      clearTimeout(timer)
      client.close()
      resolve({ status, reason: body ? JSON.parse(body).reason : '' })
    })
    request.end(JSON.stringify(payload))
  })
}

async function notifyWatch(prompt) {
  const apnsKey = loadApnsKey()
  const devices = loadDevices()
  console.log(`prompt waiting: ${prompt.title} (key=${Boolean(apnsKey)} devices=${devices.length})`)
  if (!apnsKey || devices.length === 0) {
    return
  }
  const no = prompt.options.find((option) => /^No\b/.test(option.label))
  const payload = {
    aps: {
      alert: { title: 'Claude needs approval', subtitle: prompt.source, body: prompt.title },
      sound: 'default',
      category: 'orca.prompt'
    },
    promptId: prompt.id,
    yesOptionId: prompt.options[0]?.id,
    ...(no ? { noOptionId: no.id } : {})
  }
  for (const device of devices) {
    const started = Date.now()
    const result = await sendApns(apnsKey, device, payload, prompt.id)
    console.log(
      `push …${device.deviceToken.slice(-6)} ${result.status} ${result.reason} ${Date.now() - started}ms`
    )
    if (
      result.status === 410 ||
      result.reason === 'BadDeviceToken' ||
      result.reason === 'Unregistered'
    ) {
      saveDevices(loadDevices().filter((entry) => entry.deviceToken !== device.deviceToken))
    }
  }
}

// Status flips to waiting slightly before the dialog draws, so a key is retried until its dialog parses.
const notified = new Set()
const attempts = new Map()
async function watchForPrompts() {
  try {
    const waiting = await waitingClaudeTerminals()
    const keys = new Set(
      waiting.map(({ status }) => `${status.terminalHandle}|${status.stateStartedAt}`)
    )
    for (const key of [...notified, ...attempts.keys()]) {
      if (!keys.has(key)) {
        notified.delete(key)
        attempts.delete(key)
      }
    }
    const fresh = [...keys].filter((key) => !notified.has(key) && (attempts.get(key) ?? 0) < 10)
    if (fresh.length > 0) {
      const prompts = await pendingPrompts()
      for (const key of fresh) {
        const prompt = prompts.find((entry) => `${entry.handle}|${entry.createdAt}` === key)
        if (prompt) {
          notified.add(key)
          attempts.delete(key)
          await notifyWatch(prompt)
        } else {
          attempts.set(key, (attempts.get(key) ?? 0) + 1)
          console.log(`waiting terminal ${key} has no dialog yet (try ${attempts.get(key)})`)
        }
      }
    }
  } catch (error) {
    console.log(`watch loop: ${error instanceof Error ? error.message : String(error)}`)
  }
  setTimeout(watchForPrompts, POLL_MS)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 8192) {
        reject(new Error('Body too large'))
        req.destroy()
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const listPrompts = async () =>
  (await pendingPrompts()).map(({ spoken: _spoken, ...prompt }) => withoutHandle(prompt))

// The Siri app speaks the first detail line, so lead with the short spoken action.
const siriPrompts = async () =>
  (await pendingPrompts()).map(({ spoken, detail, ...prompt }) =>
    withoutHandle({ ...prompt, detail: [spoken, ...detail.split('\n').slice(1)].join('\n') })
  )

// `${method} ${path}` → scope it needs, whether it types into a terminal, and its handler.
const ROUTES = {
  'GET /watch/v1/prompts': {
    scope: 'prompts',
    handle: async () => ({ status: 200, body: { prompts: await listPrompts() } })
  },
  'POST /watch/v1/register': { scope: 'register', handle: (body) => registerDevice(body) },
  'POST /watch/v1/answer': { scope: 'answer', writes: true, handle: (body) => answerPrompt(body) },
  // One round trip for Siri: what's waiting plus every agent's state and last words.
  'GET /siri/v1/overview': {
    scope: 'agents',
    handle: async () => {
      const [prompts, agents] = await Promise.all([siriPrompts(), terminalAgents()])
      return { status: 200, body: { prompts, agents: agents.map(withoutHandle) } }
    }
  },
  'POST /siri/v1/answer': { scope: 'answer', writes: true, handle: (body) => answerPrompt(body) },
  'POST /siri/v1/message': { scope: 'message', writes: true, handle: (body) => messageAgent(body) }
}

const server = createServer(async (req, res) => {
  const started = Date.now()
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.url} ${status} ${Date.now() - started}ms`
    )
  }
  try {
    const client = authorizedClient(req)
    if (!client) {
      return reply(401, { error: 'Unauthorized' })
    }
    const route = ROUTES[`${req.method} ${req.url}`]
    if (!route) {
      return reply(404, { error: 'Not found' })
    }
    if (!client.scopes.has(route.scope)) {
      return reply(403, { error: 'This token cannot do that' })
    }
    if (route.writes && !allowWrite(client)) {
      return reply(429, { error: 'Too many answers in the last minute' })
    }
    const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : undefined
    const result = await route.handle(body)
    return reply(result.status, result.body)
  } catch (error) {
    return reply(500, { error: error instanceof Error ? error.message : String(error) })
  }
})

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  server.listen(PORT, '127.0.0.1', () => {
    const apnsKey = loadApnsKey()
    console.log(
      `watch bridge on http://127.0.0.1:${PORT}; push ${apnsKey ? `key ${apnsKey.keyId}` : 'off (no key)'}`
    )
    void watchForPrompts()
  })
}
