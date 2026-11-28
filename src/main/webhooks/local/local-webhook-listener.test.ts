import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../shared/automations/automation-definition'
import { deliverLocalCall, parseWebhookBody, redeliverQueued } from './local-webhook-delivery'
import { createLocalWebhookHandler } from './local-webhook-listener'
import { LocalWebhookStore, type LocalHook } from './local-webhook-store'
import { listenOnLoopback, webhookAutomation } from './local-webhook.test-fixture'

let dir: string
let store: LocalWebhookStore
let server: Server
let base: string
let hook: LocalHook
let automations: Automation[]
let received: { callId: string; subject?: string }[]

async function listen(limits?: { perHookPerMinute?: number; perMinute?: number }) {
  server?.close()
  server = createServer(
    createLocalWebhookHandler({
      store,
      automations: () => automations,
      bots: () => [{ id: hook.botId }],
      receive: (delivery, event) => {
        received.push({
          callId: delivery.event.key,
          ...(event.subject ? { subject: event.subject } : {})
        })
        return true
      },
      ...(limits ? { limits } : {})
    })
  )
  base = `http://127.0.0.1:${await listenOnLoopback(server)}`
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'local-webhooks-'))
  store = new LocalWebhookStore(dir)
  hook = await store.mint('op-1', 'auto-1', 'bot-1')
  automations = [webhookAutomation(hook)]
  received = []
  await listen()
})

afterEach(() => {
  vi.restoreAllMocks()
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })

