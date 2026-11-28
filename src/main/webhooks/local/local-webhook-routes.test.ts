import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WEBHOOK_CALL_ID_PATTERN,
  WEBHOOK_HOOK_ID_PATTERN
} from '../../../shared/connector-webhook-contract'
import type { WebhookCloudCalls } from '../webhook-cloud-routes'
import { localWebhookCalls, switchedWebhookCalls } from './local-webhook-routes'
import { keyMatches } from './local-webhook-records'
import { LocalWebhookStore, type LocalCall } from './local-webhook-store'

// Lets a test make the store's file reads, writes or removals fail.
const removal = vi.hoisted(() => ({
  fail: false,
  failWrites: false,
  failReads: false,
  failHookFileWrites: 0
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (removal.failReads) {
        throw Object.assign(new Error('read failed'), { code: 'EIO' })
      }
      return await actual.readFile(...args)
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const hookFile = String(args[0]).includes('hooks.json')
      if (removal.failWrites || (hookFile && removal.failHookFileWrites-- > 0)) {
        throw new Error('write failed')
      }
      await actual.writeFile(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      // Not the writer's staged .tmp files: only a stored file's removal fails.
      if (removal.fail && !String(args[0]).endsWith('.tmp')) {
        throw new Error('removal failed')
      }
      await actual.rm(...args)
    }
  }
})

const WEBHOOK_KEY_PATTERN = /^orcawh_[A-Za-z0-9_-]{43}$/

let dir: string
let now: number
let store: LocalWebhookStore
let baseUrl: string
let delivered: LocalCall[]
let routes: WebhookCloudCalls

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-webhook-routes-'))
  now = 1_800_000_000_000
  store = new LocalWebhookStore(dir, () => now)
  baseUrl = 'http://127.0.0.1:6790'
  delivered = []
  routes = localWebhookCalls({
    store,
    baseUrl: () => baseUrl,
    deliver: async (_hook, call) => {
      delivered.push(call)
    },
    now: () => now
  })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const value = async <T>(result: Promise<{ ok: true; value: T } | { ok: false } | null> | null) => {
  const answer = await result
  if (!answer?.ok) {
    throw new Error('refused')
  }
  return answer.value
}
const mint = () => value(routes.mint({ operationId: 'op-1', automationId: 'a-1', botId: 'b-1' }))
const ENVELOPE = {
  receivedAt: 1,
  contentType: null,
  headers: {},
  body: { kind: 'text' as const, value: '' },
  truncated: false
}
/** A call the host was handed: pending, but no longer queued. */
const handedOver = async (local: Parameters<LocalWebhookStore['admit']>[0]) => {
  const call = await store.admit(local, { receivedAt: now, state: 'queued' }, ENVELOPE)
  if (!call || call === 'queue_full') {
    throw new Error('not taken')
  }
  await store.handOverQueued(call.callId, () => true)
  return call
}

