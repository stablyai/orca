// One phone chat view serves every chat tab, so returning to a chat must not wait on its next read.

import { act } from 'react-test-renderer'
import { expect, it } from 'vitest'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session/options/agent-session-options-result'
import {
  BASE,
  OPTIONS,
  accepted,
  currentValueOf,
  deferred,
  mountOptions,
  optionsClient,
  recordingMutate,
  settle
} from './use-mobile-structured-agent-options.test-fixture'

const COMMAND = 'compact'
const CHAT_A: AgentSessionOptionsResult = {
  ...OPTIONS,
  acceptsImages: true,
  conversationCommands: [COMMAND],
  current: {
    model: 'gpt-fast',
    effort: 'low',
    permissionMode: 'own',
    reportedPermissionMode: 'ask',
    acceptedInputSources: { model: 'saved', effort: 'saved' }
  }
}
const CHAT_B: AgentSessionOptionsResult = {
  ...OPTIONS,
  acceptsImages: false,
  current: { model: 'gpt-live', effort: 'high', permissionMode: 'ask' }
}

/** Host replies per chat; later reads for chat A wait until the test answers them. */
function chats() {
  const later: ReturnType<typeof deferred<AgentSessionOptionsResult>>[] = []
  let readsOfA = 0
  let readingB = false
  const client = optionsClient(() => {
    if (readingB) {
      return Promise.resolve(CHAT_B)
    }
    if (readsOfA++ === 0) {
      return Promise.resolve(CHAT_A)
    }
    const reply = deferred<AgentSessionOptionsResult>()
    later.push(reply)
    return reply.promise
  })
  const send = client.client.sendRequest
  client.client.sendRequest = (method, params, options) => {
    if (method === 'agentSession.options') {
      readingB = JSON.stringify(params).includes('chat-b')
    }
    return send(method, params, options)
  }
  return { client, later }
}

it("shows a chat's last answer on return, without its reports, until its new read lands", async () => {
  const { client, later } = chats()
  const { mutate } = recordingMutate(async () => accepted({ key: 'model', value: 'x' }, true))
  const harness = await mountOptions({
    ...BASE,
    sessionId: 'chat-a',
    fence: 1,
    client: client.client,
    mutate,
    permissionOwn: true,
    sendSelection: true
  })
  await harness.rerender({ sessionId: 'chat-b', fence: 7 })
  expect(currentValueOf(harness.current().optionSnapshot, 'model')).toBe('gpt-live')
  const commitsOnB = harness.commits.length
  await harness.rerender({ sessionId: 'chat-a', fence: 2 })
  expect(later).toHaveLength(1)
  // From the first commit on return, not only after a later effect catches up.
  for (const commit of harness.commits.slice(commitsOnB)) {
    expect(currentValueOf(commit.optionSnapshot, 'model')).toBe('gpt-fast')
  }
  const shown = harness.current()
  expect(currentValueOf(shown.optionSnapshot, 'model')).toBe('gpt-fast')
  expect(currentValueOf(shown.optionSnapshot, 'effort')).toBe('low')
  expect(shown.conversationCommands).toEqual([COMMAND])
  expect(shown.acceptsImages).toBe(true)
  // The process restarted and another device may have moved the chat while it was away.
  expect(currentValueOf(shown.optionSnapshot, 'permissionMode')).toBeUndefined()
  expect(shown.sendSelection()).toEqual({ selection: {} })

  await act(async () => {
    later[0].resolve({
      ...CHAT_A,
      conversationCommands: [],
      current: { ...CHAT_A.current, model: 'gpt-live' }
    })
  })
  await settle()
  const answered = harness.current()
  expect(currentValueOf(answered.optionSnapshot, 'model')).toBe('gpt-live')
  expect(currentValueOf(answered.optionSnapshot, 'permissionMode')).toBe('ask')
  expect(answered.conversationCommands).toEqual([])
  expect(answered.sendSelection()).toEqual({ selection: { model: 'gpt-live', effort: 'low' } })
  await harness.unmount()
})
