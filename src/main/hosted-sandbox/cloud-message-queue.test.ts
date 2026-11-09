import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createCloudMessageQueue, type CloudMessageQueueDeps } from './cloud-message-queue'

type Sent = { clientOperationId: string; fence: number; text: string }

/** A host that records each operation once and replays it, like agentSession.send. */
function fakeHost() {
  const recorded = new Map<string, Sent>()
  const effects: Sent[] = []
  let fence = 7
  let failNextSendAfterRecording = false
  const call: CloudMessageQueueDeps['call'] = async (_env, method, params) => {
    if (method === 'agentSession.history') {
      return {
        id: method,
        ok: true,
        result: { ok: true, page: { fence } },
        _meta: { runtimeId: 'r' }
      }
    }
    const p = params as {
      envelope: { clientOperationId: string; expectedRuntimeFence: number }
      body: { blocks: { text: string }[] }
    }
    const id = p.envelope.clientOperationId
    if (!recorded.has(id)) {
      const sent = {
        clientOperationId: id,
        fence: p.envelope.expectedRuntimeFence,
        text: p.body.blocks[0]!.text
      }
      recorded.set(id, sent)
      effects.push(sent)
    }
    if (failNextSendAfterRecording) {
      failNextSendAfterRecording = false
      throw new Error('reply lost')
    }
    return {
      id: method,
      ok: true,
      result: { ok: true, replayed: false, fence, cursor: {}, value: {} },
      _meta: { runtimeId: 'r' }
    }
  }
  return {
    call,
    effects,
    setFence: (next: number) => (fence = next),
    loseNextReply: () => (failNextSendAfterRecording = true)
  }
}

function setup(path = join(mkdtempSync(join(tmpdir(), 'orca-q-')), 'q.json'), host = fakeHost()) {
  let asleep = true
  const wake = vi.fn(async () => {
    asleep = false
    return true
  })
  const queue = createCloudMessageQueue({
    path,
    locate: () => ({ environmentId: 'env', asleep }),
    wake,
    call: host.call,
    log: () => {}
  })
  return { queue, host, wake, path, sleep: () => (asleep = true) }
}

describe('cloud message queue', () => {
  it('wakes a sleeping workspace once and delivers prompts in order with the current fence', async () => {
    const { queue, host, wake } = setup()
    queue.enqueue({ workspaceId: 'w', sessionId: 's', text: 'first' })
    queue.enqueue({ workspaceId: 'w', sessionId: 's', text: 'second' })
    host.setFence(42)
    await Promise.all([queue.drive('w'), queue.drive('w')])
    expect(wake).toHaveBeenCalledTimes(1)
    expect(host.effects.map((e) => [e.text, e.fence])).toEqual([
      ['first', 42],
      ['second', 42]
    ])
    expect(queue.list('w').map((p) => p.state)).toEqual(['delivered', 'delivered'])
  })

  it('survives an app restart: a queued prompt is still there and is delivered by the new process', async () => {
    const first = setup()
    first.queue.enqueue({ workspaceId: 'w', sessionId: 's', text: 'after restart' })
    const host = fakeHost()
    const second = setup(first.path, host)
    expect(second.queue.list('w').map((p) => p.state)).toEqual(['queued'])
    await second.queue.drive()
    expect(host.effects.map((e) => e.text)).toEqual(['after restart'])
  })

  it('is at most once when the reply is lost: the retry reuses the operation id and the host replays', async () => {
    const host = fakeHost()
    const { queue, path } = setup(undefined, host)
    queue.enqueue({ workspaceId: 'w', sessionId: 's', text: 'once' })
    host.loseNextReply()
    await queue.drive('w')
    expect(queue.list('w')[0]!.state).toBe('sending')
    // Crash and restart while it is unconfirmed: the new process resends the same operation.
    const restarted = setup(path, host)
    await restarted.queue.drive('w')
    expect(host.effects).toHaveLength(1)
    expect(restarted.queue.list('w')[0]!.state).toBe('delivered')
  })

  it('allows cancel and edit only while queued', async () => {
    const { queue, host } = setup()
    const a = queue.enqueue({ workspaceId: 'w', sessionId: 's', text: 'draft' })
    const b = queue.enqueue({ workspaceId: 'w', sessionId: 's', text: 'drop me' })
    expect(queue.edit(a.id, 'edited')).toBe(true)
    expect(queue.cancel(b.id)).toBe(true)
    await queue.drive('w')
    expect(host.effects.map((e) => e.text)).toEqual(['edited'])
    expect(queue.cancel(a.id)).toBe(false)
    expect(queue.edit(a.id, 'too late')).toBe(false)
    expect(() => queue.enqueue({ workspaceId: 'w', sessionId: 's', text: '   ' })).toThrow()
  })

  it('stops at a host refusal it cannot retry and keeps later prompts queued behind it', async () => {
    const host = fakeHost()
    const call: CloudMessageQueueDeps['call'] = async (env, method, params, t) =>
      method === 'agentSession.send'
        ? {
            id: method,
            ok: true,
            result: {
              ok: false,
              refusal: { code: 'agent_session_operation_invalid', message: 'bad' }
            },
            _meta: { runtimeId: 'r' }
          }
        : host.call(env, method, params, t)
    const path = join(mkdtempSync(join(tmpdir(), 'orca-q-')), 'q.json')
    const queue = createCloudMessageQueue({
      path,
      locate: () => ({ environmentId: 'env', asleep: false }),
      wake: async () => true,
      call,
      log: () => {}
    })
    queue.enqueue({ workspaceId: 'w', sessionId: 's', text: 'x' })
    await queue.drive('w')
    expect(queue.list('w')[0]).toMatchObject({ state: 'failed', error: 'bad' })
  })

  it('does nothing when the wake fails, and keeps the prompt queued', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orca-q-')), 'q.json')
    const host = fakeHost()
    const queue = createCloudMessageQueue({
      path,
      locate: () => ({ environmentId: 'env', asleep: true }),
      wake: async () => false,
      call: host.call,
      log: () => {}
    })
    queue.enqueue({ workspaceId: 'w', sessionId: 's', text: 'x' })
    await queue.drive('w')
    expect(host.effects).toHaveLength(0)
    expect(queue.list('w')[0]!.state).toBe('queued')
  })

  it('fails a prompt whose chat the host no longer has, without sending it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orca-q-')), 'q.json')
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
      locate: () => ({ environmentId: 'env', asleep: false }),
      wake: async () => true,
      call,
      log: () => {}
    })
    queue.enqueue({ workspaceId: 'w', sessionId: 'gone', text: 'x' })
    await queue.drive('w')
    expect(queue.list('w')[0]!.state).toBe('failed')
    expect(sends).toHaveLength(0)
  })
})
