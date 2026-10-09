// A Grok start the host aborts — at quit, by a close, or by an admitted Stop — through the one
// signal the host owns, with a scripted Grok, the real record store and an on-disk journal.

import { afterEach, describe, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { GROK_CONFIG_OPTIONS, waitFor } from './acp-structured-adapter.test-support'
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
const within = <T>(promise: Promise<T>, ms: number): Promise<T | typeof STALLED> =>
  Promise.race([
    promise,
    new Promise<typeof STALLED>((resolve) => setTimeout(resolve, ms, STALLED))
  ])

/** Runs `atEnd` once, right before the host ends an attach's controller: after its commit. */
function beforeAttachEnds(host: StructuredAgentSessionHost, atEnd: () => void): void {
  const aborts = host.collaboratorsForTests().runtimeState.acquireAborts
  const begin = aborts.begin.bind(aborts)
  let fired = false
  aborts.begin = (sessionId) => {
    const started = begin(sessionId)
    return {
      signal: started.signal,
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

/** Runs `during` once, while the attach is still probing the previous owner, before any launch. */
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
    // The start has no bound of its own: the quit is what ends it.
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
    // The chat closes; the next send has to start Grok again.
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
      // Accepted while the aborted start is still unwinding.
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
    // The restart's own child, not the first one's.
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

/** A Grok chat the user closed; each later start loads it. `hangsHandshake`: that child never
 *  answers `initialize`. */
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

/** The stopped message reads cancelled; the one sent after it reached Grok, with no failure row. */
async function expectDeliveredAfterStop(
  { rig, host }: Pick<Awaited<ReturnType<typeof openHostRig>>, 'rig' | 'host'>,
  secondId: string
): Promise<void> {
  const prompt = await rig.frame('session/prompt')
  expect(JSON.stringify(prompt.params)).toContain('second')
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
  expect(rows.filter((row) => row.body.kind === 'status')).toEqual([])
}
