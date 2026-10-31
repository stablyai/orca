import { expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { createStructuredChatNamingHandler } from '../structured-chat-naming'
import { setAgentSessionRecordUserName } from '../../runtime/agent-session-record-conversation-name'
import {
  createStructuredAgentSessionProviderNaming,
  withProviderNaming
} from './structured-agent-session-provider-naming'

type Rename = NonNullable<StructuredAgentSessionAdapter['renameProviderSession']>

function chat(fields: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId: 'chat-1',
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/work/.codex' },
    providerHandleChain: [
      {
        linkId: 'link-1',
        handle: codexProviderHandle('thread-1'),
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 0
      }
    ],
    conversationName: 'Release notes',
    conversationNameSource: 'user',
    ...fields
  })
}

function naming(rename: Rename) {
  const warn = vi.fn()
  const queue = createStructuredAgentSessionProviderNaming({
    adapter: { renameProviderSession: rename },
    logger: { warn, error: vi.fn() }
  })
  return { queue, warn }
}

it("never pushes a name Orca chose, or one for a chat that hasn't started its agent", async () => {
  const rename = vi.fn<Rename>(async () => {})
  let record = chat({ conversationNameSource: undefined })
  const { queue } = naming(rename)

  await queue.push(record)
  record = chat({ providerHandleChain: [] })
  await queue.push(record)

  expect(rename).not.toHaveBeenCalled()
})

it.each([10, 100])('coalesces %i saved renames into two ordered pushes', async (count) => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const rename = vi.fn<Rename>(() => gates[rename.mock.calls.length - 1]!.promise)
  let record = chat({ conversationName: 'First' })
  const { queue } = naming(rename)
  const handler = createStructuredChatNamingHandler({
    getStore: () => ({
      getRecord: () => record,
      compareAndSetConversationName: async () => record,
      setUserConversationName: async (_id, name, write) => {
        const result = setAgentSessionRecordUserName(record, name, write, 1_700_000_000_000)
        record = result.record
        return result
      }
    }),
    getSettings: () => ({ nativeChatAutoName: false }),
    workerTaskTitle: () => null,
    readFirstPrompt: async () => '',
    readJournalFirstPrompt: async () => '',
    generate: async () => null,
    onNamed: () => {},
    logger: { warn: vi.fn(), error: vi.fn() }
  })
  const wrapped = withProviderNaming(handler, (committed) => void queue.push(committed))
  await wrapped.setUserName('chat-1', 'First', 'rename')
  for (let i = 1; i <= count; i += 1) {
    await wrapped.setUserName('chat-1', `Name ${i}`, 'rename')
  }
  expect(rename).toHaveBeenCalledTimes(1)
  const done = queue.push(record)
  gates[0]!.resolve()
  await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(2))
  gates[1]!.resolve()
  await done
  expect(rename.mock.calls.map(([input]) => input.name)).toEqual(['First', `Name ${count}`])
  await wrapped.setUserName('chat-1', 'Ignored alias', 'legacy-alias')
  expect(rename).toHaveBeenCalledTimes(2)
})

it('logs a failed push and still takes the next rename', async () => {
  const rename = vi
    .fn<Rename>()
    .mockRejectedValueOnce(new Error('thread not found'))
    .mockResolvedValue(undefined)
  const { queue, warn } = naming(rename)
  const record = chat()

  await queue.push(record)
  await queue.push(record)

  expect(warn).toHaveBeenCalledTimes(1)
  expect(rename).toHaveBeenCalledTimes(2)
})
