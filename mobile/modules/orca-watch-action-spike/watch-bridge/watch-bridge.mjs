#!/usr/bin/env node
// Watch bridge (spike): lets the standalone Watch app list and answer terminal Claude Code permission
// prompts over plain HTTPS. Reads agent status from the local Orca runtime and answers by typing the
// option's key into that terminal through the version-matched `orca` CLI. Binds to loopback only; expose
// it with `tailscale funnel`. Every request needs the bearer token in ~/.orca/watch-bridge-token.
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
const DEVICES_PATH = join(homedir(), '.orca', 'watch-bridge-devices.json')
const APNS_DIR = join(homedir(), '.orca', 'watch-apns')
const APNS_TEAM_ID = process.env.ORCA_WATCH_APNS_TEAM_ID ?? '28HX49S37H'
const APNS_TOPIC = process.env.ORCA_WATCH_APNS_TOPIC ?? 'com.cjna.orca.watch'
const POLL_MS = 2000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function loadToken() {
  if (!existsSync(TOKEN_PATH)) {
    mkdirSync(join(homedir(), '.orca'), { recursive: true })
    writeFileSync(TOKEN_PATH, randomBytes(32).toString('base64url'), { mode: 0o600 })
  }
  chmodSync(TOKEN_PATH, 0o600)
  return Buffer.from(readFileSync(TOKEN_PATH, 'utf8').trim())
}
const TOKEN = loadToken()

function authorized(req) {
  const header = req.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  return given.length === TOKEN.length && timingSafeEqual(given, TOKEN)
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
    const workspace = basename((status.worktreeId ?? '').split('::').at(-1) ?? '')
    prompts.push({
      id: createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 20),
      kind: 'approval',
      title: dialog.question,
      detail: [`${status.toolName}: ${status.toolInput ?? ''}`, ...dialog.context]
        .join('\n')
        .slice(0, 1200),
      source: [status.terminalTitle || tab.title, workspace].filter(Boolean).join(' · '),
      options: dialog.options.map((option) => ({ ...option, label: option.label.slice(0, 90) })),
      allowsText: true,
      createdAt: status.stateStartedAt,
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

let answerChain = Promise.resolve()
function answerPrompt(body) {
  const next = answerChain.then(async () => {
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
      // Esc declines the tool call; the reply then goes in as the next message.
      await orca('terminal', 'send', '--terminal', prompt.handle, '--text', '\u001b')
      await sleep(600)
      await orca(
        'terminal',
        'send',
        '--terminal',
        prompt.handle,
        '--text',
        body.text.slice(0, 2000),
        '--enter'
      )
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
  answerChain = next.catch(() => {})
  return next
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
    if (!authorized(req)) {
      return reply(401, { error: 'Unauthorized' })
    }
    if (req.method === 'GET' && req.url === '/watch/v1/prompts') {
      const prompts = (await pendingPrompts()).map(({ handle: _handle, ...prompt }) => prompt)
      return reply(200, { prompts })
    }
    if (req.method === 'POST' && req.url === '/watch/v1/register') {
      const result = registerDevice(JSON.parse(await readBody(req)))
      return reply(result.status, result.body)
    }
    if (req.method === 'POST' && req.url === '/watch/v1/answer') {
      const result = await answerPrompt(JSON.parse(await readBody(req)))
      return reply(result.status, result.body)
    }
    return reply(404, { error: 'Not found' })
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