describe('local webhook listener', () => {
  it('takes a call with the key in the URL or as a Bearer token', async () => {
    const inPath = await post(`/hooks/${hook.hookId}/${hook.key}`, { ok: 1 })
    expect(inPath.status).toBe(200)
    expect(await inPath.json()).toMatchObject({ status: 'queued' })
    const bearer = await post(
      `/hooks/${hook.hookId}`,
      { ok: 2 },
      { authorization: `Bearer ${hook.key}` }
    )
    expect(bearer.status).toBe(200)
    expect(received).toHaveLength(2)
    expect(await store.history(hook.hookId)).toMatchObject([
      { state: 'delivered' },
      { state: 'delivered' }
    ])
  })

  it('answers an unknown hook and a wrong key alike, and asks for a missing key', async () => {
    const wrongKey = await post(`/hooks/${hook.hookId}/orcawh_${'x'.repeat(43)}`, {})
    const unknown = await post(`/hooks/wh_AAAAAAAAAAAAAAAA/${hook.key}`, {})
    expect(wrongKey.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(await wrongKey.text()).toBe(await unknown.text())
    expect([...wrongKey.headers.keys()].sort()).toEqual([...unknown.headers.keys()].sort())
    const missing = await post(`/hooks/${hook.hookId}`, {})
    const missingUnknown = await post('/hooks/wh_AAAAAAAAAAAAAAAA', {})
    expect(missing.status).toBe(401)
    expect(await missing.text()).toBe(await missingUnknown.text())
    expect(received).toHaveLength(0)
  })

  it('takes POST only', async () => {
    const answer = await fetch(`${base}/hooks/${hook.hookId}/${hook.key}`)
    expect(answer.status).toBe(405)
    expect(answer.headers.get('allow')).toBe('POST')
    expect((await fetch(`${base}/`)).status).toBe(404)
  })

  it('refuses a body over 1 MiB, by its length or as it streams', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(1024 * 1024) })
    expect((await post(`/hooks/${hook.hookId}/${hook.key}`, big)).status).toBe(413)
    // No content-length: chunks are counted as they come.
    const streamed = await new Promise<number>((resolve) => {
      const req = request(
        `${base}/hooks/${hook.hookId}/${hook.key}`,
        {
          method: 'POST',
          headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' }
        },
        (res) => resolve(res.statusCode ?? 0)
      )
      // The listener closes the connection after its 413, so the rest of the upload fails.
      req.on('error', () => {})
      for (let i = 0; i < 9; i++) {
        req.write('y'.repeat(128 * 1024))
      }
      req.end()
    })
    expect(streamed).toBe(413)
    expect(received).toHaveLength(0)
  })

  it('refuses very deep JSON before storing it', async () => {
    const deep = `${'['.repeat(200)}${']'.repeat(200)}`
    const answer = await post(`/hooks/${hook.hookId}/${hook.key}`, deep)
    expect(answer.status).toBe(413)
    expect(await store.history(hook.hookId)).toEqual([])
  })

  it('answers 429 past the per-hook and the overall rate', async () => {
    await listen({ perHookPerMinute: 2 })
    const path = `/hooks/${hook.hookId}/${hook.key}`
    const statuses = [await post(path, {}), await post(path, {}), await post(path, {})].map(
      (answer) => answer.status
    )
    expect(statuses).toEqual([200, 200, 429])
    expect(await store.history(hook.hookId)).toContainEqual(
      expect.objectContaining({ kind: 'over_budget', count: 1 })
    )
    await listen({ perMinute: 1 })
    expect((await post(path, {})).status).toBe(200)
    expect((await post('/hooks/wh_AAAAAAAAAAAAAAAA/nokey', {})).status).toBe(429)
  })

  it("runs only calls that match the rule's filters, with their subject", async () => {
    automations = [
      webhookAutomation(hook, {
        where: [{ path: 'body.action', op: '=', values: ['opened'] }],
        subjectFrom: 'body.number'
      })
    ]
    const path = `/hooks/${hook.hookId}/${hook.key}`
    expect(await (await post(path, { action: 'closed', number: 1 })).json()).toMatchObject({
      status: 'ignored'
    })
    expect(await (await post(path, { action: 'opened', number: 7 })).json()).toMatchObject({
      status: 'queued'
    })
    expect(received).toEqual([{ callId: expect.any(String), subject: '7' }])
    const [queued, ignored] = await store.history(hook.hookId)
    expect(ignored).toMatchObject({ state: 'ignored' })
    expect(await store.envelope(ignored?.kind === 'call' ? ignored.callId : '')).toBeNull()
    expect(await store.envelope(queued?.kind === 'call' ? queued.callId : '')).not.toBeNull()
  })

  it('keeps a paused automation’s call out of its runs', async () => {
    automations = [webhookAutomation(hook, {}, false)]
    const answer = await post(`/hooks/${hook.hookId}/${hook.key}`, {})
    expect(await answer.json()).toMatchObject({ status: 'paused' })
    expect(received).toHaveLength(0)
  })

  it("drops a sender's repeated delivery id", async () => {
    const path = `/hooks/${hook.hookId}/${hook.key}`
    const headers = { 'x-github-delivery': 'd-1' }
    expect(await (await post(path, {}, headers)).json()).toMatchObject({ status: 'queued' })
    expect(await (await post(path, {}, headers)).json()).toEqual({ status: 'duplicate' })
    expect(await (await post(path, {}, { 'idempotency-key': 'd-2' })).json()).toMatchObject({
      status: 'queued'
    })
    expect(received).toHaveLength(2)
    expect(await store.history(hook.hookId)).toContainEqual(
      expect.objectContaining({ kind: 'duplicate', count: 1 })
    )
  })

  it('never stores Authorization or the key', async () => {
    await post(
      `/hooks/${hook.hookId}`,
      { echo: hook.key },
      { authorization: `Bearer ${hook.key}`, cookie: 'a=b', 'x-github-event': 'push' }
    )
    const [file] = readdirSync(join(dir, 'local-webhooks', 'envelopes'))
    const stored = readFileSync(join(dir, 'local-webhooks', 'envelopes', file ?? ''), 'utf8')
    expect(stored).not.toContain(hook.key)
    expect(stored).not.toContain('authorization')
    expect(stored).not.toContain('cookie')
    expect(JSON.parse(stored)).toMatchObject({
      headers: { 'x-github-event': 'push' },
      body: { kind: 'json', value: { echo: '[orca webhook key]' } }
    })
  })
})

