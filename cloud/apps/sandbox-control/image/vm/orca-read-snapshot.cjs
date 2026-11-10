#!/usr/bin/env node
// Gathers what a sleeping workspace should still show (recent chats per agent session, agent
// status, git status/diff summary, PR link) from the running orcad over its local socket, then seals
// it to the reader keys the control plane passed, so only ciphertext leaves the VM.
// Run by orca-sandbox-read-snapshot right before the drain. Env:
//   ORCA_READ_SNAPSHOT_ID  rsn_<24 hex>     ORCA_READ_WORKSPACE_ID  sbx_<24 hex>
//   ORCA_READ_RECIPIENTS   JSON [{keyId, publicKeyB64}]   ORCA_READ_REASON  sleep|rollover
//   ORCA_USER_DATA_PATH    orcad's data dir (orca-runtime.json lives there)
// Prints one JSON line: {v:1, snapshotId, workspaceId, nonceB64, ciphertextB64, recipients[], stats}.
// Construction (keep in sync with src/shared/cloud-workspaces/read-snapshot.ts in the app):
//   body    = AES-256-GCM(dek, nonce, JSON, AAD "orca-cloud-read-v1:<workspaceId>:<snapshotId>")
//   wrapped = AES-256-GCM(HKDF-SHA256(X25519(eph, reader), eph||reader, "orca-cloud-read-wrap-v1"),
//             nonce_i, dek, AAD "orca-cloud-read-wrap-v1:<workspaceId>:<snapshotId>:<keyId>")
'use strict'
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const INFO = 'orca-cloud-read-v1'
const WRAP_INFO = 'orca-cloud-read-wrap-v1'
const PROJECT = '/vercel/sandbox/project'
const LIMITS = { sessions: 12, messagesPerSession: 60, messageChars: 4000, changes: 200, commits: 10 }
/** Plaintext budget: sealed + base64 it stays under the control plane's 220 kB and the 256 kB stdout cap. */
const MAX_PLAIN_BYTES = 150_000
const CALL_TIMEOUT_MS = 5_000
const TOTAL_BUDGET_MS = 20_000

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function x25519PublicKey(raw) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' })
}

function gcmSeal(key, nonce, plain, aad) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad))
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
}

/** Seals `payload` (an object) to every recipient; a malformed key is skipped, not fatal. */
function seal(payload, recipients, workspaceId, snapshotId) {
  const scope = `${workspaceId}:${snapshotId}`
  const dek = crypto.randomBytes(32)
  const nonce = crypto.randomBytes(12)
  const ciphertext = gcmSeal(dek, nonce, Buffer.from(JSON.stringify(payload)), `${INFO}:${scope}`)
  const sealedTo = []
  for (const recipient of recipients) {
    const reader = Buffer.from(String(recipient.publicKeyB64 || ''), 'base64')
    if (reader.length !== 32 || !/^rk_[0-9a-f]{24}$/.test(String(recipient.keyId || ''))) {
      continue
    }
    let shared
    const eph = crypto.generateKeyPairSync('x25519')
    try {
      shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: x25519PublicKey(reader) })
    } catch {
      continue
    }
    if (shared.every((byte) => byte === 0)) {
      continue
    }
    const ephRaw = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x, 'base64url')
    const kek = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephRaw, reader]), WRAP_INFO, 32))
    const wrapNonce = crypto.randomBytes(12)
    const wrapped = gcmSeal(kek, wrapNonce, dek, `${WRAP_INFO}:${scope}:${recipient.keyId}`)
    sealedTo.push({ keyId: recipient.keyId, ephemeralPublicKeyB64: b64(ephRaw), nonceB64: b64(wrapNonce), wrappedKeyB64: b64(wrapped) })
  }
  dek.fill(0)
  return { v: 1, snapshotId, workspaceId, nonceB64: b64(nonce), ciphertextB64: b64(ciphertext), recipients: sealedTo }
}

// --- gathering -------------------------------------------------------------------------------

