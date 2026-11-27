#!/usr/bin/env node
// Watch bridge (spike): lets the standalone Watch app list and answer terminal Claude Code permission
// prompts over plain HTTPS. Reads agent status from the local Orca runtime and answers by typing the
// option's key into that terminal through the version-matched `orca` CLI. Binds to loopback only; expose
// it with `tailscale funnel`. Every request needs a bearer token: the Watch token in ~/.orca/watch-bridge-token
// or the Siri token in ~/.orca/siri-bridge-token, each limited to its own endpoints.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { loadApnsKey, notifyWatch, registerDevice } from './watch-bridge-push.mjs'

const run = promisify(execFile)
const PORT = Number(process.env.ORCA_WATCH_BRIDGE_PORT ?? 6790)
const ORCA_CLI = process.env.ORCA_CLI ?? '/Applications/Orca.app/Contents/Resources/bin/orca'
const RUNTIME_METADATA = join(homedir(), 'Library/Application Support/orca/orca-runtime.json')
const TOKEN_PATH = join(homedir(), '.orca', 'watch-bridge-token')
const SIRI_TOKEN_PATH = join(homedir(), '.orca', 'siri-bridge-token')
const POLL_MS = 2000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function loadToken(path) {
  if (!existsSync(path)) {
    mkdirSync(join(homedir(), '.orca'), { recursive: true })
    writeFileSync(path, randomBytes(32).toString('base64url'), { mode: 0o600 })
  }
  chmodSync(path, 0o600)
  const token = readFileSync(path, 'utf8').trim()
  // A blank token would match a request with no Authorization header.
  if (token.length < 16) {
    throw new Error(`${path} holds no usable token; delete it so the bridge writes a new one`)
  }
  return Buffer.from(token)
}

// Each client gets only the endpoints it uses: the Watch can't send free text to an idle agent.
const CLIENTS = [
  {
    name: 'watch',
    token: loadToken(TOKEN_PATH),
    scopes: new Set(['prompts', 'answer', 'register']),
    // URLSession on the Watch gives up after 20s; a write must not land after the Watch reported failure.
    writeDeadlineMs: 15000,
    // The Watch asks for a second tap before a "Yes, and …" option, so it may send any parsed option.
    allowsModeChangingOptions: true
  },
  {
    name: 'siri',
    token: loadToken(SIRI_TOKEN_PATH),
    scopes: new Set(['prompts', 'answer', 'agents', 'message']),
    // Siri's request gives up after 9s.
    writeDeadlineMs: 7000,
    allowsModeChangingOptions: false
  }
]

function authorizedClient(req) {
  const header = req.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7).trim() : '')
  if (given.length === 0) {
    return null
  }
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
      buffer += String(chunk)
      const end = buffer.indexOf('\n')
      if (end === -1) {
        return
      }
      clearTimeout(timer)
      socket.end()
      let frame
      try {
        frame = JSON.parse(buffer.slice(0, end))
      } catch {
        reject(new Error(`${method} returned a malformed frame`))
        return
      }
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
      dialogKey: dialogKey(dialog),
      handle
    })
  }
  return prompts
}

const dialogKey = (dialog) => JSON.stringify([dialog.question, dialog.options, dialog.context])