describe('local webhook listener, keys and replays', () => {
  it('scrubs a key echoed with JSON escapes or percent-encoding', async () => {
    const escaped = `\\u006f${hook.key.slice(1)}`
    await post(`/hooks/${hook.hookId}/${hook.key}`, `{"echo":"${escaped}"}`)
    // The key's first letter, o, percent-encoded.
    await post(`/hooks/${hook.hookId}/${hook.key}`, `echo=%6F${hook.key.slice(1)}`, {
      'content-type': 'application/x-www-form-urlencoded'
    })
    const stored = readdirSync(join(dir, 'local-webhooks', 'envelopes')).map((file) =>
      readFileSync(join(dir, 'local-webhooks', 'envelopes', file), 'utf8')
    )
    expect(stored).toHaveLength(2)
    for (const text of stored) {
      expect(text).not.toContain(hook.key)
      expect(text).toContain('[orca webhook key]')
    }
  })

  it('refuses a call whose key a stop-now rotation ended while its body was read', async () => {
    // Each key check's answer; once the first has passed, the listener waits for the body.
    const authenticate = store.authenticate.bind(store)
    const answers: (string | null)[] = []
    let keyChecked: () => void = () => {}
    const checked = new Promise<void>((resolve) => (keyChecked = resolve))
    vi.spyOn(store, 'authenticate').mockImplementation(async (hookId, key) => {
      const opened = await authenticate(hookId, key)
      answers.push(opened?.hookId ?? null)
      keyChecked()
      return opened
    })
    const req = request(`${base}/hooks/${hook.hookId}/${hook.key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    })
    const status = new Promise<number>((resolve) =>
      req.on('response', (res) => resolve(res.statusCode ?? 0))
    )
    req.write('{"a":')
    await checked
    await store.rotate(hook.hookId, 'r-1', true)
    req.end('1}')
    expect(await status).toBe(404)
    // Opened before the body, refused by the check after it: the call never reached admission.
    expect(answers).toEqual([hook.hookId, null])
    expect(await store.history(hook.hookId)).toEqual([])
    expect(received).toHaveLength(0)
  })

  it('never hands over a call a stop-now rotation cancels, also one still running at handoff', async () => {
    const call = await store.admit(hook, { receivedAt: 1, state: 'queued' }, null)
    if (!call) {
      throw new Error('not taken')
    }
    // Not awaited: the rotation is still running when the handoff starts.
    const rotation = store.rotate(hook.hookId, 'r-3', true)
    const deps = {
      store,
      automations: () => automations,
      bots: () => [{ id: hook.botId }],
      receive: () => {
        received.push({ callId: 'handed' })
        return true
      }
    }
    await deliverLocalCall(deps, hook, call)
    await rotation
    expect(received).toEqual([])
    expect(await store.call(call.callId)).toMatchObject({ state: 'cancelled' })
  })

  it('keeps a delivery id only with its call: a resend after a failed admission is a new call', async () => {
    const path = `/hooks/${hook.hookId}/${hook.key}`
    const envelopes = join(dir, 'local-webhooks', 'envelopes')
    // A file where the envelopes folder goes, so storing the call fails.
    mkdirSync(join(dir, 'local-webhooks'), { recursive: true })
    writeFileSync(envelopes, '')
    expect((await post(path, {}, { 'x-github-delivery': 'd-1' })).status).toBe(500)
    rmSync(envelopes)
    expect(await (await post(path, {}, { 'x-github-delivery': 'd-1' })).json()).toMatchObject({
      status: 'queued'
    })
    expect(await (await post(path, {}, { 'x-github-delivery': 'd-1' })).json()).toEqual({
      status: 'duplicate'
    })
    // Hashed: the file never holds the id the sender sent.
    expect(readFileSync(join(dir, 'local-webhooks', 'hooks.json'), 'utf8')).not.toContain('d-1')
  })

  it('answers an overlapping resend only once the first is taken', async () => {
    const path = `/hooks/${hook.hookId}/${hook.key}`
    const headers = { 'x-github-delivery': 'd-2' }
    const answers = await Promise.all([post(path, {}, headers), post(path, {}, headers)])
    const statuses = await Promise.all(answers.map(async (answer) => (await answer.json()).status))
    expect(statuses.sort()).toEqual(['duplicate', 'queued'])
    expect((await store.history(hook.hookId)).filter((row) => row.kind === 'call')).toHaveLength(1)
  })

  it('hands a call over again after its handoff failed', async () => {
    let failures = 1
    const deps = {
      store,
      automations: () => automations,
      bots: () => [{ id: hook.botId }],
      receive: () => {
        if (failures-- > 0) {
          throw new Error('ledger write failed')
        }
        received.push({ callId: 'retried' })
        return true
      }
    }
    server.close()
    server = createServer(createLocalWebhookHandler(deps))
    base = `http://127.0.0.1:${await listenOnLoopback(server)}`
    const answer = await post(`/hooks/${hook.hookId}/${hook.key}`, {})
    expect(await answer.json()).toMatchObject({ status: 'queued' })
    expect(await store.queued()).toHaveLength(1)
    await redeliverQueued(deps)
    expect(received).toEqual([{ callId: 'retried' }])
    expect(await store.queued()).toEqual([])
  })

  it('hands nothing over for a call listed just after its hook was paused', async () => {
    // The pause cancels calls already listed; this one was being stored while it ran.
    await store.setState(hook.hookId, 'paused')
    const call = await store.admit(hook, { receivedAt: 1, state: 'queued' }, null)
    if (!call) {
      throw new Error('not taken')
    }
    const deps = {
      store,
      automations: () => automations,
      bots: () => [{ id: hook.botId }],
      receive: () => {
        received.push({ callId: 'handed' })
        return true
      }
    }
    expect(await deliverLocalCall(deps, hook, call)).toBe(true)
    expect(received).toEqual([])
    expect(await store.call(call.callId)).toMatchObject({ state: 'refused' })
  })

  it('hands nothing over for a call that came in before a pause and resume', async () => {
    const call = await store.admit(hook, { receivedAt: 1, state: 'queued' }, null)
    if (!call) {
      throw new Error('not taken')
    }
    // As if a pause and a resume both ran while the call was being stored.
    hook.epoch++
    const deps = {
      store,
      automations: () => automations,
      bots: () => [{ id: hook.botId }],
      receive: () => {
        received.push({ callId: 'handed' })
        return true
      }
    }
    expect(await deliverLocalCall(deps, hook, call)).toBe(true)
    expect(received).toEqual([])
    expect(await store.call(call.callId)).toMatchObject({ state: 'refused' })
  })

  it('refuses a call whose key a stop-now rotation ended before it was listed', async () => {
    const oldKey = hook.key
    await store.rotate(hook.hookId, 'r-2', true)
    const call = await store.admit(
      hook,
      { receivedAt: 1, state: 'queued' },
      {
        receivedAt: 1,
        contentType: null,
        headers: {},
        body: { kind: 'text', value: '' },
        truncated: false
      },
      { key: oldKey }
    )
    expect(call).toBeNull()
    expect(await store.history(hook.hookId)).toEqual([])
    expect(readdirSync(join(dir, 'local-webhooks', 'envelopes'))).toEqual([])
  })

  it('scrubs a key from the content type too', async () => {
    await post(`/hooks/${hook.hookId}/${hook.key}`, 'hello', {
      'content-type': `text/plain; echo=${hook.key}`
    })
    const [file] = readdirSync(join(dir, 'local-webhooks', 'envelopes'))
    const stored = readFileSync(join(dir, 'local-webhooks', 'envelopes', file ?? ''), 'utf8')
    expect(stored).not.toContain(hook.key)
  })
})

describe('parseWebhookBody', () => {
  it('reads JSON, forms with repeated keys, and text', () => {
    expect(parseWebhookBody('application/json; charset=utf-8', '{"a":1}')).toEqual({
      kind: 'json',
      value: { a: 1 }
    })
    expect(parseWebhookBody('application/x-www-form-urlencoded', 'a=1&a=2&b=3')).toEqual({
      kind: 'form',
      value: { a: ['1', '2'], b: '3' }
    })
    expect(parseWebhookBody('text/plain', 'hi')).toEqual({ kind: 'text', value: 'hi' })
    const tricky = parseWebhookBody(
      'application/x-www-form-urlencoded',
      'constructor=x&__proto__=y&toString=z'
    )
    expect(tricky?.kind === 'form' && Object.entries(tricky.value)).toEqual([
      ['constructor', 'x'],
      ['__proto__', 'y'],
      ['toString', 'z']
    ])
    expect(parseWebhookBody('application/json', '{')).toBeNull()
  })
})
