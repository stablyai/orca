import { afterEach, expect, it } from 'vitest'
import { setupOmpRpcAdapter, closeOmpRpcAdapterFixtures } from './rpc-session-adapter.test-fixture'

afterEach(closeOmpRpcAdapterFixtures)

const lifecycle = (id: string, status: string) => ({
  type: 'subagent_lifecycle',
  payload: { id, agent: 'task', status, parentToolCallId: 'parent' }
})

it('keeps child streaming, reasoning, tools and images separate from root and sibling lifecycles', async () => {
  const h = await setupOmpRpcAdapter()
  const child = (id: string, event: Record<string, unknown>) =>
    h.connection.receive({ type: 'subagent_event', payload: { id, event } })
  h.connection.receive({ type: 'agent_start' })
  for (const id of ['one', 'two']) {
    h.connection.receive(lifecycle(id, 'started'))
    child(id, { type: 'message_start', message: { role: 'assistant', content: [] } })
    child(id, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: `${id} reasoning` }
    })
    child(id, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: `${id} answer` }
    })
    child(id, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: `${id} reasoning` },
          { type: 'text', text: `${id} answer` }
        ]
      }
    })
    child(id, {
      type: 'tool_execution_start',
      toolCallId: 'same-id',
      toolName: 'read',
      args: { path: `${id}.png` }
    })
  }
  child('one', {
    type: 'tool_execution_end',
    toolCallId: 'same-id',
    toolName: 'read',
    result: {
      content: [
        { type: 'text', text: 'Screenshot' },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }
      ]
    }
  })
  child('one', { type: 'agent_end' })
  h.connection.receive(lifecycle('one', 'completed'))
  h.connection.receive({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Root still working' }] }
  })
  const rows = await h.rig.rows()
  const one = rows.filter((row) => row.agentId === 'one')
  expect(one.some((row) => row.body.kind === 'message' && row.body.role === 'reasoning')).toBe(true)
  expect(
    one.some(
      (row) =>
        row.body.kind === 'message' && row.body.blocks.some((block) => block.type === 'image-ref')
    )
  ).toBe(true)
  expect(one.find((row) => row.body.kind === 'tool-call')?.body).toMatchObject({
    state: 'completed',
    output: { head: 'Screenshot' }
  })
  expect(
    rows.find((row) => row.agentId === 'two' && row.body.kind === 'tool-call')?.body
  ).toMatchObject({ state: 'running', input: { path: 'two.png' } })
  expect(
    rows.some(
      (row) =>
        !row.agentId &&
        row.body.kind === 'message' &&
        JSON.stringify(row.body.blocks).includes('Root still working')
    )
  ).toBe(true)
  expect(rows.filter((row) => row.agentId).every((row) => row.providerParentRef === 'parent')).toBe(
    true
  )
  h.connection.receive(lifecycle('two', 'aborted'))
  const afterStop = await h.rig.rows()
  expect(
    afterStop.find((row) => row.agentId === 'two' && row.body.kind === 'tool-call')?.body
  ).toMatchObject({ state: 'failed' })
  child('two', {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Late abandoned output' }] }
  })
  expect(JSON.stringify(await h.rig.rows())).not.toContain('Late abandoned output')
})

it('separates repeated child runs with the same native ID and ignores events from unknown children', async () => {
  const h = await setupOmpRpcAdapter()
  const reply = (text: string) =>
    h.connection.receive({
      type: 'subagent_event',
      payload: {
        id: 'child',
        event: {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text }] }
        }
      }
    })
  reply('Unowned')
  for (const text of ['First run', 'Second run']) {
    h.connection.receive(lifecycle('child', 'started'))
    reply(text)
    h.connection.receive(lifecycle('child', 'completed'))
  }
  const rows = await h.rig.rows()
  const messages = rows.filter((row) => row.agentId === 'child' && row.body.kind === 'message')
  expect(messages).toHaveLength(2)
  expect(new Set(messages.map((row) => row.itemId)).size).toBe(2)
  expect(JSON.stringify(rows)).not.toContain('Unowned')
})
