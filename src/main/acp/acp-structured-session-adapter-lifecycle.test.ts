import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  providerTurnId,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { StructuredAgentSessionTaskQueue } from '../native-chat/agent-session-wire/structured-agent-session-task-queue'
import { tick } from './acp-scripted-agent.test-support'
import {
  GROK,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  replyChunk,
  sendHello,
  waitFor,
  type AcpAdapterRig
} from './acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

async function journalTurns(rig: AcpAdapterRig) {
  return (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
}

const turnIdOf = (promptId: string) => providerTurnId(promptId, PROVIDER_SESSION)

describe('ACP Stop names a turn', () => {
  it('a Stop naming a turn that has ended stops nothing running now', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'old')
    const old = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:old', 'done'))
    rig.child().agent.reply(old, { stopReason: 'end_turn' })
    await rig.settle()
    await sendHello(rig, 'new')
    const current = await rig.frame('session/prompt', 1)
    rig.child().agent.notify('session/update', replyChunk('prompt:new', 'working'))
    await rig.settle()
    rig
      .child()
      .agent.on('session/cancel', () =>
        rig.child().agent.reply(current, { stopReason: 'cancelled' })
      )
    const live = turnIdOf('prompt:new')
    await expect(
      rig.adapter.cancelTurn({
        sessionId: SESSION,
        fence: 1,
        turnId: turnIdOf('prompt:old'),
        resolveLiveTurnId: () => live
      })
    ).resolves.toEqual({ cancelled: false, refusal: { turnNotRunning: true } })
    await rig.settle()
    expect(rig.sent('session/cancel')).toHaveLength(0)
    expect(rig.settled.map((settled) => settled.clientMessageId)).toEqual(['old', 'new'])
  })

  it('a Stop naming an ended turn during the gap before the next prompt opens stops that prompt', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'old')
    const old = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:old', 'done'))
    rig.child().agent.reply(old, { stopReason: 'end_turn' })
    await rig.settle()
    await sendHello(rig, 'new')
    await rig.frame('session/prompt', 1)
    await rig.settle()
    // The journal shows no turn running: Grok has not echoed the new prompt yet, as with Claude.
    await expect(
      rig.adapter.cancelTurn({
        sessionId: SESSION,
        fence: 1,
        turnId: turnIdOf('prompt:old'),
        resolveLiveTurnId: () => null
      })
    ).resolves.toEqual({ cancelled: true })
    expect(rig.sent('session/cancel')).toHaveLength(1)
  })

  it('a Stop naming the turn running now stops it and withdraws the steer waiting on its cancel', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'new')
    const current = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:new', 'working'))
    await sendHello(rig, 'follow-up')
    await rig.settle()
    rig
      .child()
      .agent.on('session/cancel', () =>
        rig.child().agent.reply(current, { stopReason: 'cancelled' })
      )
    const live = turnIdOf('prompt:new')
    await expect(
      rig.adapter.cancelTurn({
        sessionId: SESSION,
        fence: 1,
        turnId: live,
        resolveLiveTurnId: () => live
      })
    ).resolves.toEqual({ cancelled: true })
    // The steer's cancel, then the Stop's own bounded one.
    expect(rig.sent('session/cancel')).toHaveLength(2)
    expect(rig.settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientMessageId: 'follow-up', state: 'rejected' })
      ])
    )
  })
})

