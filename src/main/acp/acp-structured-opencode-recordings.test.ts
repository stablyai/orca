// The adapter against OpenCode's recorded `opencode acp` traffic (1.18.31, and 2.0.29 for the
// `opencode-v2-*` ones): each recording plays back as the agent, and the assertions read the
// journal a client would see.

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
  it('an approved shell command lands with its exit code, and "always" keeps OpenCode\'s own name', async () => {
    const { rig, replay } = await replaying('opencode-v1-tool')
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
    const shell = (await rowsOf(rig, 'tool-call')).find(
      (row) => row.body.kind === 'tool-call' && row.body.exitCode !== undefined
    )
    expect(shell?.body).toMatchObject({ state: 'completed', exitCode: 0 })
  })

  it('a rejected permission fails its tool and the turn still ends', async () => {
    const { rig, replay } = await replaying('opencode-v1-deny')
    await answer(rig, replay, 'reject')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () => expect(await turns(rig)).toMatchObject([{ state: 'completed' }]))
    expect((await rowsOf(rig, 'tool-call')).at(-1)?.body).toMatchObject({ state: 'failed' })
  })

  it("a subagent's approval never arrives (a known OpenCode bug); Stop still ends the turn", async () => {
    const { rig, replay } = await replaying('opencode-v1-subagent-hang')
    await waitFor(() => expect(replay.awaiting).toBe('session/cancel'))
    expect(await rowsOf(rig, 'approval')).toEqual([])
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'interrupted', outcome: 'cancellation' }])
    )
  })

  it("OpenCode's stray file write after an approved edit is refused without breaking the turn", async () => {
    const { rig, replay } = await replaying('opencode-v1-stray-write')
    await answer(rig, replay, 'once', 0)
    await answer(rig, replay, 'reject', 1)
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () => expect(await turns(rig)).toMatchObject([{ state: 'completed' }]))
    // The write OpenCode repeats to a client that took no file system leaves no row.
    expect(JSON.stringify((await rig.rig.rows()).map((row) => row.body))).not.toContain(
      'fs/write_text_file'
    )
  })

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
      exitCode: 0
    })
  })

  // Unlike 1.x, 2.x ends the turn when a permission is rejected: it answers `cancelled`.
  it('a rejected permission fails its tool and OpenCode ends the turn as cancelled', async () => {
    const { rig, replay } = await replaying('opencode-v2-deny', 'opencode2')
    await answer(rig, replay, 'reject')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'interrupted', outcome: 'cancellation' }])
    )
    expect((await rowsOf(rig, 'tool-call')).at(-1)?.body).toMatchObject({ state: 'failed' })
  })

  it('Stop during an approved command cancels it and ends the turn', async () => {
    const { rig, replay } = await replaying('opencode-v2-stop', 'opencode2')
    await answer(rig, replay, 'once')
    await waitFor(() => expect(replay.awaiting).toBe('session/cancel'))
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'interrupted', outcome: 'cancellation' }])
    )
    expect((await rowsOf(rig, 'tool-call')).at(-1)?.body).toMatchObject({ state: 'failed' })
  })
})
