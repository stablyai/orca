import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../shared/agent-session/agent-session-host-authority'
import {
  agentSessionOperationKey,
  evaluateAgentSessionOperation,
  type AgentSessionOperationRow
} from '../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import { SendParams } from '../../shared/rpc-contract/structured-agent-session-params'
import {
  createCloudMessageQueue,
  MAX_FAILURES,
  type CloudMessageQueueDeps,
  type WorkspaceAvailability
} from './cloud-message-queue'
import type { OfflineCacheCodec } from './cloud-offline-cache'

const SESSION = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b'

const codec: OfflineCacheCodec = {
  encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (sealed) => Buffer.from(sealed.map((b) => b ^ 0x5a)).toString('utf8')
}

type Envelope = {
  clientOperationId: string
  expectedRuntimeFence: number
  payloadFingerprint: string
}

/**
 * A host that admits operations with the real ledger rule (id format, age, replay by id) and
 * validates params with the real send schema.
 */
function realishHost(clock: () => number) {
  const rows = new Map<string, AgentSessionOperationRow>()
  const effects: { text: string; fence: number }[] = []
  const refusals: string[] = []
  let fence = 7
  let loseNextReply = false
  let historyFails = false
  const call: CloudMessageQueueDeps['call'] = async (_env, method, params) => {
    if (method === 'agentSession.history') {
      if (historyFails) {
        return {
          id: method,
          ok: false,
          error: { code: 'runtime_unreachable', message: 'down' },
          _meta: { runtimeId: null }
        }
      }
      return {
        id: method,
        ok: true,
        result: { ok: true, page: { fence } },
        _meta: { runtimeId: 'r' }
      }
    }
    const parsed = SendParams.parse(params)
    const envelope = parsed.envelope as Envelope
    const decision = evaluateAgentSessionOperation({
      rows,
      callerKey: 'desktop',
      operationId: envelope.clientOperationId,
      fingerprint: envelope.payloadFingerprint,
      now: clock()
    })
    if (decision.decision === 'refused') {
      refusals.push(decision.code)
      return {
        id: method,
        ok: true,
        result: { ok: false, refusal: { code: decision.code, message: decision.code } },
        _meta: { runtimeId: 'r' }
      }
    }
    if (decision.decision === 'admit') {
      rows.set(agentSessionOperationKey('desktop', envelope.clientOperationId), decision.row)
      effects.push({
        text: (parsed.body.blocks[0] as { text: string }).text,
        fence: envelope.expectedRuntimeFence
      })
    }
    if (loseNextReply) {
      loseNextReply = false
      throw new Error('reply lost')
    }
    return {
      id: method,
      ok: true,
      result: { ok: true, replayed: decision.decision === 'replay', fence, cursor: {}, value: {} },
      _meta: { runtimeId: 'r' }
    }
  }
  return {
    call,
    effects,
    refusals,
    rows,
    setFence: (next: number) => (fence = next),
    loseNextReply: () => (loseNextReply = true),
    setHistoryFails: (value: boolean) => (historyFails = value)
  }
}

