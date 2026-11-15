#!/usr/bin/env node
// Watch bridge (spike): lets the standalone Watch app list and answer terminal Claude Code permission
// prompts over plain HTTPS. Reads agent status from the local Orca runtime and answers by typing the
// option's key into that terminal through the version-matched `orca` CLI. Binds to loopback only; expose
// it with `tailscale funnel`. Every request needs the bearer token in ~/.orca/watch-bridge-token.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PORT = Number(process.env.ORCA_WATCH_BRIDGE_PORT ?? 6790)
const ORCA_CLI = process.env.ORCA_CLI ?? '/Applications/Orca.app/Contents/Resources/bin/orca'
const RUNTIME_METADATA = join(homedir(), 'Library/Application Support/orca/orca-runtime.json')
const TOKEN_PATH = join(homedir(), '.orca', 'watch-bridge-token')
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
      socket.write(`${JSON.stringify({ id: 'watch-bridge', authToken: metadata.authToken, method, params })}\n`)
    )
    socket.on('data', (chunk) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0) return
      clearTimeout(timer)
      socket.end()
      const frame = JSON.parse(buffer.slice(0, end))
      frame.ok ? resolve(frame.result) : reject(new Error(frame.error?.message ?? `${method} failed`))
    })
  })
}

async function orca(...args) {
  const { stdout } = await run(ORCA_CLI, [...args, '--json'], { timeout: 8000 })
  const frame = JSON.parse(stdout)
  if (!frame.ok) throw new Error(frame.error?.message ?? `orca ${args[0]} ${args[1]} failed`)
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
  if (questionAt < 0) return null
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
  if (options.length === 0) return null
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
    const screen = await orca('terminal', 'read', '--terminal', handle, '--screen').catch(() => null)
    const dialog = screen && parsePermissionDialog(screen.terminal?.tail ?? [])
    if (!dialog) continue
    const identity = [handle, status.stateStartedAt, status.toolName, status.toolInput, dialog.question]
    const workspace = basename((status.worktreeId ?? '').split('::').at(-1) ?? '')
    prompts.push({
      id: createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 20),
      kind: 'approval',
      title: dialog.question,
      detail: [`${status.toolName}: ${status.toolInput ?? ''}`, ...dialog.context].join('\n').slice(0, 1200),
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
  return terminals.some(({ status }) => status.terminalHandle === handle && status.stateStartedAt === since)
}

let answerChain = Promise.resolve()
function answerPrompt(body) {
  const next = answerChain.then(async () => {
    // Re-read right before typing: a key sent to a changed screen would answer something else.
    const prompt = (await pendingPrompts()).find((entry) => entry.id === body.promptId)
    if (!prompt) return { status: 409, body: { error: 'This prompt is no longer waiting' } }
    if (body.decision === 'option') {
      if (!prompt.options.some((option) => option.id === body.optionId)) {
        return { status: 400, body: { error: 'Unknown option' } }
      }
      await orca('terminal', 'send', '--terminal', prompt.handle, '--text', body.optionId)
    } else if (body.decision === 'text' && typeof body.text === 'string' && body.text.trim()) {
      // Esc declines the tool call; the reply then goes in as the next message.
      await orca('terminal', 'send', '--terminal', prompt.handle, '--text', '\u001b')
      await sleep(600)
      await orca('terminal', 'send', '--terminal', prompt.handle, '--text', body.text.slice(0, 2000), '--enter')
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
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${status} ${Date.now() - started}ms`)
  }
  try {
    if (!authorized(req)) return reply(401, { error: 'Unauthorized' })
    if (req.method === 'GET' && req.url === '/watch/v1/prompts') {
      const prompts = (await pendingPrompts()).map(({ handle, ...prompt }) => prompt)
      return reply(200, { prompts })
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
  server.listen(PORT, '127.0.0.1', () => console.log(`watch bridge on http://127.0.0.1:${PORT}`))
}
