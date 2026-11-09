import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  waitFor,
  type AcpAdapterRig
} from './testing/acp-structured-adapter.test-support'
import { GrokFixtureReplay } from './testing/acp-structured-fixture-replay.test-support'
import { readAcpFixture } from '../timeline/testing/acp-timeline-fixture.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const ask: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Fixture prompt' }]
}

async function replaying(name: string, agent: 'opencode' | 'opencode2' = 'opencode') {
  const replay = new GrokFixtureReplay(await readAcpFixture(name))
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor(agent)!,
    script: (scripted) => replay.attach(scripted)
  })
  await rig.acquire()
  await rig.adapter.dispatch({ sessionId: SESSION, clientMessageId: 'send-1', body: ask, fence: 1 })
  return { rig, replay }
}

async function turns(rig: AcpAdapterRig) {
  return (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
}

async function rowsOf(rig: AcpAdapterRig, kind: string) {
  return (await rig.rig.rows()).filter((row) => row.body.kind === kind)
}

async function answer(rig: AcpAdapterRig, replay: GrokFixtureReplay, optionId: string, index = 0) {
  const approval = await waitFor(async () => {
    const found = (await rowsOf(rig, 'approval'))[index]
    if (!found || replay.awaiting !== 'reply') {
      throw new Error('no pending approval yet')
    }
    return found
  })
  await rig.adapter.answerPrompt({
    sessionId: SESSION,
    itemId: approval.itemId,
    kind: 'approval',
    response: { kind: 'option', optionId },
    fence: 1,
    commit: async () => {}
  })
  return approval
}

describe('OpenCode recordings through the adapter', () => {
  it("a provider error fails the turn in OpenCode's own words", async () => {
    const { rig, replay } = await replaying('opencode-v1-provider-error')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () => expect(await turns(rig)).toMatchObject([{ outcome: 'failure' }]))
    const texts = JSON.stringify((await rig.rig.rows()).map((row) => row.body))
    expect(texts).toContain('CAPTURE_PROVIDER_400')
  })
})

describe('OpenCode 2 recordings through the adapter', () => {
  it('an approved shell command completes with its output and exit code', async () => {
    const { rig, replay } = await replaying('opencode-v2-tool', 'opencode2')
    const approval = await answer(rig, replay, 'once')
    expect(approval.body).toMatchObject({
      kind: 'approval',
      options: [
        { id: 'once', label: 'Allow once' },
        { id: 'always', label: 'Always allow' },
        { id: 'reject', label: 'Reject' }
      ]
    })
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'completed', outcome: 'success' }])
    )
    expect((await rowsOf(rig, 'tool-call')).at(-1)?.body).toMatchObject({
      state: 'completed',
      exitCode: 0,
      output: { head: 'TOOL-OK\n', truncated: false }
    })
  })

  // OpenCode 2.x ends denied-permission turns as cancelled, unlike 1.x.
  it('a rejected permission fails its tool and OpenCode ends the turn as cancelled', async () => {
    const { rig, replay } = await replaying('opencode-v2-deny', 'opencode2')
    await answer(rig, replay, 'reject')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'interrupted', outcome: 'cancellation' }])
    )
    expect((await rowsOf(rig, 'tool-call')).at(-1)?.body).toMatchObject({ state: 'failed' })
  })

  it('a Stop also ends a background subagent the finished turn left running', async () => {
    // OpenCode 2.0.21 shapes (opencode-v2-subagent-close): the child reports itself interrupted.
    const child = {
      rootSessionId: PROVIDER_SESSION,
      childSessionId: 'child-1',
      parentSessionId: PROVIDER_SESSION,
      depth: 1,
      title: 'Run sleep command'
    }
    const closed: unknown[] = []
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('opencode2')!,
      initialize: { agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } },
      script: (agent) => {
        agent.on('session/prompt', (frame) => {
          agent.notify('opencode/session/child_update', {
            ...child,
            type: 'status',
            status: 'running'
          })
          agent.reply(frame, { stopReason: 'end_turn' })
        })
        agent.on('session/close', (frame) => {
          closed.push(frame.params)
          agent.reply(frame, {})
          agent.notify('opencode/session/child_update', {
            ...child,
            type: 'status',
            status: 'interrupted'
          })
        })
      }
    })
    await rig.acquire()
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'send-1',
      body: ask,
      fence: 1
    })
    await waitFor(async () => expect(await turns(rig)).toMatchObject([{ state: 'completed' }]))
    // A permission card's Cancel stops only its own turn.
    await rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1, prompt: { itemId: 'card' } })
    expect(closed).toEqual([])
    await rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })
    await waitFor(() => expect(closed).toEqual([{ sessionId: 'child-1' }]))
  })

  it("a subagent's own Stop before it starts running stays available, and works once it runs", async () => {
    const child = {
      rootSessionId: PROVIDER_SESSION,
      childSessionId: 'child-1',
      parentSessionId: PROVIDER_SESSION,
      depth: 1
    }
    let notify: (status: string, id?: string) => void = () => {}
    let closeLate = false
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('opencode2')!,
      initialize: { agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } },
      script: (agent) => {
        notify = (status, id = 'child-1') =>
          agent.notify('opencode/session/child_update', {
            ...child,
            childSessionId: id,
            type: 'status',
            status
          })
        agent.on('session/prompt', (frame) => {
          notify('created')
          agent.reply(frame, { stopReason: 'end_turn' })
        })
        agent.on('session/close', (frame) => {
          if (closeLate) {
            notify('running', 'child-2')
            notify('interrupted', 'child-2')
            agent.fail(frame, -32603, 'session already closed')
            return
          }
          agent.reply(frame, {})
        })
      }
    })
    await rig.acquire()
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'send-1',
      body: ask,
      fence: 1
    })
    await waitFor(async () => expect(await turns(rig)).toMatchObject([{ state: 'completed' }]))
    const stop = () =>
      rig.adapter.stopBackgroundTasks!({ sessionId: SESSION, fence: 1, taskIds: ['child-1'] })
    await expect(stop()).resolves.toEqual({ cancelled: false, stillRunning: true })
    notify('running')
    await waitFor(() => expect(stop()).resolves.toEqual({ cancelled: true }))
    // A child that reports itself interrupted while the close is out was stopped, even if the close fails.
    notify('created', 'child-2')
    closeLate = true
    await waitFor(() =>
      expect(
        rig.adapter.stopBackgroundTasks!({ sessionId: SESSION, fence: 1, taskIds: ['child-2'] })
      ).resolves.toEqual({ cancelled: true })
    )
  })
})
