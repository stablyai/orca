import { eventually } from '../host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  collectSubscriber,
  createRestTestRig,
  foundRestTestChat,
  readerSaw,
  REST_TEST_CALLER,
  restTestSend,
  type RestTestRig
} from '../host/testing/structured-agent-session-rest-test-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../host/testing/structured-agent-session-host-test-data.test-fixture'

let rig: RestTestRig

async function finishedRun(idleMs?: () => number | null): Promise<void> {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000, idleMs } })
  await foundRestTestChat(rig)
}

const agentRunning = () => rig.host.hasLoadedProviders()

afterEach(async () => {
  await rig.dispose()
})

describe('releasing a finished background run', () => {
  it('stops the agent of a run nobody watches without waiting out the idle window', async () => {
    await finishedRun()

    // A send still owed keeps the agent; under load the dispatch's settle trails its call.
    await eventually(async () => {
      await rig.host.releaseIdleSession(SESSION)
      expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION, undefined)
    })
    expect(agentRunning()).toBe(false)
  })

  it('keeps the agent while someone has the chat open', async () => {
    await finishedRun()
    await rig.host.subscribe({ id: 'pane', sessionId: SESSION, emit: () => {} })

    await rig.host.releaseIdleSession(SESSION)

    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
    expect(agentRunning()).toBe(true)
  })

  it('stops an open chat idle agent when asked to anyway, as an account switch does', async () => {
    await finishedRun(() => null)
    await rig.host.subscribe({ id: 'pane', sessionId: SESSION, emit: () => {} })

    await eventually(async () => {
      await rig.host.releaseIdleSession(SESSION, true)
      expect(agentRunning()).toBe(false)
    })
  })

  it("names a running agent's pinned home when its adapter reports none, as ACP's do", async () => {
    await finishedRun()
    const pinned = rig.store.getConversation(SESSION)?.accountHome

    expect(pinned).toBeDefined()
    expect(rig.host.childAccountHome(SESSION)).toBeUndefined()
    expect(rig.host.childAccountHome(SESSION, true)).toEqual(pinned)
    await eventually(async () => {
      await rig.host.releaseIdleSession(SESSION, true)
      expect(agentRunning()).toBe(false)
    })
    expect(rig.host.childAccountHome(SESSION, true)).toBeUndefined()
  })

  it('keeps the agent while the provider still holds a send', async () => {
    await finishedRun()
    rig.adapter.holdsDispatch.mockReturnValue(true)

    await rig.host.releaseIdleSession(SESSION)

    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
    expect(agentRunning()).toBe(true)
  })

  it('keeps the agent while a question waits for an answer', async () => {
    await finishedRun()
    rig.adapter.acquire.mock.calls.at(-1)![0].events!.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'approval-turn', ordinal: 70 },
      {
        kind: 'approval',
        title: 'Run the command?',
        detail: null,
        options: [{ id: 'allow', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await rig.host.flushStreamedEvents(SESSION)

    await rig.host.releaseIdleSession(SESSION)

    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
    expect(agentRunning()).toBe(true)
  })

  it('keeps the agent when chats are set to never stop', async () => {
    await finishedRun(() => null)

    await rig.host.releaseIdleSession(SESSION)

    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
    expect(agentRunning()).toBe(true)
  })

  it('resumes the same conversation when someone replies after the release', async () => {
    await finishedRun()
    // As above: the founding dispatch's settle can trail its call, which keeps the agent.
    await eventually(async () => {
      await rig.host.releaseIdleSession(SESSION)
      expect(agentRunning()).toBe(false)
    })

    const fence = rig.store.getConversation(SESSION)!.currentFence
    expect(await rig.host.send(REST_TEST_CALLER, restTestSend('and then?', fence))).toMatchObject({
      ok: true
    })

    await eventually(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
    // The provider thread the run started is the one the reply resumes.
    expect(rig.store.getRecord(SESSION)!.providerHandleChain.map((link) => link.handle)).toEqual([
      codexProviderHandle(THREAD),
      codexProviderHandle(THREAD)
    ])
    const reader = collectSubscriber()
    await rig.host.subscribe({ id: 'reader', sessionId: SESSION, emit: reader.emit })
    await eventually(() => expect(readerSaw(reader.events).texts).toEqual(['hello', 'and then?']))
  })
})
