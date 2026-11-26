import { expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { pickAgentSessionOption } from './agent-session-record-options'

it('clears incompatible saved Trae efforts while preserving compatible and unknown choices', () => {
  const record: AgentSessionRecord = {
    ...agentSessionRecordFixture(
      agentSessionLeaseFixture({
        claimStatus: 'released',
        ownerProcess: null,
        provenHandleLinkId: null
      })
    ),
    provider: 'trae',
    providerHandleChain: [],
    accountHome: { variable: 'HOME', path: '/home/user' },
    options: { model: 'previous', effort: 'high' }
  }
  const pick = {
    sessionId: record.sessionId,
    fence: 7,
    key: 'model',
    value: 'compatible',
    models: [
      {
        id: 'compatible',
        label: 'Compatible',
        isDefault: false,
        efforts: [{ value: 'high', label: 'High' }]
      },
      { id: 'fixed', label: 'Fixed', isDefault: false, efforts: [] }
    ],
    now: 5_000
  }
  const compatible = pickAgentSessionOption(record, pick)
  expect(compatible.options).toEqual({ model: 'compatible', effort: 'high' })
  expect(pickAgentSessionOption(compatible, { ...pick, value: 'fixed' }).options).toEqual({
    model: 'fixed'
  })
  expect(
    pickAgentSessionOption(record, { ...pick, value: 'fixed', models: undefined }).options
  ).toEqual({ model: 'fixed', effort: 'high' })
  expect(
    pickAgentSessionOption({ ...record, provider: 'codex' }, { ...pick, value: 'fixed' }).options
  ).toEqual({ model: 'fixed', effort: 'high' })
})