// Re-reads only this terminal just before a key is typed, so the window for a changed dialog is one read.
async function dialogStillShown(prompt) {
  const screen = await orca('terminal', 'read', '--terminal', prompt.handle, '--screen').catch(
    () => null
  )
  const dialog = screen && parsePermissionDialog(screen.terminal?.tail ?? [])
  return Boolean(dialog) && dialogKey(dialog) === prompt.dialogKey
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

const withoutHandle = ({ handle: _handle, dialogKey: _dialogKey, ...rest }) => rest

// "Yes, and …" options change Claude's mode for the rest of the session; a voice answer may not pick them.
const isPlainAnswer = (label) => /^yes$/i.test(label.trim()) || /^no\b/i.test(label.trim())

const TOO_LATE = { status: 504, body: { error: 'That took too long, so nothing was sent' } }

// The key already went in, so a failed read-back is "sent, not confirmed", not an error.
async function confirmWithin(check) {
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(400)
      if (await check()) {
        return true
      }
    }
  } catch (error) {
    console.log(`confirm failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return false
}

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

function messageAgent(body, _client, deadline) {
  return enqueue(async () => {
    if (Date.now() > deadline) {
      return TOO_LATE
    }
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
    if (Date.now() > deadline) {
      return TOO_LATE
    }
    await typeReply(agent.handle, text, agent.needsApproval)
    const confirmed = await confirmWithin(async () => {
      const now = (await terminalAgents()).find((entry) => entry.id === agent.id)
      return !now || now.stateStartedAt !== agent.stateStartedAt
    })
    return { status: 200, body: { ok: true, confirmed, name: agent.name } }
  })
}

// Claude Code draws its input box between two horizontal rules; a bare shell never does.
async function showsClaudeInput(handle) {
  const screen = await orca('terminal', 'read', '--terminal', handle, '--screen').catch(() => null)
  const lines = (screen?.terminal?.tail ?? []).filter((line) => line.trim())
  return lines.slice(-8).filter((line) => /^\s*─{10,}/.test(line)).length >= 2
}

function answerPrompt(body, client, deadline) {
  return enqueue(async () => {
    if (Date.now() > deadline) {
      return TOO_LATE
    }
    const prompt = (await pendingPrompts()).find((entry) => entry.id === body.promptId)
    console.log(
      `answer ${body.decision} option=${body.optionId ?? '-'} prompt=${body.promptId} found=${Boolean(prompt)}`
    )
    if (!prompt) {
      return { status: 409, body: { error: 'This prompt is no longer waiting' } }
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (body.decision === 'option') {
      const option = prompt.options.find((entry) => entry.id === body.optionId)
      if (!option) {
        return { status: 400, body: { error: 'Unknown option' } }
      }
      if (!client.allowsModeChangingOptions && !isPlainAnswer(option.label)) {
        return { status: 403, body: { error: 'Only a plain Yes or No can be sent from here' } }
      }
    } else if (body.decision !== 'text' || !text) {
      return { status: 400, body: { error: 'Unsupported answer' } }
    }
    // Still a gap: the runtime has no send that is conditional on the dialog, so a change between this
    // read and the key below can't be ruled out. This keeps that window to one terminal read.
    if (!(await dialogStillShown(prompt))) {
      return { status: 409, body: { error: 'This prompt is no longer waiting' } }
    }
    if (Date.now() > deadline) {
      return TOO_LATE
    }
    if (body.decision === 'option') {
      await orca('terminal', 'send', '--terminal', prompt.handle, '--text', body.optionId)
    } else {
      await typeReply(prompt.handle, text, true)
    }
    const confirmed = await confirmWithin(
      async () => !(await stillWaiting(prompt.handle, prompt.createdAt))
    )
    return { status: 200, body: { ok: true, confirmed } }
  })
}

// Status flips to waiting slightly before the dialog draws, so a key is retried until its dialog parses.
// Pushes that failed transiently are retried with backoff while the prompt is still waiting.
const pushes = new Map()
const dialogTries = new Map()
const MAX_PUSH_RETRIES = 5
async function watchForPrompts() {
  try {
    const waiting = await waitingClaudeTerminals()
    const keys = new Set(
      waiting.map(({ status }) => `${status.terminalHandle}|${status.stateStartedAt}`)
    )
    for (const key of [...pushes.keys(), ...dialogTries.keys()]) {
      if (!keys.has(key)) {
        pushes.delete(key)
        dialogTries.delete(key)
      }
    }
    const now = Date.now()
    const due = [...keys].filter((key) => {
      const push = pushes.get(key)
      if (!push) {
        return (dialogTries.get(key) ?? 0) < 10
      }
      return push.retry && push.failures < MAX_PUSH_RETRIES && now >= push.nextAt
    })
    if (due.length > 0) {
      const prompts = await pendingPrompts()
      for (const key of due) {
        const prompt = prompts.find((entry) => `${entry.handle}|${entry.createdAt}` === key)
        if (prompt) {
          const push = pushes.get(key) ?? { delivered: new Set(), failures: 0, nextAt: 0 }
          pushes.set(key, push)
          dialogTries.delete(key)
          push.retry = await notifyWatch(prompt, push.delivered)
          if (push.retry) {
            push.failures += 1
            push.nextAt = Date.now() + POLL_MS * 2 ** push.failures
          }
        } else if (!pushes.has(key)) {
          dialogTries.set(key, (dialogTries.get(key) ?? 0) + 1)
          console.log(`waiting terminal ${key} has no dialog yet (try ${dialogTries.get(key)})`)
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
  'POST /watch/v1/answer': { scope: 'answer', writes: true, handle: answerPrompt },
  // One round trip for Siri: what's waiting plus every agent's state and last words.
  'GET /siri/v1/overview': {
    scope: 'agents',
    handle: async () => {
      const [prompts, agents] = await Promise.all([siriPrompts(), terminalAgents()])
      return { status: 200, body: { prompts, agents: agents.map(withoutHandle) } }
    }
  },
  'POST /siri/v1/answer': { scope: 'answer', writes: true, handle: answerPrompt },
  'POST /siri/v1/message': { scope: 'message', writes: true, handle: messageAgent }
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
    const result = await route.handle(body, client, started + client.writeDeadlineMs)
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
