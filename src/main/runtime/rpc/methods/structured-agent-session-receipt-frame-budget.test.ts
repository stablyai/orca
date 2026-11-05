import '../unused-default-rpc-methods.test-fixture'
import { settleTestSubscriberDeliveries } from '../../../native-chat/agent-session-wire/agent-session-subscriber-test-support'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../../shared/agent-session/agent-session-wire'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../../shared/mobile-bridge-frame-bytes'
import {
  AgentSessionSubscribers,
  type AgentSessionSubscribeInput
} from '../../../native-chat/agent-session-wire/structured-agent-session-subscribers'
import {
  fixture,
  journals
} from '../../../native-chat/agent-session-wire/structured-agent-session-subscriber-contract-test-fixture'
import {
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  openStream,
  SESSION,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

it.each(['snapshot', 'reset', 'batch'] as const)(
  'keeps near-limit %s delivery readable when receipt names do not fit',
  async (type) => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: join(fixture.root, 'receipts')
    })
    const start = journal.cursor()
    for (let ordinal = 1; ordinal <= 200; ordinal++) {
      await journal.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal },
        {
          kind: 'approval',
          title: `Approval ${ordinal}`,
          detail: 'x'.repeat(2500),
          options: [{ id: 'yes', label: 'Allow' }],
          resolution: {
            state: 'resolved',
            selectedOptionId: 'yes',
            resolvedBy: 'desktop-renderer',
            resolvedAt: 10
          }
        },
        { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    const base: AgentSessionSubscribeEvent[] = []
    const subscribers = new AgentSessionSubscribers()
    hostCalls.subscribe.mockImplementation((input: AgentSessionSubscribeInput) =>
      subscribers.open({
        ...input,
        journal,
        fence: 7,
        emit: (event) => {
          base.push(event)
          input.emit(event)
        }
      })
    )
    const cursor = type === 'reset' ? { epoch: 'old', sequence: 0 } : start
    const responses = await openStream(
      'agentSession.subscribe',
      { sessionId: SESSION, ...(type === 'snapshot' ? {} : { cursor }) },
      { ...STRUCTURED_MOBILE_CLIENT, clientId: 'reader-phone' },
      { readMachineName: () => '界'.repeat(255) }
    )
    await settleTestSubscriberDeliveries(subscribers)
    expect(base[0]?.type).toBe(type)
    expect(Buffer.byteLength(JSON.stringify(base[0]), 'utf8')).toBeGreaterThan(540 * 1024)
    expect(responses).toHaveLength(base.length)
    for (const [index, response] of responses.entries()) {
      expect(response).toMatchObject({ ok: true, result: base[index] })
      if (!response.ok) {
        throw new Error('expected receipt delivery')
      }
      const frame = {
        v: 1,
        type: 'event',
        id: 'receipt-stream',
        seq: 2 ** 31,
        payload: response.result
      }
      expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThanOrEqual(
        MOBILE_BRIDGE_MAX_FRAME_BYTES
      )
    }
    expect(journal.snapshot().items).toHaveLength(200)
    expect(JSON.stringify(journal.snapshot().items)).not.toContain('resolvedByDevice')
  }
)
