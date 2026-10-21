import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { RpcClient } from '../transport/rpc-client'
import { foldMobileNativeChatMessages } from './mobile-native-chat-render-data'
import { useMobileNativeChatMessageDetail } from './use-mobile-native-chat-message-detail'

const reads = vi.hoisted(() => vi.fn())
vi.mock('./mobile-native-chat-item-read', () => ({ readMobileNativeChatItem: reads }))
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RPC is mocked; only this client's object identity is used.
const source = { client: {} as RpcClient, sessionId: 'session' }
let latest: ReturnType<typeof useMobileNativeChatMessageDetail> | undefined
let renderer: ReactTestRenderer | undefined
function Probe({ messages }: { messages: NativeChatMessage[] }) {
  latest = useMobileNativeChatMessageDetail(messages, source)
  return null
}
afterEach(() => {
  act(() => renderer?.unmount())
  reads.mockReset()
})

it('prepares full raw user rows with their neighboring images and fences late same-head detail', async () => {
  const row = (id: string, text: string): NativeChatMessage => ({
    id,
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'text', text }]
  })
  const image = row('image', '[Image: source: /repo/p.png]')
  const prompt: NativeChatMessage = { ...row('prompt', '[Image #1] head…'), shortened: true }
  const skill: NativeChatMessage = {
    ...row(
      'skill',
      '<command-name>/plugin:example</command-name><command-args>head…</command-args>'
    ),
    shortened: true
  }
  const messages = [image, prompt, skill]
  const item = (id: string, text: string, shortened = false): AgentJournalRenderItem => ({
    itemId: id,
    sequence: 1,
    observedAt: 1,
    revision: 2,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    ...(shortened ? { shortened: true as const } : {})
  })
  await act(async () => {
    renderer = create(createElement(Probe, { messages }))
  })
  reads.mockResolvedValueOnce(item('prompt', '[Image #1] head TAIL'))
  await act(async () => {
    await latest?.detail?.load('prompt')
  })
  const folded = foldMobileNativeChatMessages(latest?.messages ?? [], 'claude')
  expect(folded[0]?.blocks).toEqual([
    { type: 'image-ref', path: '/repo/p.png' },
    { type: 'text', text: 'head TAIL' }
  ])
  reads.mockResolvedValueOnce(
    item(
      'skill',
      '<command-name>/plugin:example</command-name><command-args>full</command-args>',
      true
    )
  )
  await act(async () => {
    await latest?.detail?.load('skill')
  })
  expect(foldMobileNativeChatMessages(latest?.messages ?? [], 'claude')[1]?.blocks).toEqual([
    { type: 'text', text: '/example full' }
  ])
  expect(latest?.detail?.state('skill')).toBe('partial')
  const pending = Promise.withResolvers<AgentJournalRenderItem>()
  reads.mockReturnValueOnce(pending.promise)
  const stale = latest?.detail?.load('prompt')
  const newer = { ...prompt }
  await act(async () => renderer?.update(createElement(Probe, { messages: [image, newer, skill] })))
  await act(async () => {
    pending.resolve(item('prompt', 'STALE'))
    await stale
  })
  expect(latest?.messages[1]).toBe(newer)
  reads.mockResolvedValueOnce(null)
  await expect(latest?.detail?.load('prompt')).rejects.toThrow('Message unavailable')
  expect(latest?.detail?.state('prompt')).toBe('available')
})
