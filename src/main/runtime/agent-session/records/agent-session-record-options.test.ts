import { expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import {
  pickAgentSessionOption,
  recordAgentSessionRanOptions
} from './agent-session-record-options'

it('retains Default through observed effort and restart until a concrete choice is durable', () => {
  const record = {
    ...agentSessionRecordFixture(),
    omitEffort: true as const,
    options: { model: 'saved-model', serviceTier: 'flex' }
  }
  const observed = recordAgentSessionRanOptions(record, {
    sessionId: record.sessionId,
    fence: 7,
    model: 'saved-model',
    options: { effort: 'medium' },
    models: undefined,
    now: 3000
  })
  expect(observed.options).toEqual({ model: 'saved-model', serviceTier: 'flex' })
  expect(observed.omitEffort).toBe(true)
  const stored = encodeAgentSessionRecord(observed)
  const restarted = decodePersistedAgentSessionRecord(stored).record
  expect(restarted.omitEffort).toBe(true)
  const picked = pickAgentSessionOption(restarted, {
    sessionId: record.sessionId,
    fence: 7,
    key: 'effort',
    value: 'high',
    models: undefined,
    now: 4000
  })
  expect(picked.options).toEqual({ model: 'saved-model', serviceTier: 'flex', effort: 'high' })
  expect(picked.omitEffort).toBeUndefined()
  const sent = recordAgentSessionRanOptions(restarted, {
    sessionId: record.sessionId,
    fence: 7,
    model: 'saved-model',
    options: { effort: 'high' },
    authoredEffort: 'high',
    models: undefined,
    now: 4000
  })
  expect(sent.options).toEqual({ model: 'saved-model', serviceTier: 'flex', effort: 'high' })
  expect(sent.omitEffort).toBeUndefined()
})
