import { afterEach, describe, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import {
  openAcpFixtureRig,
  readAcpFixture,
  type AcpFixtureFrame
} from './testing/acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

function child(event: Record<string, unknown>): AcpFixtureFrame {
  return {
    direction: 'in',
    process: 'p1',
    message: {
      method: 'opencode/session/child_update',
      params: {
        rootSessionId: 'session-1',
        childSessionId: 'session-2',
        parentSessionId: 'session-1',
        depth: 1,
        title: 'Child task',
        ...event
      }
    }
  }
}

const status = (state: string, error?: unknown) =>
  child({ type: 'status', status: state, ...(error === undefined ? {} : { error }) })
const text = (messageId: string, value: string, thought = false) =>
  child({
    type: 'update',
    update: {
      sessionUpdate: thought ? 'agent_thought_chunk' : 'agent_message_chunk',
      messageId,
      content: { type: 'text', text: value }
    }
  })
const tool = child({
  type: 'update',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 'session-2:read-file',
    title: 'read',
    name: 'read',
    status: 'completed',
    rawInput: { path: '/workspace/example.txt' },
    content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }]
  }
})

async function savedReplies(fixture: Awaited<ReturnType<typeof openAcpFixtureRig>>) {
  return (await fixture.savedSubagents()).map((entry) => [
    entry.id,
    entry.state,
    entry.lastMessage ?? null
  ])
}