/** One request per connection, like the CLI. A streaming method resolves on its first frame. */
function rpc(metadata, method, params, timeoutMs = CALL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const transport = (metadata.transports || [metadata.transport]).find((t) => t && (t.kind === 'unix' || t.kind === 'named-pipe'))
    if (!transport) {
      resolve(null)
      return
    }
    const socket = net.createConnection(transport.endpoint)
    const id = crypto.randomUUID()
    let buffer = ''
    let done = false
    const finish = (value) => {
      if (!done) {
        done = true
        clearTimeout(timer)
        socket.destroy()
        resolve(value)
      }
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, authToken: metadata.authToken, method, params })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          continue
        }
        if (!frame || frame.id !== id) {
          continue
        }
        finish(frame.ok === true ? frame.result : null)
        return
      }
    })
  })
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function messagesOf(history) {
  const items = isObj(history) && isObj(history.page) && Array.isArray(history.page.items) ? history.page.items : []
  const out = []
  for (const item of items) {
    const body = isObj(item) && isObj(item.body) ? item.body : null
    if (!body || body.kind !== 'message' || !Array.isArray(body.blocks)) {
      continue
    }
    const role = body.role
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      continue
    }
    const text = body.blocks
      .filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (text) {
      out.push({ itemId: String(item.itemId).slice(0, 200), role, text: text.slice(0, LIMITS.messageChars), at: num(item.observedAt) ?? 0 })
    }
  }
  return { messages: out, hasOlder: isObj(history) && isObj(history.page) && history.page.hasOlder === true }
}