function setup(
  opts: {
    path?: string
    host?: ReturnType<typeof realishHost>
    place?: () => WorkspaceAvailability
    clock?: { now: number }
  } = {}
) {
  const clock = opts.clock ?? { now: Date.now() }
  const path = opts.path ?? join(mkdtempSync(join(tmpdir(), 'orca-q-')), 'q.bin')
  const host = opts.host ?? realishHost(() => clock.now)
  let asleep = true
  const wake = vi.fn(async () => {
    asleep = false
    return true
  })
  const queue = createCloudMessageQueue({
    path,
    codec,
    now: () => clock.now,
    locate: async () =>
      opts.place?.() ??
      (asleep ? { kind: 'asleep', environmentId: 'env' } : { kind: 'up', environmentId: 'env' }),
    wake,
    call: host.call,
    log: () => {}
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { queue, host, wake, path, clock, settle, sleep: () => (asleep = true) }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('cloud message queue', () => {
  it('sends host-admissible operation ids (real admission rule and send schema)', async () => {
    const { queue, host, wake } = setup()
    await queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'first' })
    await queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'second' })
    await until(() => host.effects.length === 2)
    expect(host.refusals).toEqual([])
    expect(host.effects.map((e) => e.text)).toEqual(['first', 'second'])
    expect(wake).toHaveBeenCalledTimes(1)
    expect(queue.list('w').map((p) => p.state)).toEqual(['delivered', 'delivered'])
  })

  it('re-mints a never-sent id before it ages out of the host admission window', async () => {
    const clock = { now: Date.now() }
    const host = realishHost(() => clock.now)
    const place = { current: { kind: 'asleep', environmentId: 'env' } as WorkspaceAvailability }
    const parked = setup({ clock, host, place: () => place.current })
    parked.wake.mockResolvedValueOnce(false)
    await parked.queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'a day later' })
    // The wake failed: the prompt waits, queued, for the VM to be up.
    await until(() => parked.wake.mock.calls.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(parked.queue.list('w')[0]!.state).toBe('queued')
    clock.now += AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + 60_000
    place.current = { kind: 'up', environmentId: 'env' }
    await parked.queue.drive('w')
    expect(host.refusals).toEqual([])
    expect(parked.queue.list('w')[0]!.state).toBe('delivered')
  })

  it('survives an app restart sealed on disk; the background pass delivers once the VM is up', async () => {
    const first = setup()
    first.wake.mockResolvedValueOnce(false)
    await first.queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'after restart' })
    await until(() => first.wake.mock.calls.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(readFileSync(first.path).toString('utf8')).not.toContain('after restart')
    const host = realishHost(() => Date.now())
    let up = false
    const second = setup({
      path: first.path,
      host,
      place: () =>
        up ? { kind: 'up', environmentId: 'env' } : { kind: 'asleep', environmentId: 'env' }
    })
    expect(second.queue.list('w').map((p) => p.state)).toEqual(['queued'])
    await second.queue.drive()
    expect(second.wake).not.toHaveBeenCalled()
    expect(host.effects).toHaveLength(0)
    up = true
    second.clock.now += 10 * 60_000
    await second.queue.drive()
    expect(host.effects.map((e) => e.text)).toEqual(['after restart'])
  })

  it('is at most once when the reply is lost: the retry reuses the id and the host replays', async () => {
    const clock = { now: Date.now() }
    const host = realishHost(() => clock.now)
    const { queue, path } = setup({
      clock,
      host,
      place: () => ({ kind: 'up', environmentId: 'env' })
    })
    host.loseNextReply()
    await queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'once' })
    await until(() => queue.list('w')[0]!.state === 'sending')
    clock.now += 60 * 60_000
    const restarted = setup({
      path,
      clock,
      host,
      place: () => ({ kind: 'up', environmentId: 'env' })
    })
    await restarted.queue.drive('w')
    expect(host.effects).toHaveLength(1)
    expect(host.refusals).toEqual([])
    expect(restarted.queue.list('w')[0]!.state).toBe('delivered')
  })

  it('never wakes from the background, and stops after its failure budget', async () => {
    const clock = { now: Date.now() }
    const host = realishHost(() => clock.now)
    host.setHistoryFails(true)
    const { queue, wake } = setup({
      clock,
      host,
      place: () => ({ kind: 'up', environmentId: 'env' })
    })
    await queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'x' })
    for (let i = 0; i < MAX_FAILURES + 2; i++) {
      clock.now += 60 * 60_000
      await queue.drive()
    }
    expect(wake).not.toHaveBeenCalled()
    expect(queue.list('w')[0]!.state).toBe('failed')
    expect(host.effects).toHaveLength(0)
  })

  it('backs off between background attempts', async () => {
    const clock = { now: Date.now() }
    const host = realishHost(() => clock.now)
    host.setHistoryFails(true)
    const { queue } = setup({ clock, host, place: () => ({ kind: 'up', environmentId: 'env' }) })
    await queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'x' })
    await until(() => queue.list('w')[0]!.updatedAt > 0)
    const calls = vi.spyOn(host, 'call')
    await queue.drive()
    await queue.drive()
    expect(calls).not.toHaveBeenCalled()
  })

  it('does not wake or send to an archived or disconnected workspace', async () => {
    const { queue, wake, host } = setup({
      place: () => ({ kind: 'blocked', reason: 'This workspace is archived.' })
    })
    await expect(
      queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'x' })
    ).rejects.toThrow('archived')
    expect(wake).not.toHaveBeenCalled()
    expect(host.effects).toHaveLength(0)
  })

  it('fails waiting prompts when the workspace is slept, archived or removed', async () => {
    const q = setup()
    q.wake.mockResolvedValue(false)
    await q.queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'x' })
    q.queue.failPending('w', 'The workspace was put to sleep before this was sent.')
    expect(q.queue.list('w')[0]).toMatchObject({
      state: 'failed',
      error: 'The workspace was put to sleep before this was sent.'
    })
    const removed = setup({ place: () => ({ kind: 'gone' }) })
    await expect(
      removed.queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'x' })
    ).rejects.toThrow()
  })

  it('does not send a prompt cancelled or edited while its fence was being read', async () => {
    const clock = { now: Date.now() }
    const host = realishHost(() => clock.now)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const gated: CloudMessageQueueDeps['call'] = async (env, method, params, t) => {
      if (method === 'agentSession.history') {
        await gate
      }
      return host.call(env, method, params, t)
    }
    const queue = createCloudMessageQueue({
      path: join(mkdtempSync(join(tmpdir(), 'orca-q-')), 'q.bin'),
      codec,
      now: () => clock.now,
      locate: async () => ({ kind: 'up', environmentId: 'env' }),
      wake: async () => true,
      call: gated,
      log: () => {}
    })
    const a = await queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'cancel me' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queue.cancel(a.id)).toBe(true)
    release()
    await queue.drive('w')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(host.effects).toHaveLength(0)
  })

  it('fails a prompt whose chat the host no longer has, without sending it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orca-q-')), 'q.bin')
    const sends: unknown[] = []
    const call: CloudMessageQueueDeps['call'] = async (_env, method, params) => {
      if (method === 'agentSession.send') {
        sends.push(params)
      }
      return {
        id: method,
        ok: false,
        error: { code: 'agent_session_identity_required', message: 'x' },
        _meta: { runtimeId: 'r' }
      }
    }
    const queue = createCloudMessageQueue({
      path,
      codec,
      locate: async () => ({ kind: 'up', environmentId: 'env' }),
      wake: async () => true,
      call,
      log: () => {}
    })
    await queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'x' })
    await until(() => queue.list('w')[0]!.state === 'failed')
    expect(queue.list('w')[0]!.state).toBe('failed')
    expect(sends).toHaveLength(0)
  })

  it('keeps prompts in memory only when the OS cannot seal them, and clears on sign-out', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orca-q-')), 'q.bin')
    const queue = createCloudMessageQueue({
      path,
      codec: null,
      locate: async () => ({ kind: 'blocked', reason: 'x' }),
      wake: async () => false,
      call: async () => {
        throw new Error('no')
      },
      log: () => {}
    })
    await expect(
      queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'x' })
    ).rejects.toThrow()
    const sealed = setup()
    sealed.wake.mockResolvedValue(false)
    await sealed.queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'x' })
    sealed.queue.clear()
    expect(sealed.queue.list('w')).toEqual([])
  })

  it('does not resurrect a prompt a Sleep failed while its fence was being read', async () => {
    const clock = { now: Date.now() }
    const host = realishHost(() => clock.now)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const gated: CloudMessageQueueDeps['call'] = async (env, method, params, t) => {
      if (method === 'agentSession.history') {
        await gate
      }
      return host.call(env, method, params, t)
    }
    const queue = createCloudMessageQueue({
      path: join(mkdtempSync(join(tmpdir(), 'orca-q-')), 'q.bin'),
      codec,
      now: () => clock.now,
      locate: async () => ({ kind: 'up', environmentId: 'env' }),
      wake: async () => true,
      call: gated,
      log: () => {}
    })
    await queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'slept meanwhile' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    queue.failPending('w', 'The workspace was put to sleep before this was sent.')
    release()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(host.effects).toHaveLength(0)
    expect(queue.list('w')[0]!.state).toBe('failed')
  })

  it('ends a sent-but-unconfirmed prompt as unconfirmed, not failed, at its budget', async () => {
    const clock = { now: Date.now() }
    const host = realishHost(() => clock.now)
    const lossy: CloudMessageQueueDeps['call'] = async (env, method, params, t) => {
      const answer = await host.call(env, method, params, t)
      if (method === 'agentSession.send') {
        throw new Error('reply lost')
      }
      return answer
    }
    const queue = createCloudMessageQueue({
      path: join(mkdtempSync(join(tmpdir(), 'orca-q-')), 'q.bin'),
      codec,
      now: () => clock.now,
      locate: async () => ({ kind: 'up', environmentId: 'env' }),
      wake: async () => true,
      call: lossy,
      log: () => {}
    })
    await queue.enqueue({ workspaceId: 'w', sessionId: SESSION, text: 'maybe sent' })
    for (let i = 0; i < MAX_FAILURES + 1; i++) {
      clock.now += 60 * 60_000
      await queue.drive()
    }
    expect(queue.list('w')[0]!.state).toBe('unconfirmed')
    // The host saw it once; every retry replayed the same operation.
    expect(host.effects).toHaveLength(1)
  })

  it('removes the old plaintext queue file at install and on clear, even without a keychain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-q-'))
    const legacy = join(dir, 'orca-cloud-queued-prompts.json')
    writeFileSync(legacy, '{"version":1,"prompts":[{"text":"old plaintext"}]}')
    const queue = createCloudMessageQueue({
      path: join(dir, 'orca-cloud-queued-prompts.bin'),
      codec: null,
      locate: async () => ({ kind: 'gone' }),
      wake: async () => false,
      call: async () => {
        throw new Error('no')
      },
      log: () => {}
    })
    expect(existsSync(legacy)).toBe(false)
    writeFileSync(legacy, 'again')
    queue.clear()
    expect(existsSync(legacy)).toBe(false)
  })
})
