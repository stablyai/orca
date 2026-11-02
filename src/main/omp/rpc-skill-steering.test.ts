import { afterEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../../shared/agent-session/view/structured-agent-session-projection'
import { nativeChatTurnMembership } from '../../shared/native-chat/transcript/native-chat-turn-membership'
import { nativeChatRowsInDrawOrder } from '../../shared/native-chat/transcript/native-chat-turn-grouping'
import { closeOmpRpcAdapterFixtures, setupOmpRpcAdapter } from './rpc-session-adapter.test-fixture'

afterEach(closeOmpRpcAdapterFixtures)

async function setup() {
  const h = await setupOmpRpcAdapter()
  const dispatch = async (id: string, text: string) => {
    const running = (await h.rig.rows()).find(
      (row) => row.body.kind === 'turn' && row.body.state === 'running'
    )
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }]
    }
    await h.rig.journal.appendItem({ provider: 'orca', clientMessageId: id }, body, {
      fence: 1,
      turnScope: running ? { kind: 'turn', turnItemId: running.itemId } : { kind: 'thread' }
    })
    await h.adapter.dispatch({
      sessionId: 'omp-test',
      fence: 1,
      clientMessageId: id,
      body
    })
  }
  const echo = (role: string, extra: Record<string, unknown> = {}) => {
    const message = { role, content: 'native prompt', timestamp: 100, ...extra }
    h.connection.receive({ type: 'message_start', message })
    h.connection.receive({ type: 'message_end', message })
  }
  const reply = (text: string) => {
    h.connection.receive({ type: 'message_start', message: { role: 'assistant', content: [] } })
    h.connection.receive({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' }
    })
  }
  const finish = async (count: number) => {
    h.connection.receive({ type: 'agent_settled' })
    await vi.waitFor(async () =>
      expect((await h.rig.turns()).filter((turn) => turn.state === 'completed')).toHaveLength(count)
    )
  }
  return { ...h, dispatch, echo, reply, finish }
}

it.each(['skill-prompt', 'collab-prompt'])(
  'keeps a steered %s before its answer without making it the next run opener',
  async (customType) => {
    const h = await setup()
    await h.dispatch('first', 'start')
    h.connection.receive({ type: 'agent_start' })
    h.echo('user')
    h.reply('first answer')

    await h.dispatch('spec', '/skill:to-spec')
    h.echo('custom', { customType, attribution: 'agent' })
    h.echo('custom', { customType: 'background-notification', attribution: 'user' })
    expect(h.adapter.holdsDispatch('omp-test')).toBe(true)
    h.echo('custom', { customType, attribution: 'user' })
    h.reply('spec answer')
    await h.finish(1)

    await h.dispatch('tickets', '/skill:to-tickets')
    h.connection.receive({ type: 'agent_start' })
    h.echo('custom', { customType: 'skill-prompt', attribution: 'user' })
    h.reply('tickets answer')
    await h.finish(2)

    const items = await h.rig.rows()
    const messages = projectStructuredItemsToNativeChat(items)
    const { drawOrder } = nativeChatTurnMembership(messages, { items, submissions: [] })
    expect(
      nativeChatRowsInDrawOrder(messages, drawOrder).flatMap((message) =>
        message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      )
    ).toEqual([
      'start',
      'first answer',
      '/skill:to-spec',
      'spec answer',
      '/skill:to-tickets',
      'tickets answer'
    ])
    expect((await h.rig.turns()).map((turn) => turn.userItemId)).toEqual([
      agentJournalSubmissionKey('first'),
      agentJournalSubmissionKey('tickets')
    ])
    expect(h.adapter.holdsDispatch('omp-test')).toBe(false)
    expect(h.connection.closed).toBe(false)
  }
)

it('does not consume a steer at the custom opener echo of an idle extension run', async () => {
  const h = await setup()
  h.connection.receive({ type: 'agent_start' })
  await h.dispatch('spec', '/skill:to-spec')
  h.echo('custom', { customType: 'skill-prompt', attribution: 'user' })
  expect(h.adapter.holdsDispatch('omp-test')).toBe(true)
  h.echo('custom', { customType: 'skill-prompt', attribution: 'user' })
  expect(h.adapter.holdsDispatch('omp-test')).toBe(false)
  h.reply('spec answer')
  await h.finish(1)
  expect(h.connection.closed).toBe(false)
})

it('acknowledges a Skill opener once and waits for the next custom input echo', async () => {
  const h = await setup()
  await h.dispatch('spec', '/skill:to-spec')
  h.connection.receive({ type: 'agent_start' })
  await h.dispatch('tickets', '/skill:to-tickets')
  h.echo('custom', { customType: 'skill-prompt', attribution: 'user' })
  expect(h.adapter.holdsDispatch('omp-test')).toBe(true)
  h.echo('custom', { customType: 'skill-prompt', attribution: 'user' })
  expect(h.adapter.holdsDispatch('omp-test')).toBe(false)
  h.reply('tickets answer')
  await h.finish(1)
  expect((await h.rig.turns()).map((turn) => turn.userItemId)).toEqual([
    agentJournalSubmissionKey('spec')
  ])
})
