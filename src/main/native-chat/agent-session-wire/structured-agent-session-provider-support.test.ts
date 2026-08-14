import { expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { isAgentSessionRecord } from '../../../shared/agent-session-record'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import { attachParamsForRecord } from './structured-agent-session-read-restore'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

it.each(['openclaude', 'grok', 'omp'] as const)('restores %s through its own adapter', (agent) => {
  const record = agentSessionRecordFixture()
  record.agent = agent
  if (agent !== 'openclaude') {
    record.provider = 'acp'
    record.providerHandleChain[0]!.handle = {
      provider: 'acp',
      agent,
      sessionId: 'provider-session'
    }
  }
  const restored = JSON.parse(JSON.stringify(record))
  expect(isAgentSessionRecord(restored)).toBe(true)
  const supportsCreate = vi.fn((_location, candidate) => candidate === agent)
  const adapter: StructuredAgentSessionAdapter = {
    supportsCreate,
    acquire: vi.fn(),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
  expect(adapterSupportsRecord(adapter, restored)).toBe(true)
  const params = attachParamsForRecord(restored, {
    clientOperationId: 'restore',
    expectedRuntimeFence: 7
  })
  expect(params.agent).toBe(agent)
  expect(params.provider).toBe(record.provider)
})
