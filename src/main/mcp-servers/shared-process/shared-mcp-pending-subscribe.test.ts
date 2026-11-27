import { expect, it } from 'vitest'
import { ErrorCode, McpError, type Result } from '@modelcontextprotocol/sdk/types.js'
import { SharedMcpResourceSubscriptions } from './shared-mcp-resource-subscriptions'

it('keeps new subscribers waiting when an older subscription finishes late', async () => {
  const subscriptions = new SharedMcpResourceSubscriptions(() => true)
  const request = { method: 'resources/subscribe', params: { uri: 'file:///shared' } }
  let finishOld!: (result: Result) => void
  let failNew!: (error: Error) => void
  const old = subscriptions.forward(
    request,
    'old-session',
    () => new Promise((resolve) => (finishOld = resolve))
  )!
  subscriptions.release('old-session')
  const current = subscriptions.forward(
    request,
    'new-session',
    () => new Promise((_resolve, reject) => (failNew = reject))
  )!
  finishOld({})
  await old

  const joined = subscriptions.forward(request, 'joining-session', async () => ({}))!
  const results = Promise.allSettled([current, joined])
  failNew(new McpError(ErrorCode.InternalError, 'subscription refused'))
  expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected'])
  expect([...subscriptions.subscribers('file:///shared')]).toEqual([])
})
