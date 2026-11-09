import { afterEach, describe, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import { readTestHostJournal } from '../native-chat/agent-session-journal/journal-observation.test-support'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { PROVIDER_SESSION, replyChunk, waitFor } from './acp-structured-adapter.test-support'
import { openAttachedHostRig, promptIdOf, send } from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

describe('an ACP usage report with an unknown window', () => {
  // The protocol allows `size: 0`; the saved reader drops that window as unusable.
  it('keeps the turn running, and the live chat equals what a reload reads', async () => {
    const rig = await openAttachedHostRig()
    const { host } = rig
    await send(host, 'hello')
    const prompt = await rig.rig.frame('session/prompt')
    const { agent } = rig.rig.child()
    agent.notify('session/update', replyChunk(promptIdOf(prompt), 'Oak'))
    agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update: { sessionUpdate: 'usage_update', used: 1_200, size: 0 }
    })
    agent.notify('session/update', replyChunk(promptIdOf(prompt), ' tree'))
    agent.reply(prompt, { stopReason: 'end_turn' })
    await rig.rig.settle()
    await waitFor(async () =>
      expect((await rig.turns()).map((turn) => turn.state)).toEqual(['completed'])
    )
    expect(rig.rig.child().exited).toBe(false)
    expect((await rig.rows()).filter((row) => row.body.kind === 'status')).toEqual([])
    expect((await rig.turns()).at(-1)?.contextUsage).toBeUndefined()

    const saved = (await readTestHostJournal(host, SESSION)).items.flatMap(
      (item) => readAgentJournalTurn(item.body) ?? []
    )
    expect(saved).toEqual(await rig.turns())
    await host.close(SESSION, 'user-close')
  })
})
