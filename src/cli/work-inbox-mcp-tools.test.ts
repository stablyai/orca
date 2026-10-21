import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createWorkInboxMcpServer } from './work-inbox-mcp-tools'
import type { WorkInboxAskResult } from '../shared/work-inbox'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close()
  }
})

async function connect(outcome: WorkInboxAskResult) {
  const ask = vi.fn(async () => outcome)
  const acknowledge = vi.fn(async (id: string) => ({ id, status: 'delivered' }))
  const server = createWorkInboxMcpServer(ask, acknowledge)
  const client = new Client({ name: 'inbox-test', version: '1' })
  const [caller, host] = InMemoryTransport.createLinkedPair()
  await server.connect(host)
  await client.connect(caller)
  cleanup.push(async () => {
    await client.close()
    await server.close()
  })
  return { client, ask, acknowledge }
}

it('sends immutable request IDs and reports closure without an answer or acknowledgement', async () => {
  const { client, ask, acknowledge } = await connect({
    id: 'wib_closed',
    status: 'cancelled',
    answer: null,
    cancelled: true,
    timedOut: false,
    timeoutMs: 1000
  })
  const result = await client.callTool({
    name: 'ask_user',
    arguments: {
      request_id: 'ce973820-f915-4f28-9764-13226def1a9c',
      question: 'Deploy?',
      options: ['Approve (recommended)', 'Reject'],
      timeout_ms: 1000
    }
  })
  expect(ask).toHaveBeenCalledWith({
    requestId: 'ce973820-f915-4f28-9764-13226def1a9c',
    question: 'Deploy?',
    options: 'Approve (recommended),Reject',
    timeoutMs: 1000
  })
  expect(result.structuredContent).toMatchObject({
    id: 'wib_closed',
    answer: null,
    cancelled: true,
    nextAction: expect.stringContaining('not approval')
  })
  expect(acknowledge).not.toHaveBeenCalled()
})

it('resumes the same pending question and acknowledges only on an explicit tool call', async () => {
  const { client, ask, acknowledge } = await connect({
    id: 'wib_answered',
    status: 'answered',
    answer: { text: 'Wait for review' },
    cancelled: false,
    timedOut: false,
    timeoutMs: 1000
  })
  const result = await client.callTool({
    name: 'wait_for_answer',
    arguments: {
      question_id: 'wib_answered',
      timeout_ms: 1000
    }
  })
  expect(ask).toHaveBeenCalledWith({ resume: 'wib_answered', timeoutMs: 1000 })
  expect(result.structuredContent).toMatchObject({ answer: { text: 'Wait for review' } })
  expect(acknowledge).not.toHaveBeenCalled()
  await client.callTool({ name: 'acknowledge_answer', arguments: { question_id: 'wib_answered' } })
  expect(acknowledge).toHaveBeenCalledWith('wib_answered')
})

it('rejects ambiguous comma-containing options before asking', async () => {
  const { client, ask } = await connect({
    id: 'unused',
    status: 'open',
    answer: null,
    cancelled: false,
    timedOut: true,
    timeoutMs: 1000
  })
  const result = await client.callTool({
    name: 'ask_user',
    arguments: {
      request_id: 'ce973820-f915-4f28-9764-13226def1a9c',
      question: 'Choose?',
      options: ['one,two']
    }
  })
  expect(result.isError).toBe(true)
  expect(ask).not.toHaveBeenCalled()
})
