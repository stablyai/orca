import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import {
  type OpenedProvider,
  recordStartedHandle
} from './structured-agent-session-start-provider-answer'
import type { StructuredAgentSessionProviderStartedContext } from './structured-agent-session-provider-started'
import {
  applyAgentSessionRecordCommand,
  type AgentSessionRecordCommand
} from '../../../runtime/agent-session/records/agent-session-record-command'

function opened(record: AgentSessionRecord, link: AgentSessionProviderHandleLink) {
  let stored = record
  const deps = {
    store: {
      getRecord: () => stored,
      updateRecord: async (_id: string, command: AgentSessionRecordCommand) => {
        const applied = applyAgentSessionRecordCommand(stored, command)
        stored = applied.record
        return applied.result
      }
    },
    logger: { warn: () => {} },
    turnContext: {
      plan: async () => null,
      launchedInstructions: () => ({ key: 'launch-key', rebuilt: false })
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recording a started handle reads only the store, logger, turn context and clock.
  const context = { deps, now: () => 5 } as unknown as StructuredAgentSessionProviderStartedContext
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recording reads only the event's session, fence and link.
  const event = { sessionId: record.sessionId, fence: 7, link } as unknown as OpenedProvider
  return { context, event, stored: () => stored }
}

describe("a confirmed open's instructions receipt", () => {
  it('a new conversation records the launch key at open, before any turn', async () => {
    const neverOpened = { ...agentSessionRecordFixture(), providerHandleChain: [] }
    const { context, event, stored } = opened(neverOpened, {
      linkId: 'link-1',
      origin: 'created',
      mintedAtFence: 7,
      observedAt: 4,
      handle: claudeProviderHandle('fresh-session', null)
    })
    expect(await recordStartedHandle(context, event)).toBe(true)
    expect(stored().instructionsKey).toBe('launch-key')
  })

  it('a resumed conversation on an agent that keeps its first prompt keeps its receipt', async () => {
    const resumed = {
      ...agentSessionRecordFixture(agentSessionLeaseFixture({ runtimeFence: 8 })),
      instructionsKey: 'old-key'
    }
    const { context, event, stored } = opened(resumed, {
      linkId: 'link-2',
      origin: 'resumed',
      mintedAtFence: 8,
      observedAt: 4,
      handle: claudeProviderHandle('provider-session-alpha-1', 'leaf-2')
    })
    expect(await recordStartedHandle(context, { ...event, fence: 8 })).toBe(true)
    expect(stored().instructionsKey).toBe('old-key')
  })
})
