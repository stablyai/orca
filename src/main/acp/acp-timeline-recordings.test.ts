import { afterEach, describe, expect, it } from 'vitest'
import { contextTokensFromUsage } from '../../shared/agent-session-context-usage'
import {
  closeProviderTimelineRigs,
  messageText
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpFixtureRig, readAcpFixture } from './acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

describe('recorded ACP traffic through the journal', () => {
  it('assembles basic chunks and partial tool calls with stable identities and usage', async () => {
    const fixture = await openAcpFixtureRig()
    const rows = await fixture.feed(await readAcpFixture('s1-basic'))
    const tools = rows.filter((row) => row.body.kind === 'tool-call')
    expect(tools).toHaveLength(2)
    expect(tools.map((row) => row.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'list_dir',
          callId: 'call-1',
          state: 'completed',
          output: expect.objectContaining({ truncated: false })
        }),
        expect.objectContaining({ name: 'read_file', callId: 'call-2', state: 'completed' })
      ])
    )
    expect(rows.filter((row) => row.body.kind === 'message')).toHaveLength(1)
    expect((await fixture.rig.turns())[0]).toMatchObject({
      state: 'completed',
      outcome: 'success',
      durationMs: 5289,
      contextUsage: { used: { kind: 'estimate' } }
    })
    expect(tools.every((tool) => tool.turnScope?.kind === 'turn')).toBe(true)
  })

  it('shows permission options verbatim and keeps allow and reject answers after turn settlement', async () => {
    const fixture = await openAcpFixtureRig()
    const rows = await fixture.feed(await readAcpFixture('s2-permission'))
    const approvals = rows.flatMap((row) => (row.body.kind === 'approval' ? [row.body] : []))
    expect(approvals).toHaveLength(2)
    expect(approvals[0]!.options.map((option) => option.id)).toEqual([
      'allow-edits-session',
      'allow-once',
      'reject-once'
    ])
    expect(approvals.map((body) => body.resolution)).toMatchObject([
      { state: 'resolved', selectedOptionId: 'allow-once' },
      { state: 'resolved', selectedOptionId: 'reject-once' }
    ])
    expect((await fixture.rig.turns()).map((turn) => turn.outcome)).toEqual([
      'success',
      'cancellation'
    ])
    expect(rows.flatMap((row) => (row.body.kind === 'tool-call' ? [row.body.state] : []))).toEqual([
      'completed',
      'failed'
    ])
  })

  it('settles the abandoned in_progress tool on cancel and accepts the next prompt', async () => {
    const fixture = await openAcpFixtureRig()
    const rows = await fixture.feed(await readAcpFixture('s3-cancel'))
    expect(rows.flatMap((row) => (row.body.kind === 'tool-call' ? [row.body.state] : []))).toEqual([
      'failed'
    ])
    expect((await fixture.rig.turns()).map((turn) => [turn.state, turn.outcome])).toEqual([
      ['interrupted', 'cancellation'],
      ['completed', 'success']
    ])
    expect(rows.some((row) => messageText(row.body)?.includes('ok'))).toBe(true)
  })

  it('drops load history, except its context usage', async () => {
    const fixture = await openAcpFixtureRig()
    const frames = await readAcpFixture('s4-resume')
    await fixture.feed(frames.filter((frame) => frame.process === 'A'))
    const before = await fixture.rig.rows()
    await fixture.restart()
    const loading = frames.filter((frame) => frame.process === 'B')
    const nextPrompt = loading.findIndex((frame) => frame.message.method === 'session/prompt')
    await fixture.feed(loading.slice(0, nextPrompt))
    fixture.apply(
      fixture.lane().notification(
        'session/update',
        {
          sessionId: 'session-1',
          _meta: { isReplay: true },
          update: { sessionUpdate: 'usage_update', used: 5000, size: 256000 }
        },
        1900
      )
    )
    fixture.finishLoad()
    const after = await fixture.rig.rows()
    const items = (rows: typeof before) => rows.filter((row) => row.body.kind !== 'turn')
    expect(items(after)).toEqual(items(before))
    const [turn] = await fixture.rig.turns()
    expect(turn?.contextUsage?.window?.tokens).toBe(256000)
    expect(
      turn?.contextUsage?.used?.kind === 'estimate' &&
        contextTokensFromUsage(turn.contextUsage.used.usage)
    ).toBe(5000)
    await fixture.feed(loading.slice(nextPrompt))
    expect(await fixture.rig.turns()).toHaveLength(2)
  })

  it('answers questions and plan approval with the recorded exact reply shapes', async () => {
    const fixture = await openAcpFixtureRig()
    const rows = await fixture.feed(await readAcpFixture('s5-plan-approved'))
    expect(rows.flatMap((row) => (row.body.kind === 'question' ? [row.body] : []))).toMatchObject([
      { resolution: { state: 'resolved', answers: [{ questionId: 'q1', optionIds: ['o1'] }] } }
    ])
    expect(rows.flatMap((row) => (row.body.kind === 'approval' ? [row.body] : []))).toMatchObject([
      {
        subject: { kind: 'plan', text: '# Plan\n\nUpdate the example and run its tests.' },
        resolution: { state: 'resolved', selectedOptionId: 'approved' }
      }
    ])
    expect((await fixture.rig.turns())[0]!.outcome).toBe('success')
  })

  it('opens and ends the background completion turn without a client prompt', async () => {
    const fixture = await openAcpFixtureRig()
    const rows = await fixture.feed(await readAcpFixture('s6-background'))
    expect((await fixture.rig.turns()).map((turn) => [turn.state, turn.outcome])).toEqual([
      ['completed', 'success'],
      ['completed', 'success']
    ])
    const messages = rows.filter(
      (row) => row.body.kind === 'message' && row.body.role === 'assistant'
    )
    expect(messages).toHaveLength(2)
    expect(messageText(messages[1]!.body)).toBe('The background')
    expect(messages[0]!.turnScope).not.toEqual(messages[1]!.turnScope)
    expect(rows.flatMap((row) => (row.body.kind === 'tool-call' ? [row.body.state] : []))).toEqual([
      'completed'
    ])
  })
})
