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

async function replaying(name: string) {
  const replay = new GrokFixtureReplay(await readAcpFixture(name))
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('kiro')!,
    script: (scripted) => replay.attach(scripted)
  })
  await rig.acquire()
  await rig.adapter.dispatch({ sessionId: SESSION, clientMessageId: 'send-1', body: ask, fence: 1 })
  return { rig, replay }
}

async function accept(rig: AcpAdapterRig, replay: GrokFixtureReplay, title: string) {
  const approval = await waitFor(async () => {
    const found = (await rig.rig.rows()).find(
      (row) =>
        row.body.kind === 'approval' &&
        row.body.title === title &&
        row.body.resolution.state === 'pending'
    )
    if (!found || replay.awaiting !== 'reply') {
      throw new Error(`no pending ${title} approval yet`)
    }
    return found
  })
  await rig.adapter.answerPrompt({
    sessionId: SESSION,
    itemId: approval.itemId,
    kind: 'approval',
    response: { kind: 'option', optionId: 'accept' },
    fence: 1,
    commit: async () => {}
  })
}

async function completedTurns(rig: AcpAdapterRig) {
  await waitFor(async () =>
    expect(
      (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
    ).toMatchObject([{ state: 'completed', outcome: 'success' }])
  )
}

describe('Kiro V3 recordings through the adapter', () => {
  it('shows the written file as a path, not the file URI Kiro sends', async () => {
    const { rig, replay } = await replaying('kiro-v2-write-file')
    await accept(rig, replay, 'Write File')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await completedTurns(rig)
    const diff = (await rig.rig.rows()).find((row) => row.body.kind === 'diff')?.body
    if (diff?.kind !== 'diff') {
      throw new Error('Missing diff')
    }
    // Recorded on Windows; POSIX decodes the same drive-letter URI to this rooted path.
    expect(diff.path).toBe(
      process.platform === 'win32'
        ? 'c:\\work\\kiro-fixture\\probe.txt'
        : '/c:/work/kiro-fixture/probe.txt'
    )
  })

  it("asks for Kiro's end-of-turn review as an approval when Autopilot is off", async () => {
    const { rig, replay } = await replaying('kiro-v2-review-changes')
    await accept(rig, replay, 'Write File')
    await accept(rig, replay, 'Review changes')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await completedTurns(rig)
  })
})