describe('ACP Stop of a turn Grok began itself', () => {
  it('cancels a turn opened by a background completion; the Stop waits for it to end', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    const { agent } = rig.child()
    agent.notify('session/update', replyChunk('task-completed-background-1', 'Working on it'))
    await rig.settle()
    expect((await journalTurns(rig)).at(-1)).toMatchObject({ state: 'running' })
    agent.on('session/cancel', () =>
      agent.notify('x.ai/session_notification', {
        sessionId: PROVIDER_SESSION,
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'task-completed-background-1',
          stop_reason: 'cancelled'
        }
      })
    )
    expect(rig.adapter.stopEndsSession()).toBe(true)
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    await rig.adapter.awaitStoppedRequestEnd(SESSION, Date.now())
    expect(rig.sent('session/cancel')).toHaveLength(1)
    expect((await journalTurns(rig)).at(-1)).toMatchObject({ state: 'interrupted' })
    // The host ends the child next; the adapter does not end it on its own.
    expect(rig.child().closes).toBe(0)
  })

  it("ends the Stop's wait at its grace when Grok never ends its own turn", async () => {
    const rig = await openAcpAdapterRig({ deps: { stopGraceMs: 20 } })
    await rig.acquire()
    rig.child().agent.notify('session/update', replyChunk('task-completed-background-1', 'Busy'))
    await rig.settle()
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    await rig.adapter.awaitStoppedRequestEnd(SESSION, Date.now())
    expect((await journalTurns(rig)).at(-1)).toMatchObject({ state: 'running' })
    expect(rig.child().closes).toBe(0)
  })
})

describe('ACP connection loss', () => {
  it('settles a send the agent never took as unknown when its stdin breaks, stops the child and tells the host', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'lost')
    await rig.frame('session/prompt')
    await sendHello(rig, 'held')
    rig.child().agent.stdin.destroy()
    await rig.settle()
    await waitFor(() =>
      expect(rig.lifecycle).toMatchObject([
        { type: 'ended', cause: 'unexpected-exit', acquisitionGeneration: 'gen-acp' }
      ])
    )
    expect(rig.settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientMessageId: 'lost', state: 'unknown' }),
        expect.objectContaining({ clientMessageId: 'held', state: 'rejected' })
      ])
    )
    expect(rig.child().closes).toBe(1)
    // Nothing was opened for a send the agent never echoed, so nothing claims it completed.
    expect(await journalTurns(rig)).toEqual([])
    await expect(sendHello(rig, 'after')).rejects.toThrow(/no live grok child/)
  })

  it("ends a crash whose stdout closed before its exit at that exit, with Grok's last words", async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    rig.child().stderr = 'panic: out of memory'
    rig.child().agent.stdout.end()
    await rig.settle()
    expect(rig.lifecycle).toEqual([])
    rig.child().exit()
    await waitFor(() => expect(rig.lifecycle).toHaveLength(1))
    expect(rig.lifecycle[0]).toMatchObject({
      type: 'ended',
      cause: 'unexpected-exit',
      reason: 'grok ACP agent exited: panic: out of memory',
      failure: { kind: 'providerExited', detail: { text: 'panic: out of memory' } }
    })
  })

  it('keeps a crash a crash when a stop Orca asks for lands before its unproven exit', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    const child = rig.child()
    child.proveClose = async () => false
    child.stderr = 'panic: late'
    child.agent.close()
    await rig.settle()
    expect(rig.lifecycle).toEqual([])
    // Never left Orca, so it is not recorded as unconfirmed.
    expect(
      await rig.adapter.dispatch({
        sessionId: SESSION,
        clientMessageId: 'after',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'after' }] },
        fence: 1
      })
    ).toEqual({
      state: 'rejected',
      reason: 'Grok stopped before this message was sent.',
      rejection: { kind: 'providerExited' }
    })
    // The next start's stop of the old child is one Orca asked for; it does not rename the crash.
    await expect(rig.acquire()).rejects.toMatchObject({
      name: 'AgentSessionAcquisitionExitUnprovenError'
    })
    child.exit()
    await waitFor(() => expect(rig.lifecycle).toHaveLength(1))
    expect(rig.lifecycle[0]).toMatchObject({
      cause: 'unexpected-exit',
      reason: 'grok ACP agent exited: panic: late',
      failure: { kind: 'providerExited', detail: { text: 'panic: late' } }
    })
  })

  it('leaves a running turn unverifiable, never completed, when its stdin breaks mid-turn', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'lost')
    await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:lost', 'partial'))
    await rig.settle()
    rig.child().agent.stdin.destroy()
    await waitFor(async () =>
      expect((await journalTurns(rig)).at(-1)).toMatchObject({ state: 'unverifiable' })
    )
    expect(rig.child().closes).toBe(1)
  })

  it('ends the turn as failed on an answer Orca cannot read, and sends the next message', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'garbled')
    const prompt = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:garbled', 'partial'))
    // Usage without the totals the schema requires: the answer fails to parse.
    rig.child().agent.reply(prompt, {
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 2 }
    })
    await rig.settle()
    expect((await journalTurns(rig)).at(-1)).toMatchObject({
      state: 'completed',
      outcome: 'failure'
    })
    await sendHello(rig, 'next')
    const next = await rig.frame('session/prompt', 1)
    expect(rig.sent('session/cancel')).toEqual([])
    rig.child().agent.notify('session/update', replyChunk('prompt:next', 'ok'))
    rig.child().agent.reply(next, { stopReason: 'end_turn' })
    await rig.settle()
    expect(rig.settled.map((settled) => settled.clientMessageId)).toEqual(['garbled', 'next'])
    expect(rig.child().closes).toBe(0)
    expect(rig.lifecycle).toEqual([])
  })

  it('leaves Grok running when it ends its stdout but can still be written to', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'quiet')
    await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:quiet', 'partial'))
    await rig.settle()
    rig.child().agent.stdout.end()
    await rig.settle()
    expect((await journalTurns(rig)).at(-1)).toMatchObject({ state: 'running' })
    expect(rig.child().closes).toBe(0)
    expect(rig.lifecycle).toEqual([])
    await expect(rig.adapter.closeSession(SESSION)).resolves.toBe(true)
    expect(rig.lifecycle).toMatchObject([{ type: 'ended', cause: 'requested-close' }])
  })
})

