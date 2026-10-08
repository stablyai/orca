// The adapter against OMP's recorded `omp acp` traffic (17.0.5): each recording plays back as the
// agent, and the assertions read the journal a client would see.

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from './acp-launch-specs'
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

async function replaying(name: string) {
  const replay = new GrokFixtureReplay(await readAcpFixture(name))
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('omp')!,
    script: (scripted) => replay.attach(scripted)
  })
  await rig.acquire()
  await rig.adapter.dispatch({ sessionId: SESSION, clientMessageId: 'send-1', body: ask, fence: 1 })
  return { rig, replay }
}

async function turns(rig: AcpAdapterRig) {
  return (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
}

async function toolRow(rig: AcpAdapterRig) {
  const rows = (await rig.rig.rows()).filter((row) => row.body.kind === 'tool-call')
  expect(rows).toHaveLength(1)
  return rows[0]!.body
}

async function allowOnce(rig: AcpAdapterRig, replay: GrokFixtureReplay) {
  const approval = await waitFor(async () => {
    const found = (await rig.rig.rows()).find((row) => row.body.kind === 'approval')
    if (!found || replay.awaiting !== 'reply') {
      throw new Error('no pending approval yet')
    }
    return found
  })
  await rig.adapter.answerPrompt({
    sessionId: SESSION,
    itemId: approval.itemId,
    kind: 'approval',
    response: { kind: 'option', optionId: 'allow_once' },
    fence: 1,
    commit: async () => {}
  })
}

describe('OMP recordings through the adapter', () => {
  it("a failed command's row shows its output and exit code, not the command again", async () => {
    const { rig, replay } = await replaying('omp-v17-shell-exit-3')
    await allowOnce(rig, replay)
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'completed', outcome: 'success' }])
    )
    expect(await toolRow(rig)).toMatchObject({
      state: 'failed',
      input: { command: 'printf hi; exit 3' },
      exitCode: 3,
      output: { head: 'hi', truncated: false }
    })
  })

  it("a successful command's row shows its output", async () => {
    const { rig, replay } = await replaying('omp-v17-shell-ok')
    await allowOnce(rig, replay)
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'completed', outcome: 'success' }])
    )
    const tool = await toolRow(rig)
    expect(tool).toMatchObject({ state: 'completed', output: { head: 'ok', truncated: false } })
    // OMP reports an exit code only when it is not zero.
    expect(tool).not.toHaveProperty('exitCode')
  })

  it('Stop during a running command ends the turn and leaves the row without the command as output', async () => {
    const { rig, replay } = await replaying('omp-v17-stop-mid-tool')
    await allowOnce(rig, replay)
    await waitFor(() => expect(replay.awaiting).toBe('session/cancel'))
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'interrupted', outcome: 'cancellation' }])
    )
    // OMP sends nothing more for the stopped command; Orca settles its row with the turn.
    const tool = await toolRow(rig)
    expect(tool).toMatchObject({
      endedAs: 'interrupted',
      input: { command: 'sleep 30', timeout: 60 }
    })
    expect(tool).not.toHaveProperty('output')
  })
})
