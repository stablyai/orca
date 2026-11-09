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
})