describe('local webhook routes', () => {
  it("mints Orca Cloud's id and key formats, once per operation, and keeps them across restarts", async () => {
    const hook = await mint()
    expect(hook.hookId).toMatch(WEBHOOK_HOOK_ID_PATTERN)
    expect(await mint()).toEqual(hook)
    const { key } = await value(routes.reveal(hook.hookId, {}))
    expect(key).toMatch(WEBHOOK_KEY_PATTERN)
    const reopened = new LocalWebhookStore(dir, () => now)
    expect((await reopened.authenticate(hook.hookId, key))?.hookId).toBe(hook.hookId)
    expect(await reopened.authenticate(hook.hookId, `${key}x`)).toBeNull()
  })

  it('never acknowledges a mint whose write failed, also to an overlapping repeat', async () => {
    removal.failWrites = true
    try {
      const tries = await Promise.allSettled([mint(), mint()])
      expect(tries.map((entry) => entry.status)).toEqual(['rejected', 'rejected'])
    } finally {
      removal.failWrites = false
    }
    expect(await new LocalWebhookStore(dir, () => now).hooks()).toEqual([])
    const hook = await mint()
    expect(
      (await new LocalWebhookStore(dir, () => now).hooks()).map((entry) => entry.hookId)
    ).toEqual([hook.hookId])
  })

  it('keeps a taken call when removing an old envelope fails afterwards', async () => {
    const hook = await mint()
    const local = await store.hook(hook.hookId)
    if (!local) {
      throw new Error('no hook')
    }
    const envelope = {
      receivedAt: now,
      contentType: null,
      headers: {},
      body: { kind: 'text' as const, value: '' },
      truncated: false
    }
    // Started, so settled: the caps may let their envelopes go.
    for (let index = 0; index < 50; index++) {
      await store.start((await handedOver(local)).callId, `run-${index}`)
    }
    removal.fail = true
    try {
      // The 51st call pushes the oldest envelope out, and its removal fails.
      const call = await store.admit(local, { receivedAt: now, state: 'queued' }, envelope)
      if (!call || call === 'queue_full') {
        throw new Error('not taken')
      }
      expect(await new LocalWebhookStore(dir, () => now).call(call.callId)).toBeDefined()
    } finally {
      removal.fail = false
    }
  })

  it('never replaces the hooks after a failed read, and keeps an unreadable file aside', async () => {
    const hook = await mint()
    removal.failReads = true
    const reopened = new LocalWebhookStore(dir, () => now)
    try {
      await expect(reopened.hooks()).rejects.toThrow('read failed')
    } finally {
      removal.failReads = false
    }
    expect((await reopened.hooks()).map((entry) => entry.hookId)).toEqual([hook.hookId])
    writeFileSync(join(dir, 'local-webhooks', 'hooks.json'), '{not json')
    expect(await new LocalWebhookStore(dir, () => now).hooks()).toEqual([])
    expect(
      readdirSync(join(dir, 'local-webhooks')).some((name) =>
        name.startsWith('hooks.json.unreadable-')
      )
    ).toBe(true)
  })

  it('refuses a call for a hook removed while it was being stored', async () => {
    const hook = await mint()
    const local = await store.hook(hook.hookId)
    if (!local) {
      throw new Error('no hook')
    }
    await store.remove(hook.hookId)
    expect(
      await store.admit(local, { receivedAt: now, state: 'queued' }, null, { key: local.key })
    ).toBeNull()
    expect(await store.history(hook.hookId)).toEqual([])
  })

  it('keeps a call taken while a pause failed to save', async () => {
    const hook = await mint()
    const local = await store.hook(hook.hookId)
    if (!local) {
      throw new Error('no hook')
    }
    removal.failHookFileWrites = 1
    const [paused, call] = await Promise.allSettled([
      store.setState(hook.hookId, 'paused'),
      store.admit(local, { receivedAt: now, state: 'queued' }, null)
    ])
    expect(paused.status).toBe('rejected')
    const taken = call.status === 'fulfilled' && call.value !== 'queue_full' ? call.value : null
    expect(taken).not.toBeNull()
    const reopened = new LocalWebhookStore(dir, () => now)
    expect((await reopened.hook(hook.hookId))?.state).toBe('live')
    expect(await reopened.call(taken?.callId ?? '')).toMatchObject({ state: 'queued' })
  })

  it('counts every call a stop-now rotation cancels', async () => {
    const hook = await mint()
    const local = await store.hook(hook.hookId)
    if (!local) {
      throw new Error('no hook')
    }
    for (let index = 0; index < 50; index++) {
      await handedOver(local)
    }
    expect(await value(routes.rotate(hook.hookId, { operationId: 'r-1', stopNow: true }))).toEqual({
      cancelledCalls: 50
    })
  })

  it('keeps queued calls past the caps, and refuses a new one once 50 wait', async () => {
    const hook = await mint()
    const local = await store.hook(hook.hookId)
    if (!local) {
      throw new Error('no hook')
    }
    const queued: string[] = []
    for (let index = 0; index < 50; index++) {
      const call = await store.admit(local, { receivedAt: now, state: 'queued' }, ENVELOPE)
      queued.push(call && call !== 'queue_full' ? call.callId : '')
    }
    expect(await store.admit(local, { receivedAt: now, state: 'queued' }, ENVELOPE)).toBe(
      'queue_full'
    )
    // Ignored calls fill the history caps, but push no queued call or its envelope out.
    for (let index = 0; index < 200; index++) {
      await store.admit(local, { receivedAt: now, state: 'ignored' }, null)
    }
    for (const callId of queued) {
      expect(await store.envelope(callId)).not.toBeNull()
    }
    expect(await store.queued()).toHaveLength(50)
  })

  it('keeps calls handed over but not started past the caps, and counts them as waiting', async () => {
    const hook = await mint()
    const local = await store.hook(hook.hookId)
    if (!local) {
      throw new Error('no hook')
    }
    const handed: string[] = []
    for (let index = 0; index < 50; index++) {
      const call = await store.admit(local, { receivedAt: now, state: 'queued' }, ENVELOPE)
      if (!call || call === 'queue_full') {
        throw new Error('not taken')
      }
      await store.handOverQueued(call.callId, () => true)
      handed.push(call.callId)
    }
    expect(await store.admit(local, { receivedAt: now, state: 'queued' }, ENVELOPE)).toBe(
      'queue_full'
    )
    for (let index = 0; index < 200; index++) {
      await store.admit(local, { receivedAt: now, state: 'ignored' }, null)
    }
    for (const callId of handed) {
      expect(await store.call(callId)).toMatchObject({ state: 'delivered' })
      expect(await store.envelope(callId)).not.toBeNull()
    }
  })

  it('updates the last call only for that call, also one taken in the same millisecond', async () => {
    const hook = await mint()
    const local = await store.hook(hook.hookId)
    if (!local) {
      throw new Error('no hook')
    }
    const first = await store.admit(local, { receivedAt: now, state: 'queued' }, ENVELOPE)
    await store.admit(local, { receivedAt: now, state: 'ignored' }, null)
    if (!first || first === 'queue_full') {
      throw new Error('not taken')
    }
    await store.handOverQueued(first.callId, () => true)
    expect((await value(routes.get(hook.hookId))).lastCall).toEqual({
      at: now,
      state: 'ignored',
      signatureValid: false
    })
  })

  it('shows the local URL, or the Public URL when one is set', async () => {
    const hook = await mint()
    expect(hook.url).toBe(`http://127.0.0.1:6790/hooks/${hook.hookId}`)
    baseUrl = 'https://hooks.example.net/orca'
    expect((await value(routes.get(hook.hookId))).url).toBe(
      `https://hooks.example.net/orca/hooks/${hook.hookId}`
    )
  })

  it('compares keys in constant time over their digests', () => {
    expect(keyMatches('orcawh_a', 'orcawh_a')).toBe(true)
    expect(keyMatches('orcawh_a', 'orcawh_b')).toBe(false)
    expect(keyMatches('short', 'a much longer key')).toBe(false)
  })

  it('keeps the old key a day after a rotation, or stops it now', async () => {
    const hook = await mint()
    const first = (await store.hook(hook.hookId))?.key ?? ''
    await value(routes.rotate(hook.hookId, { operationId: 'r-1', stopNow: false }))
    const second = (await store.hook(hook.hookId))?.key ?? ''
    expect(second).not.toBe(first)
    expect(await store.authenticate(hook.hookId, first)).not.toBeNull()
    expect((await value(routes.get(hook.hookId))).keyGeneration).toBe(2)
    now += 25 * 60 * 60 * 1000
    expect(await store.authenticate(hook.hookId, first)).toBeNull()
    await value(routes.rotate(hook.hookId, { operationId: 'r-2', stopNow: true }))
    expect(await store.authenticate(hook.hookId, second)).toBeNull()
  })

  it('grants one start per call, for one run', async () => {
    const hook = await mint()
    const { callId } = await value(routes.sample(hook.hookId, 'sample-1'))
    expect(callId).toMatch(WEBHOOK_CALL_ID_PATTERN)
    expect(delivered.map((call) => call.callId)).toEqual([callId])
    expect((await value(routes.sample(hook.hookId, 'sample-1'))).callId).toBe(callId)
    expect(await value(routes.envelope(callId))).toMatchObject({ body: { kind: 'json' } })
    expect(await value(routes.start(callId, 'run-1'))).toEqual({ started: true, runId: 'run-1' })
    expect(await value(routes.start(callId, 'run-1'))).toEqual({ started: true, runId: 'run-1' })
    expect(await routes.start(callId, 'run-2')).toMatchObject({
      ok: false,
      status: 409,
      error: 'started_for_another_run'
    })
    expect(await value(routes.calls(hook.hookId))).toEqual({
      calls: [
        { kind: 'call', callId, receivedAt: now, state: 'started', sample: true, runId: 'run-1' }
      ]
    })
  })

  it('rotates once for an operation, also for a repeat that overlaps it', async () => {
    const hook = await mint()
    const local = await store.hook(hook.hookId)
    if (!local) {
      throw new Error('no hook')
    }
    await Promise.all([
      routes.rotate(hook.hookId, { operationId: 'r-1', stopNow: true }),
      routes.rotate(hook.hookId, { operationId: 'r-1', stopNow: true })
    ])
    expect((await value(routes.get(hook.hookId))).keyGeneration).toBe(2)
  })

  it('rotates once for overlapping repeats, also when removing a cancelled envelope fails', async () => {
    const hook = await mint()
    const { callId } = await value(routes.sample(hook.hookId, 'sample-1'))
    removal.fail = true
    try {
      const answers = await Promise.all([
        value(routes.rotate(hook.hookId, { operationId: 'r-1', stopNow: true })),
        value(routes.rotate(hook.hookId, { operationId: 'r-1', stopNow: true }))
      ])
      expect(answers).toEqual([{ cancelledCalls: 1 }, { cancelledCalls: 1 }])
    } finally {
      removal.fail = false
    }
    expect((await value(routes.get(hook.hookId))).keyGeneration).toBe(2)
    // The file stayed, but no call lists it any more.
    expect(await routes.envelope(callId)).toMatchObject({ ok: false, status: 404 })
  })
  it('makes one sample per operation, and delivers it again if its delivery failed', async () => {
    const hook = await mint()
    let failures = 1
    const flaky = localWebhookCalls({
      store,
      baseUrl: () => baseUrl,
      deliver: async (_hook, call) => {
        if (failures-- > 0) {
          throw new Error('delivery failed')
        }
        delivered.push(call)
      },
      now: () => now
    })
    await expect(value(flaky.sample(hook.hookId, 's-1'))).rejects.toThrow('delivery failed')
    const [first, second] = await Promise.all([
      value(flaky.sample(hook.hookId, 's-1')),
      value(flaky.sample(hook.hookId, 's-1'))
    ])
    expect(second.callId).toBe(first.callId)
    expect(delivered.map((call) => call.callId)).toEqual([first.callId])
  })

  it('cancels calls not yet started when the hook pauses', async () => {
    const hook = await mint()
    const { callId } = await value(routes.sample(hook.hookId, 'sample-1'))
    const paused = await value(
      routes.setState(hook.hookId, { operationId: 'p-1', state: 'paused' })
    )
    expect(paused).toMatchObject({ state: 'paused', epoch: 2, pendingCalls: 0 })
    expect(await routes.envelope(callId)).toMatchObject({ ok: false, status: 404 })
    expect(await routes.start(callId, 'run-1')).toMatchObject({ ok: false, status: 410 })
  })

  it('never reports a pause that was not saved, also to an overlapping request', async () => {
    const hook = await mint()
    removal.failWrites = true
    try {
      const tries = await Promise.allSettled([
        routes.setState(hook.hookId, { operationId: 'p-1', state: 'paused' }),
        routes.setState(hook.hookId, { operationId: 'p-2', state: 'paused' })
      ])
      expect(tries.map((entry) => entry.status)).toEqual(['rejected', 'rejected'])
    } finally {
      removal.failWrites = false
    }
    expect((await new LocalWebhookStore(dir, () => now).hook(hook.hookId))?.state).toBe('live')
    expect(
      await value(routes.setState(hook.hookId, { operationId: 'p-3', state: 'paused' }))
    ).toMatchObject({ state: 'paused', epoch: 2 })
    expect((await new LocalWebhookStore(dir, () => now).hook(hook.hookId))?.state).toBe('paused')
  })
  it('refuses sender signatures, and forgets a removed hook', async () => {
    const hook = await mint()
    expect(
      await routes.setSecret(hook.hookId, { operationId: 's-1', adapter: 'github', generate: true })
    ).toMatchObject({ ok: false, status: 400 })
    await value(routes.remove(hook.hookId))
    expect(await routes.get(hook.hookId)).toMatchObject({ ok: false, status: 404 })
    expect(await value(routes.list('b-1'))).toEqual({ hooks: [] })
  })

  it('switches between the cloud routes and the local ones on every call', async () => {
    let local: WebhookCloudCalls | null = null
    const cloud = {
      ...routes,
      list: () => Promise.resolve({ ok: true as const, value: { hooks: [] } })
    }
    const switched = switchedWebhookCalls(cloud, () => local)
    await mint()
    expect(await value(switched.list('b-1'))).toEqual({ hooks: [] })
    local = routes
    expect((await value(switched.list('b-1'))).hooks).toHaveLength(1)
  })
})
