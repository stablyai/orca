// The adapter against Grok's recorded traffic: each recording plays back as the agent, and the
// assertions read the journal a client would see.

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  openAcpAdapterRig,
  waitFor,
  type AcpAdapterRig
} from './acp-structured-adapter.test-support'
import { GrokFixtureReplay } from './acp-structured-fixture-replay.test-support'
import { readAcpFixture } from './acp-timeline-fixture.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const ask: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Fixture prompt' }]
}

async function replaying(name: string): Promise<{ rig: AcpAdapterRig; replay: GrokFixtureReplay }> {
  const replay = new GrokFixtureReplay(await readAcpFixture(name))
  const rig = await openAcpAdapterRig({ script: (agent) => replay.attach(agent) })
  await rig.acquire()
  return { rig, replay }
}

async function turns(rig: AcpAdapterRig) {
  return (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
}

async function rowsOf(rig: AcpAdapterRig, kind: string) {
  return (await rig.rig.rows()).filter((row) => row.body.kind === kind)
}

function send(rig: AcpAdapterRig, clientMessageId: string) {
  return rig.adapter.dispatch({ sessionId: SESSION, clientMessageId, body: ask, fence: 1 })
}

describe('Grok recordings through the adapter', () => {
  it('s1: a read-only turn lands as one completed turn with its tools and reply', async () => {
    const { rig, replay } = await replaying('s1-basic')
    await send(rig, 'send-1')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'completed', outcome: 'success' }])
    )
    const tools = await rowsOf(rig, 'tool-call')
    expect(tools.length).toBeGreaterThan(0)
    expect(
      tools.every((row) => row.body.kind === 'tool-call' && row.body.state === 'completed')
    ).toBe(true)
    expect(
      (await rig.rig.rows()).some(
        (row) => row.body.kind === 'message' && row.body.role === 'assistant'
      )
    ).toBe(true)
    expect(rig.settled).toMatchObject([{ clientMessageId: 'send-1', providerIdentity: {} }])
  })

  it('s2: an allowed and then a rejected permission are each answered once, after the commit', async () => {
    const { rig, replay } = await replaying('s2-permission')
    const answer = async (optionId: string, index: number) => {
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
    }
    await send(rig, 'send-1')
    await answer('allow-once', 0)
    await waitFor(async () => expect(await turns(rig)).toHaveLength(1))
    await waitFor(() => expect(replay.awaiting).toBe('session/prompt'))
    await send(rig, 'send-2')
    await answer('reject-once', 1)
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([
        { state: 'completed', outcome: 'success' },
        { state: 'interrupted', outcome: 'cancellation' }
      ])
    )
  })

  it('s3: a Stop mid-tool ends the turn interrupted and the session takes the next prompt', async () => {
    const { rig, replay } = await replaying('s3-cancel')
    await send(rig, 'send-1')
    await waitFor(() => expect(replay.awaiting).toBe('session/cancel'))
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'interrupted', outcome: 'cancellation' }])
    )
    // The recording left the shell call `in_progress`; the turn's end cuts it short.
    const tool = (await rowsOf(rig, 'tool-call')).at(-1)
    expect(tool?.body).toMatchObject({ kind: 'tool-call', state: 'failed', endedAs: 'interrupted' })
    await send(rig, 'send-2')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect((await turns(rig)).at(-1)).toMatchObject({ state: 'completed', outcome: 'success' })
    )
  })
})