describe('ACP refusals', () => {
  it('rejects a send the agent refused before starting its turn', async () => {
    const rig = await openAcpAdapterRig({
      script: (agent) =>
        agent.on('session/prompt', (frame) => agent.fail(frame, -32602, 'unsupported input'))
    })
    await rig.acquire()
    await sendHello(rig, 'refused')
    await waitFor(() =>
      expect(rig.settled).toMatchObject([
        { clientMessageId: 'refused', state: 'rejected', rejection: { kind: 'providerRejected' } }
      ])
    )
    expect(await journalTurns(rig)).toEqual([])
    // The session takes the next send.
    rig.child().agent.on('session/prompt', () => {})
    await sendHello(rig, 'next')
    await rig.frame('session/prompt', 1)
  })

  it('ends a started turn as failed when the agent answers its prompt with an error', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'failing')
    const prompt = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:failing', 'partial'))
    await rig.settle()
    rig.child().agent.fail(prompt, -32603, 'model overloaded')
    await waitFor(async () =>
      expect((await journalTurns(rig)).at(-1)).toMatchObject({
        state: 'completed',
        outcome: 'failure'
      })
    )
    expect(rig.settled).toMatchObject([{ clientMessageId: 'failing', providerIdentity: {} }])
    expect(rig.child().closes).toBe(0)
  })
})

