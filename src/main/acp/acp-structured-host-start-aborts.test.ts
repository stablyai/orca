import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { createAcpAgentConnection } from './acp-agent-connection'
import { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import { PROVIDER_SESSION } from './acp-structured-adapter.test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { GROK_CONFIG_OPTIONS, replyChunk, waitFor } from './acp-structured-adapter.test-support'
import {
  attachParams,
  launch,
  openHostRig,
  RESUMES,
  send,
  stop
} from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const STALLED = Symbol('stalled')
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof STALLED> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<typeof STALLED>((resolve) => {
        timer = setTimeout(resolve, ms, STALLED)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Runs after the attach commits, before its controller ends. */
function beforeAttachEnds(host: StructuredAgentSessionHost, atEnd: () => void): void {
  const aborts = host.collaboratorsForTests().runtimeState.acquireAborts
  const begin = aborts.begin.bind(aborts)
  let fired = false
  aborts.begin = (sessionId) => {
    const started = begin(sessionId)
    return {
      ...started,
      end: () => {
        if (!fired) {
          fired = true
          atEnd()
        }
        started.end()
      }
    }
  }
}

/** Runs during owner probing, before launch. */
function duringOwnerProbe(host: StructuredAgentSessionHost, during: () => void): void {
  const state = host.collaboratorsForTests().runtimeState
  const probe = state.probeOwner.bind(state)
  let fired = false
  state.probeOwner = async (sessionId) => {
    if (!fired) {
      fired = true
      during()
    }
    return probe(sessionId)
  }
}

describe('a Grok start the host aborts', () => {
  it('quits promptly while Grok never answers its handshake, and stops the child', async () => {
    const { rig, host } = await openHostRig({
      script: (agent) => agent.on('initialize', () => {})
    })
    const attaching = host.attach(CALLER, attachParams())
    await rig.frame('initialize')
    expect(await within(host.flushAllStreamedEvents({ trigger: 'quit' }), 2_000)).not.toBe(STALLED)
    expect((await attaching).ok).toBe(true)
    expect(rig.child().exited).toBe(true)
    await rig.adapter.closeAll()
  })

  it('closes a chat whose start already returned as a close Orca asked for, not a crash', async () => {
    const { rig, host, store } = await openHostRig()
    const ended: unknown[] = []
    const handle = host.handleAdapterEvent.bind(host)
    host.handleAdapterEvent = (event) => {
      if (event.type === 'ended') {
        ended.push(event)
      }
      return handle(event)
    }
    let closing: Promise<void> | undefined
    beforeAttachEnds(host, () => {
      closing = host.close(SESSION, 'user-close')
    })
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await closing
    expect(rig.child().exited).toBe(true)
    expect(ended).toMatchObject([{ cause: 'requested-close' }])
    expect(store.getRecord(SESSION)?.lease.deathEvidence?.detail).not.toContain('exited')
  })

  it('never launches Grok for a chat closed while its attach was still reconciling', async () => {
    const { rig, host } = await openHostRig({
      script: (agent) => agent.on('initialize', () => {})
    })
    let closing: Promise<void> | undefined
    duringOwnerProbe(host, () => {
      closing = host.close(SESSION, 'user-close')
    })
    expect(
      await host.attach(CALLER, attachParams()).catch((error: unknown) => error)
    ).toMatchObject({ name: 'AgentSessionPreSpawnError' })
    expect(await within(closing!, 2_000)).not.toBe(STALLED)
    expect(rig.spawned).not.toContain('spawn')
  })

  it('never launches Grok for a start a Stop reached while its attach was still reconciling', async () => {
    const { rig, host } = await openHostRig()
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await host.close(SESSION, 'user-close')
    let stopping: ReturnType<typeof stop> | undefined
    duringOwnerProbe(host, () => {
      stopping = stop(host)
    })
    await send(host, 'hello')
    await waitFor(() => expect(stopping).toBeDefined())
    expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
    await host.flushStreamedEvents(SESSION)
    expect(rig.spawned.filter((step) => step === 'spawn')).toHaveLength(1)
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect(journal.submissions()).toMatchObject([
      { dispatchState: 'rejected', rejection: { kind: 'cancelled' } }
    ])
  })

  it('starts Grok afresh for a message sent right after a Stop reached a reconciling start', async () => {
    const { rig, host } = await openClosedResumableChat()
    let stopping: ReturnType<typeof stop> | undefined
    let second: Promise<string> | undefined
    duringOwnerProbe(host, () => {
      stopping = stop(host)
      second = send(host, 'second')
    })
    await send(host, 'hello')
    await waitFor(() => expect(second).toBeDefined())
    expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
    await expectDeliveredAfterStop({ rig, host }, await second!)
    expect(rig.spawned.filter((step) => step === 'spawn')).toHaveLength(2)
  })

  it('starts Grok afresh for a message sent right after a Stop ended a hung handshake', async () => {
    const { rig, host, children } = await openClosedResumableChat({ hangsHandshake: 2 })
    const first = send(host, 'hello')
    await waitFor(() => expect(children()).toBe(2))
    await rig.frame('initialize')
    const stopping = stop(host)
    const second = send(host, 'second')
    expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
    await first
    await expectDeliveredAfterStop({ rig, host }, await second)
    expect(children()).toBe(3)
  })
})

/** `hangsHandshake` selects a child that never answers initialize. */
async function openClosedResumableChat(options: { hangsHandshake?: number } = {}) {
  let children = 0
  let resumed = false
  const rig = await openHostRig({
    initialize: RESUMES,
    script: (agent) => {
      if (++children === options.hangsHandshake) {
        agent.on('initialize', () => {})
      }
      agent.on('session/load', (frame) =>
        agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
      )
    },
    deps: { resolveLaunch: launch(() => resumed) }
  })
  expect(await rig.host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
  await rig.ready()
  resumed = true
  await rig.host.close(SESSION, 'user-close')
  return { ...rig, children: () => children }
}

async function expectDeliveredAfterStop(
  { rig, host }: Pick<Awaited<ReturnType<typeof openHostRig>>, 'rig' | 'host'>,
  secondId: string
): Promise<void> {
  const prompt = await rig.frame('session/prompt')
  expect(prompt.params).toMatchObject({
    sessionId: 'acp-session-1',
    prompt: [{ type: 'text', text: 'second' }],
    _meta: { promptId: `prompt:${secondId}`, requestId: `prompt:${secondId}` }
  })
  rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
  const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  await waitFor(() =>
    expect(
      journal.submissions().find((entry) => entry.clientMessageId === secondId)?.dispatchState
    ).toBe('accepted')
  )
  expect(journal.submissions().map((entry) => entry.rejection?.kind ?? null)).toEqual([
    'cancelled',
    null
  ])
  await host.flushStreamedEvents(SESSION)
  const rows = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
  expect(rows.flatMap((row) => (row.body.kind === 'status' ? [row.body.text] : []))).toEqual([
    'Cancellation requested.'
  ])
}

it.each(['before-dispatch', 'after-beforeDispatch'] as const)(
  'rejects host dispatch %s during finite ACP receipt, with one end and original body',
  async (boundary) => {
    const agents: AcpScriptedAgent[] = []
    const children: ReturnType<typeof createFakePipedChild>[] = []
    const f = await openHostRig({
      deps: {
        connect: (launch, handlers) => {
          const agent = new AcpScriptedAgent()
          const child = Object.assign(createFakePipedChild(9_999_995), {
            stdin: agent.stdin,
            stdout: agent.stdout
          })
          agents.push(agent)
          children.push(child)
          agent.on('initialize', (frame) =>
            agent.reply(frame, { protocolVersion: 1, agentCapabilities: {} })
          )
          agent.on('session/new', (frame) =>
            agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: GROK_CONFIG_OPTIONS })
          )
          agent.confirmConfigOptions(GROK_CONFIG_OPTIONS)
          agent.on('_x.ai/subagent/cancel', (frame) =>
            agent.fail(
              frame,
              -32602,
              'Invalid params',
              'invalid params: missing field `subagentId`'
            )
          )
          agent.on('_x.ai/task/kill', (frame) =>
            agent.fail(frame, -32602, 'Invalid params', 'invalid params: missing field `sessionId`')
          )
          return createAcpAgentConnection(launch, handlers, () => child)
        }
      }
    })
    try {
      expect(await f.host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
      await f.ready()
      const child = children[0],
        agent = agents[0]
      const first = await send(f.host, 'original request')
      await waitFor(() =>
        expect(agent.frames.some((frame) => frame.method === 'session/prompt')).toBe(true)
      )
      const prompt = agent.frames.find((frame) => frame.method === 'session/prompt')!
      const body = 'Complete original response'
      agent.notify('session/update', replyChunk(`prompt:${first}`, body))
      agent.reply(prompt, { stopReason: 'end_turn' })
      await waitFor(async () => expect(await f.messages()).toContain(body))
      const dispatch = f.rig.adapter.dispatch.bind(f.rig.adapter)
      const seen = Promise.withResolvers<void>()
      vi.spyOn(f.rig.adapter, 'dispatch').mockImplementation(async (input) => {
        const died = () => {
          child.emit('exit', 1, null)
          seen.resolve()
        }
        if (boundary === 'before-dispatch') {
          died()
        }
        return dispatch({
          ...input,
          ...(boundary === 'after-beforeDispatch'
            ? {
                beforeDispatch: async () => {
                  await input.beforeDispatch?.()
                  died()
                }
              }
            : {})
        })
      })
      const sent = await send(f.host, 'must not reach the dead child')
      await seen.promise
      await waitFor(async () => {
        const row = (await f.host.journalSnapshot(SESSION)).submissions.find(
          (entry) => entry.clientMessageId === sent
        )
        expect(row).toMatchObject({
          dispatchState: 'rejected',
          rejection: { kind: 'providerExited', neverReachedAgent: true }
        })
      })
      expect(agent.frames.filter((frame) => frame.method === 'session/prompt')).toEqual([prompt])
      expect(f.rig.ended).toHaveLength(0)
      // Complete received data remains owned while admission is already terminal.
      child.stdout.end()
      await waitFor(() => expect(f.rig.ended).toHaveLength(1))
      await waitFor(() => expect(f.store.getRecord(SESSION)?.lease.claimStatus).toBe('released'))
      expect(await f.messages()).toContain(body)
    } finally {
      for (const child of children) {
        child.emit('exit', 0, null)
        child.stdout.end()
      }
      await f.rig.adapter.closeAll()
      await f.host.flushAllStreamedEvents({ trigger: 'quit' })
    }
  }
)
