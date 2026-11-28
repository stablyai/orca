import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { dispatchClaudeTurn } from '../../../../../claude/structured/dispatch/claude-structured-dispatch'
import { forgetWaiter } from '../../../../../claude/structured/dispatch/claude-structured-dispatch-waiters'
import type { ClaudeSession } from '../../../../../claude/structured/claude-structured-session-state'
import { observeClaudeCommandLifecycle } from '../../../../../claude/structured/turns/claude-command-lifecycle'
import { createCodexDispatchEchoes } from '../../../../../codex/structured/turns/codex-structured-dispatch-echo'
import { startCodexTurn } from '../../../../../codex/structured/turns/codex-structured-turn-start'
import type { AgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalMessageItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { localProviderReceipt } from '../../../operations/structured-agent-session-command-turn'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import { fixture, journals, SESSION } from './structured-agent-session-subscriber-contract.test-fixture'

it('correlates the committed attempt and lets A settle without taking B’s receipt', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION, workspaceId: 'workspace', hostId: 'local', agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory: join(fixture.root, SESSION)
  })
  const subscribers = new AgentSessionSubscribers({ now: () => 100 })
  journal.observeCommits((commit) => {
    subscribers.providerReceipts.observe(SESSION, journal, commit)
  })
  const { providerReceipts } = subscribers
  const events: AgentSessionSubscribeEvent[] = []
  subscribers.open({
    id: 'desktop', sessionId: SESSION, fence: 1, journal, readsProviderReceived: true,
    emit: (frame) => events.push(frame)
  })
  const idle = () => vi.waitFor(() => expect(subscribers.retention(new Set())).toEqual([]))
  await idle()
  const receipts = () => events.flatMap((event) => event.type === 'batch' ? event.providerReceived ?? [] : [])
  const body: AgentJournalMessageItem = {
    kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }]
  }
  const append = (clientMessageId: string) => journal.appendSubmission({
    clientMessageId, payloadFingerprint: clientMessageId, body, fence: 1, handoverRecorded: true
  })
  const prepare = (clientMessageId: string) =>
    journal.prepareHandover({ clientMessageId, fence: 1, turnScope: { kind: 'thread' }, body })
  await append('A')
  const a = await journal.openCommand({
    clientMessageId: 'A', fence: 1, submittedAt: 1, turnScope: { kind: 'thread' }
  })
  expect(a.dispatchCursor?.sequence).toBe(2)
  expect(journal.cursor().sequence).toBe(3)
  const pendingA = providerReceipts.bind({
    journal, cursor: a.dispatchCursor!, clientMessageId: 'A', fence: 1, provider: 'claude', owns: () => true
  })

  await append('B')
  const b = await prepare('B')
  expect(b.firstHandover).toBe(true)
  expect(b.dispatchCursor?.sequence).toBe(5)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the send only reads dispatch state and the provider's transport.
  const claude = {
    providerSessionId: 'provider-1',
    dispatchWaiters: [],
    retiredDispatchWaiters: [],
    dispatchSequence: 0,
    connection: { send: async () => {} }
  } as unknown as ClaudeSession
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: receipt admission only uses location, provider and fence.
  const record = {
    location: { executionHostId: 'local', wslDistro: null },
    provider: 'claude',
    lease: { runtimeFence: 1 }
  } as AgentSessionRecord
  const bindB = localProviderReceipt({ journal, providerReceipts, fence: 1, record: () => record }, 'B', () => true)
  const sendClaude = (attempt: typeof b) => dispatchClaudeTurn(claude, {
    sessionId: SESSION, clientMessageId: 'B', body,
    beginProviderReceipt: () => bindB?.(attempt.dispatchCursor!, attempt.firstHandover)
  })
  await sendClaude(b)
  const first = claude.dispatchWaiters[0]!
  const lifecycle = (session_id: string, command_uuid = first.sentUuid) =>
    observeClaudeCommandLifecycle(claude, {
      type: 'command_lifecycle', session_id, command_uuid, state: 'queued'
    })
  lifecycle('foreign')
  lifecycle('provider-1', 'different-uuid')
  pendingA?.(() => true)
  await journal.resolveDispatch({ clientMessageId: 'A', fence: 1, state: 'unknown', reason: 'ended' })
  subscribers.deliverFrames(SESSION, journal)
  await idle()
  expect(receipts()).toEqual([])
  lifecycle('provider-1')
  lifecycle('provider-1')
  await idle()
  expect(receipts()).toEqual([5])
  forgetWaiter(claude, first)
  const retry = await prepare('B')
  expect(retry.firstHandover).toBe(false)
  await sendClaude(retry)
  expect(claude.dispatchWaiters[0]?.sentUuid).toBe(first.sentUuid)
  lifecycle('provider-1')
  subscribers.deliverFrames(SESSION, journal)
  await idle()
  expect(receipts()).toEqual([5])

  await append('C')
  const c = await prepare('C')
  expect(c.dispatchCursor?.sequence).toBe(9)
  const codex = {
    threadId: 'thread', options: new Map<string, string>(),
    dispatchEchoes: createCodexDispatchEchoes(),
    turnOpenWaits: { wait: async () => {} },
    connection: {
      request: async (_method: string, _params: unknown, options?: { onReply?: (value: unknown) => void }) => {
        const reply = { turn: { id: 'started-turn' } }
        options?.onReply?.(reply)
        return reply
      }
    }
  }
  await startCodexTurn(codex, {
    clientMessageId: 'C', body, requestedAt: 0,
    beginProviderReceipt: () => providerReceipts.bind({
      journal, cursor: c.dispatchCursor!, clientMessageId: 'C', fence: 1, provider: 'codex', owns: () => true
    })
  })
  subscribers.deliverFrames(SESSION, journal)
  await idle()
  expect(receipts()).toEqual([5, 9])
})
