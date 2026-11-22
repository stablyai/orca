import { expect, it, vi } from 'vitest'
import startOptions from '../../../acp/fixtures/opencode-v2-start-options.json'
import { OPENCODE_ACP_DIALECT } from '../../../acp/acp-dialects/opencode-dialect'
import { AcpStructuredOptions } from '../../../acp/options/acp-structured-options'
import { acpStructuredAgentDefinition } from '../../../acp/session/acp-structured-agent-definitions'
import { acpLaunchSpecFor } from '../../../acp/launch/acp-launch-registry'
import { recordStructuredAgentSessionOptionIntent } from './structured-agent-session-option-intent'
import { NewSessionResponseSchema } from '../../../acp/generated/acp-protocol.generated'
import { agentSessionRecordFixture } from '../../testing/agent-session-record-test-fixture'

it('persists only an advertised agent as intent without changing the provider', async () => {
  const native = new AcpStructuredOptions(OPENCODE_ACP_DIALECT)
  native.adoptSession(NewSessionResponseSchema.parse(startOptions))
  const record = agentSessionRecordFixture({ sessionId: 'test', provider: 'opencode', options: {} })
  const picked = { ...record, options: { agent: 'plan' } }
  const updateRecord = vi.fn(async () => picked)
  const setOption = vi.fn()
  const deps = {
    store: {
      getRecord: () => record,
      replaceSessionOptions: async () => record,
      updateRecord
    },
    agents: { definition: () => acpStructuredAgentDefinition(acpLaunchSpecFor('opencode')!) },
    adapter: { readOptions: async () => native.read(), setOption }
  }
  const ctx = { sessionId: 'test', fence: 1, publish: vi.fn(), now: () => 1 }
  expect(
    await recordStructuredAgentSessionOptionIntent(deps, ctx, {
      key: 'agent',
      value: 'unknown'
    })
  ).toMatchObject({ ok: false })
  expect(updateRecord).not.toHaveBeenCalled()
  expect(
    await recordStructuredAgentSessionOptionIntent(deps, ctx, {
      key: 'agent',
      value: 'plan'
    })
  ).toMatchObject({ ok: true, value: { options: { agent: 'plan' } } })
  expect(setOption).not.toHaveBeenCalled()
  expect(native.read().current.agent).toBe('build')
})