function gitOf(status, log) {
  if (!isObj(status) && !isObj(log)) {
    return null
  }
  const entries = isObj(status) && Array.isArray(status.entries) ? status.entries.filter(isObj) : []
  let added = 0
  let removed = 0
  let counted = false
  const changes = entries.slice(0, LIMITS.changes).map((e) => {
    const a = num(e.added)
    const r = num(e.removed)
    if (a !== null || r !== null) {
      counted = true
    }
    return { path: String(e.path).slice(0, 1024), status: str(e.status, 20) || 'modified', area: str(e.area, 20) || 'unstaged', added: a, removed: r }
  })
  for (const e of entries) {
    added += num(e.added) || 0
    removed += num(e.removed) || 0
  }
  const items = isObj(log) && Array.isArray(log.items) ? log.items.filter(isObj) : []
  return {
    branch: isObj(status) && typeof status.branch === 'string' ? status.branch.replace(/^refs\/heads\//, '') : null,
    head: isObj(status) ? str(status.head, 64) : null,
    changes,
    changeCount: entries.length,
    added: counted ? added : null,
    removed: counted ? removed : null,
    commits: items.slice(0, LIMITS.commits).map((c) => ({
      id: String(c.id).slice(0, 64),
      subject: String(c.subject ?? '').slice(0, 300),
      author: str(c.author, 120),
      at: num(c.timestamp)
    }))
  }
}

function prOf(linked) {
  if (!isObj(linked) || num(linked.number) === null || typeof linked.url !== 'string' || !linked.url.startsWith('https://')) {
    return null
  }
  return {
    number: linked.number,
    title: String(linked.title ?? '').slice(0, 300),
    state: str(linked.state, 20) || 'open',
    url: linked.url.slice(0, 500),
    checksStatus: str(linked.checksStatus, 20),
    checksSummary: str(linked.checksSummary, 200)
  }
}

const STATUSES = new Set(['working', 'attention', 'idle'])

/** `call(method, params)` -> result | null. Never throws: a missing piece is left out. */
async function gather(call, { workspaceId, snapshotId, reason, now, deadline }) {
  const timeLeft = () => deadline - Date.now()
  const [statusFeed, ps] = await Promise.all([call('agentSession.subscribeStatus', null), call('worktree.ps', { limit: 20 })])
  const worktrees = isObj(ps) && Array.isArray(ps.worktrees) ? ps.worktrees.filter(isObj) : []
  const project = worktrees.find((w) => w.path === PROJECT) || worktrees[0] || null
  const selector = project && typeof project.path === 'string' ? `path:${project.path}` : `path:${PROJECT}`
  const [status, log] = await Promise.all([
    call('git.status', { worktree: selector, includeLineStats: true }),
    call('git.history', { worktree: selector, limit: LIMITS.commits })
  ])
  const summaries = isObj(statusFeed) && Array.isArray(statusFeed.sessions) ? statusFeed.sessions.filter(isObj) : []
  // Newest activity first; chats with nothing in them still list (agent + status).
  const picked = summaries
    .filter((s) => typeof s.sessionId === 'string')
    .sort((a, b) => (num(b.updatedAt) || 0) - (num(a.updatedAt) || 0))
    .slice(0, LIMITS.sessions)
  const sessions = []
  for (const s of picked) {
    const history = timeLeft() > 1_000 ? await call('agentSession.history', { sessionId: s.sessionId, direction: 'tail', limit: LIMITS.messagesPerSession }) : null
    const { messages, hasOlder } = messagesOf(history)
    sessions.push({
      sessionId: s.sessionId.slice(0, 200),
      agent: str(s.agent, 40),
      title: str(s.conversationName, 200) || str(s.latestPrompt, 200),
      status: STATUSES.has(s.status) ? s.status : 'unknown',
      turnOutcome: str(s.turnOutcome, 40),
      updatedAt: num(s.updatedAt),
      messages: messages.slice(-LIMITS.messagesPerSession),
      truncated: hasOlder || messages.length > LIMITS.messagesPerSession
    })
  }
  return {
    v: 1,
    workspaceId,
    snapshotId,
    capturedAt: now,
    reason,
    git: gitOf(status, log),
    pr: prOf(project && project.linkedPR),
    sessions
  }
}

/** Cuts the oldest messages (then long texts, then sessions) until the JSON fits the budget. */
function fitToBudget(payload, maxBytes = MAX_PLAIN_BYTES) {
  const size = () => Buffer.byteLength(JSON.stringify(payload))
  let guard = 0
  while (size() > maxBytes && guard++ < 10_000) {
    const longest = payload.sessions.reduce((best, s) => (!best || s.messages.length > best.messages.length ? s : best), null)
    if (longest && longest.messages.length > 4) {
      longest.messages.shift()
      longest.truncated = true
      continue
    }
    const longText = payload.sessions.flatMap((s) => s.messages).find((m) => m.text.length > 500)
    if (longText) {
      longText.text = `${longText.text.slice(0, 500)}…`
      continue
    }
    if (payload.git && payload.git.changes.length > 20) {
      payload.git.changes = payload.git.changes.slice(0, 20)
      continue
    }
    if (payload.sessions.length > 1) {
      payload.sessions.pop()
      continue
    }
    payload.sessions = []
    break
  }
  return payload
}

async function main() {
  const started = Date.now()
  const env = process.env
  const snapshotId = env.ORCA_READ_SNAPSHOT_ID || ''
  const workspaceId = env.ORCA_READ_WORKSPACE_ID || ''
  if (!/^rsn_[0-9a-f]{24}$/.test(snapshotId) || !/^sbx_[0-9a-f]{24}$/.test(workspaceId)) {
    process.stderr.write('bad ids\n')
    process.exit(2)
  }
  let recipients
  try {
    recipients = JSON.parse(env.ORCA_READ_RECIPIENTS || '[]')
  } catch {
    recipients = null
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    process.stderr.write('no recipients\n')
    process.exit(2)
  }
  const dataDir = env.ORCA_USER_DATA_PATH || path.join(env.HOME || '', '.orcad-data')
  let metadata
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(dataDir, 'orca-runtime.json'), 'utf8'))
  } catch {
    metadata = null
  }
  if (!metadata || !metadata.authToken) {
    process.stderr.write('orcad not running\n')
    process.exit(3)
  }
  const deadline = started + TOTAL_BUDGET_MS
  const call = (method, params) => rpc(metadata, method, params, Math.max(250, Math.min(CALL_TIMEOUT_MS, deadline - Date.now())))
  const payload = fitToBudget(await gather(call, { workspaceId, snapshotId, reason: (env.ORCA_READ_REASON || 'sleep').slice(0, 20), now: Date.now(), deadline }))
  const out = seal(payload, recipients, workspaceId, snapshotId)
  // Timing only: counts and sizes would describe the plaintext to the control plane's logs.
  out.stats = { collectMs: Date.now() - started }
  process.stdout.write(`${JSON.stringify(out)}\n`)
}

module.exports = { seal, gather, fitToBudget, messagesOf, gitOf, prOf, rpc }

if (require.main === module) {
  // A fixed message: an error text could carry workspace content into the control plane's logs.
  main().catch(() => {
    process.stderr.write('read snapshot failed\n')
    process.exit(1)
  })
}