describe('OpenCode child session results', () => {
  it.each(['opencode-v2-subagent-foreground', 'opencode-v2-subagent-background'])(
    'retains the recorded final reply without duplicating child text: %s',
    async (name) => {
      const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT)
      const rows = await fixture.feed(await readAcpFixture(name))

      expect(fixture.subagents()).toMatchObject([
        { providerId: 'session-2', outcome: 'succeeded', lastMessage: 'DONE' }
      ])
      expect(
        rows.flatMap((row) =>
          row.agentId === 'session-2' && row.body.kind === 'message'
            ? row.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
            : []
        )
      ).toEqual(['DONE'])
    }
  )

  it('publishes only the completed current message as the reply preview', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT)
    await fixture.feed([
      status('created'),
      status('running'),
      text('msg_comment', 'Starting the task'),
      tool,
      text('msg_final', 'Fi'),
      text('msg_final', 'nal\n'),
      text('msg_final:reasoning:0', 'Checking the answer', true),
      text('msg_final', 'answer')
    ])
    expect(fixture.subagents().map((entry) => entry.lastMessage ?? null)).toEqual([null])

    await fixture.feed([status('completed')])
    expect(fixture.subagents()).toMatchObject([
      { outcome: 'succeeded', lastMessage: 'Final answer' }
    ])
  })

  it('does not turn earlier commentary into a reply after later tool work or a textless step', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT)
    await fixture.feed([
      status('created'),
      status('running'),
      text('msg_comment', 'I will inspect the file'),
      tool,
      status('completed')
    ])
    expect(fixture.subagents().map((entry) => [entry.outcome, entry.lastMessage ?? null])).toEqual([
      ['succeeded', null]
    ])

    await fixture.feed([
      status('running'),
      text('msg_other', 'An intermediate answer'),
      text('msg_textless:reasoning:0', 'Another step without a reply', true),
      status('completed')
    ])
    expect(fixture.subagents().map((entry) => [entry.outcome, entry.lastMessage ?? null])).toEqual([
      ['succeeded', null]
    ])
  })

  it('retains a child execution error without failing the root or publishing a reply', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT)
    fixture.apply(fixture.lane().openPrompt('root-request', 1).events)
    await fixture.feed([
      status('created'),
      status('running'),
      text('msg_partial', 'Working on it'),
      status('failed', {
        type: 'provider.rate-limit',
        message: 'Rate limit reached;\ntry again in one minute.',
        status: 429,
        retryAfterMs: 60_000
      })
    ])
    fixture.apply(fixture.lane().promptResult('root-request', { stopReason: 'end_turn' }, 2_000))

    expect(fixture.subagents()).toMatchObject([
      {
        outcome: 'failed',
        lastMessage: 'Rate limit reached; try again in one minute.'
      }
    ])
    expect((await fixture.rig.turns()).map((turn) => turn.outcome)).toEqual(['success'])
    expect(
      (await fixture.rig.rows()).flatMap((row) =>
        row.agentId === 'session-2' && row.body.kind === 'message'
          ? row.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          : []
      )
    ).toEqual(['Working on it'])
  })

  it('does not use partial text or malformed diagnostic data as a child failure reason', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT)
    await fixture.feed([
      status('created'),
      status('running'),
      text('msg_partial', 'This is not an error'),
      status('failed', { type: 'tool.error', message: { unexpected: true } })
    ])
    expect(fixture.subagents().map((entry) => [entry.outcome, entry.lastMessage ?? null])).toEqual([
      ['failed', null]
    ])
  })

  it('keeps the newest recorded run separate from a later silent or stopped run', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT)
    await fixture.feed(await readAcpFixture('opencode-v2-subagent-rerun'))
    expect(fixture.subagents()).toMatchObject([{ outcome: 'succeeded', lastMessage: 'SECOND' }])

    await fixture.feed([status('running'), status('completed')])
    expect(fixture.subagents().map((entry) => [entry.outcome, entry.lastMessage ?? null])).toEqual([
      ['succeeded', null]
    ])

    await fixture.feed([
      status('running'),
      text('msg_stopped', 'An unfinished response'),
      status('interrupted')
    ])
    expect(fixture.subagents().map((entry) => [entry.outcome, entry.lastMessage ?? null])).toEqual([
      ['cancelled', null]
    ])
  })

  it('ignores replay and foreign-root frames when choosing the current reply', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT)
    await fixture.feed([status('created'), status('running'), text('msg_final', 'Current reply')])
    await fixture.feed([
      child({
        type: 'update',
        _meta: { isReplay: true },
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg_old',
          content: { type: 'text', text: 'Old reply' }
        }
      }),
      child({ type: 'status', status: 'failed', rootSessionId: 'other-root' })
    ])
    fixture.lane().beginLoad()
    await fixture.feed([text('msg_loaded', 'Loaded reply'), status('completed')])
    fixture.finishLoad()
    await fixture.feed([status('completed')])

    expect(fixture.subagents()).toMatchObject([
      { outcome: 'succeeded', lastMessage: 'Current reply' }
    ])
  })

  it('does not restore a saved reply for a silent execution after reacquisition', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT)
    await fixture.feed([
      status('created'),
      status('running'),
      text('msg_first', 'FIRST'),
      status('completed')
    ])
    expect(await savedReplies(fixture)).toEqual([['session-2', 'completed', 'FIRST']])

    await fixture.restart()
    await fixture.feed([status('running'), status('completed')])
    expect(await savedReplies(fixture)).toEqual([['session-2', 'completed', null]])
    await fixture.feed([status('failed', { type: 'tool.error', message: 'Late failure' })])
    expect(await savedReplies(fixture)).toEqual([['session-2', 'completed', null]])

    await fixture.feed([status('running'), text('msg_next', 'NEXT'), status('completed')])
    expect(await savedReplies(fixture)).toEqual([['session-2', 'completed', 'NEXT']])
  })

  it("keeps a retired child's saved reply out of a newly acquired silent execution", async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT)
    await fixture.feed([
      status('created'),
      status('running'),
      text('msg_first', 'FIRST'),
      status('completed')
    ])
    expect(await savedReplies(fixture)).toEqual([['session-2', 'completed', 'FIRST']])
    fixture.apply(fixture.lane().openPrompt('retire', 2_000).events)
    fixture.apply(fixture.lane().promptResult('retire', { stopReason: 'end_turn' }, 2_001))

    await fixture.restart()
    await fixture.feed([status('running'), status('completed')])
    expect(await savedReplies(fixture)).toEqual([['session-2', 'completed', null]])
    await fixture.feed([status('running'), text('msg_next', 'NEXT'), status('completed')])
    expect(await savedReplies(fixture)).toEqual([['session-2', 'completed', 'NEXT']])
  })

  it('keeps a captured Stop valid across repeated starts and reacquired live observations', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT)
    await fixture.feed([status('created'), status('running')])
    const captured = fixture.subagents()[0]!
    expect(await savedReplies(fixture)).toEqual([['session-2', 'working', null]])
    await fixture.feed([status('running')])

    await fixture.restart()
    await fixture.feed([text('msg_continuing', 'Still working')])
    fixture.reportChildWork([
      {
        type: 'stop-acknowledged',
        observedAt: 2_000,
        childWorkId: captured.id,
        handleId: 'session-2',
        invocation: captured.invocation
      }
    ])
    expect(await savedReplies(fixture)).toEqual([['session-2', 'stopped', null]])
  })
})