describe('ACP startup that never answers', () => {
  it('lets a close stop the child while the handshake is unanswered', async () => {
    const rig = await openAcpAdapterRig({ script: (agent) => agent.on('initialize', () => {}) })
    const queue = new StructuredAgentSessionTaskQueue()
    const start = new AbortController()
    const acquiring = queue.serialize(SESSION, () => rig.acquire({ signal: start.signal }))
    const failed = acquiring.catch((error: unknown) => error)
    await rig.frame('initialize')
    // What the host's close does outside the queue, then its queued stop.
    start.abort()
    const closing = queue.serialize(SESSION, () => rig.adapter.closeSession(SESSION))
    expect(rig.child().closes).toBe(1)
    expect(await failed).toMatchObject({ message: 'Grok was closed while starting' })
    await expect(closing).resolves.toBe(true)
    expect(rig.lifecycle).toEqual([])
  })

  it('leaves the child of a start that returned alone when its signal aborts later', async () => {
    const rig = await openAcpAdapterRig()
    const start = new AbortController()
    await rig.acquire({ signal: start.signal })
    // The host's close, landing while it still commits the attach, stops the child its own way.
    start.abort(new Error('closed while starting'))
    await rig.settle()
    expect(rig.child().closes).toBe(0)
    expect(rig.lifecycle).toEqual([])
  })

  it('lets a handshake Grok never answers run on until the start is aborted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const rig = await openAcpAdapterRig({
        script: (agent) => agent.on('session/new', () => {})
      })
      const start = new AbortController()
      const failed = rig.acquire({ signal: start.signal }).catch((error: unknown) => error)
      let settled = false
      void failed.then(() => {
        settled = true
      })
      await rig.settle()
      vi.advanceTimersByTime(30 * 60_000)
      await rig.settle()
      expect(settled).toBe(false)
      expect(rig.child().closes).toBe(0)
      start.abort()
      expect(await failed).toBeInstanceOf(Error)
      expect(rig.child().closes).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the child of a failed start until its exit is proven, and starts no other meanwhile', async () => {
    const rig = await openAcpAdapterRig({
      script: (agent) => agent.on('initialize', () => {})
    })
    const start = new AbortController()
    const failed = rig.acquire({ signal: start.signal }).catch((error: unknown) => error)
    await rig.frame('initialize')
    const child = rig.child()
    child.proveClose = vi.fn(async () => false)
    start.abort()
    expect(await failed).toMatchObject({ name: 'AgentSessionAcquisitionExitUnprovenError' })
    // Every later stop asks the child again, and none answers for it.
    expect(await rig.adapter.closeSession(SESSION)).toBe(false)
    await expect(rig.adapter.closeAll()).rejects.toThrow('could not be proven stopped')
    expect(await rig.acquire().catch((error: unknown) => error)).toMatchObject({
      name: 'AgentSessionAcquisitionExitUnprovenError'
    })
    expect(rig.spawned.filter((step) => step === 'spawn')).toHaveLength(1)
    child.exit()
    expect(await rig.adapter.closeSession(SESSION)).toBe(true)
  })

  it('spawns nothing for a start a close reached before its spawn', async () => {
    let releaseLaunch: () => void = () => {}
    const rig = await openAcpAdapterRig({
      deps: {
        resolveLaunch: async () => {
          await new Promise<void>((resolve) => {
            releaseLaunch = resolve
          })
          return {
            spec: GROK,
            command: '/opt/grok/bin/grok',
            args: [],
            cwd: '/workspace/project',
            env: {},
            fullAccess: false,
            resume: null
          }
        }
      }
    })
    const start = new AbortController()
    const failed = rig.acquire({ signal: start.signal }).catch((error: unknown) => error)
    await tick()
    start.abort()
    releaseLaunch()
    expect(await failed).toMatchObject({ name: 'AgentSessionPreSpawnError' })
    expect(rig.spawned).toEqual([])
  })
})

describe('ACP session release', () => {
  it('stops nothing for a chat it never started, as one an earlier Orca left', async () => {
    const rig = await openAcpAdapterRig()
    await expect(rig.adapter.releaseAcquisition({ sessionId: SESSION })).resolves.toBe(true)
    expect(rig.spawned).toEqual([])
    expect(rig.lifecycle).toEqual([])
  })

  it('keeps nothing of a chat once its child is proven closed', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    expect(rig.adapter.backgroundTaskStops(SESSION)).toBeDefined()
    await rig.adapter.closeSession(SESSION)
    // Both answer from the entry the adapter holds for a chat; none is left.
    expect(rig.adapter.backgroundTaskStops(SESSION)).toBeUndefined()
    expect(rig.adapter.readCommands(SESSION)).toBeUndefined()
  })

  it('keeps nothing of a chat whose child exited on its own', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    rig.child().exit()
    await waitFor(() => expect(rig.lifecycle).toHaveLength(1))
    expect(rig.adapter.backgroundTaskStops(SESSION)).toBeUndefined()
    await expect(rig.adapter.closeSession(SESSION)).resolves.toBe(true)
  })
})
