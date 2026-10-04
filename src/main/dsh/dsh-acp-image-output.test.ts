import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { projectStructuredItemsToNativeChat } from '../../shared/structured-agent-session-projection'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionItemAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { DshStructuredSessionAdapter } from './dsh-structured-session-adapter'
import { DshAcpJournal } from './dsh-acp-journal'
import { DSH_ACP_PEER } from './dsh-acp-peer.test-fixture'

it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])(
  'keeps %s output ordered, durable and usable for another turn',
  async (mimeType) => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-image-output-'))
    const journals = createTrackedJournalOpener()
    const items: {
      identity: AgentJournalItemIdentity
      body: AgentJournalItemBody
      options: StructuredAgentSessionItemAppendOptions
    }[] = []
    const lifecycle = vi.fn()
    const peer = DSH_ACP_PEER.replace(
      "update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } })",
      "update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } })\n" +
        `update({ sessionUpdate: 'agent_message_chunk', content: ${JSON.stringify({ type: 'image', data: 'AQ==', mimeType })} })`
    )
    expect(peer).not.toBe(DSH_ACP_PEER)
    const identity = {
      sessionId: 'image-output',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'dsh-acp' as const,
      providerHandle: { kind: 'opaque' as const, agent: 'dsh-acp' as const, value: 'pending' }
    }
    const adapter = new DshStructuredSessionAdapter({
      resolveLaunch: async () => ({ command: process.execPath, args: ['-e', peer], cwd }),
      onLifecycleEvent: lifecycle,
      onDispatchSettledLate: () => undefined
    })
    try {
      await adapter.acquire({
        identity,
        fence: 1,
        spawnToken: 'image-output-token',
        events: {
          appendItem: (key, body, options) => items.push({ identity: key, body, options }),
          appendTombstone: () => undefined,
          publish: () => undefined
        }
      })
      for (let turn = 0; turn < 2; turn++) {
        await adapter.dispatch({
          sessionId: identity.sessionId,
          fence: 1,
          clientMessageId: `turn-${turn}`,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'show it' }]
          }
        })
        await vi.waitFor(() =>
          expect(items.filter((item) => item.body.kind === 'approval')).toHaveLength(turn + 1)
        )
        const prompt = items.filter((item) => item.body.kind === 'approval')[turn]
        await adapter.answerPrompt({
          sessionId: identity.sessionId,
          fence: 1,
          itemId: agentJournalItemKey(prompt.identity),
          kind: 'approval',
          response: { kind: 'option', optionId: 'reject-1' },
          commit: async () => undefined
        })
        await vi.waitFor(() =>
          expect(
            items.filter((item) => item.body.kind === 'turn' && item.body.state === 'completed')
          ).toHaveLength(turn + 1)
        )
      }
      expect(lifecycle).not.toHaveBeenCalled()
      const durable = await journals.open({ identity, stateDirectory: cwd })
      for (const item of items) {
        await durable.appendItem(item.identity, item.body, { ...item.options, fence: 1 })
      }
      const expected = [
        { type: 'text', text: 'Hello ' },
        { type: 'image-ref', url: `data:${mimeType};base64,AQ==`, alt: 'DeepSeek Harness image' },
        { type: 'text', text: 'fixture' },
        {
          type: 'tool-call',
          callId: 'fixture-tool',
          name: 'Fixture tool',
          input: { path: 'owned' },
          state: 'completed'
        },
        {
          type: 'tool-result',
          callId: 'fixture-tool',
          isError: false,
          output: JSON.stringify({
            permission: { outcome: { outcome: 'selected', optionId: 'reject-1' } }
          })
        }
      ]
      const assistantBlocks = () =>
        projectStructuredItemsToNativeChat(durable.snapshot().items)
          .filter((message) => message.role === 'assistant')
          .flatMap((message) => message.blocks)
      expect(assistantBlocks()).toEqual([...expected, ...expected])
      await journals.closeAll()
      const restored = await journals.open({ identity, stateDirectory: cwd })
      expect(
        projectStructuredItemsToNativeChat(restored.snapshot().items)
          .filter((message) => message.role === 'assistant')
          .flatMap((message) => message.blocks)
      ).toEqual([...expected, ...expected])
    } finally {
      await adapter.closeAll()
      await journals.closeAll()
      await rm(cwd, { recursive: true, force: true })
    }
  }
)

it('marks an oversized valid image in order without preventing following text', () => {
  const items: AgentJournalItemBody[] = []
  const journal = new DshAcpJournal(() => 'oversized-image', {
    appendItem: (_identity, body) => items.push(body),
    appendTombstone: () => undefined,
    publish: () => undefined
  })
  journal.begin('large-image')
  journal.update(
    {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'image',
        mimeType: 'image/png',
        data: Buffer.alloc(1024 * 1024).toString('base64')
      }
    },
    false
  )
  journal.update(
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } },
    false
  )
  expect(items.at(-2)).toMatchObject({
    blocks: [{ type: 'text', text: expect.stringContaining('cannot be displayed') }]
  })
  expect(items.at(-1)).toMatchObject({ blocks: [{ type: 'text', text: 'after' }] })
})

it.each([
  { type: 'image', mimeType: 'image/svg+xml', data: 'AQ==' },
  { type: 'image', mimeType: 'image/png', data: 'AB==' },
  { type: 'image', mimeType: 'image/png', data: 'AQ==\n' },
  { type: 'image', mimeType: 'image/png', data: 'AQ' },
  { type: 'image', mimeType: 'image/png', data: 'A_==' },
  { type: 'audio', mimeType: 'audio/wav', data: 'AQ==' }
])('continues refusing malformed or unsupported output: %j', (content) => {
  const journal = new DshAcpJournal(() => 'invalid-content')
  expect(() => journal.update({ sessionUpdate: 'agent_message_chunk', content }, false)).toThrow()
})
