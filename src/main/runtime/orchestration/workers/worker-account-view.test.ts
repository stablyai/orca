import { describe, expect, it } from 'vitest'
import {
  type ClaudeAccountRecipe,
  withAcquiredAgentSessionAccount
} from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { workerAccountView } from './worker-account-view'

const HOME = '/qa/claude-profiles/qa-b/home'

function launched(recipe: ClaudeAccountRecipe) {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId: '2f4c6a10-8d1e-4b7a-9c3e-5a6b7c8d9e0f' })
  )
  return withAcquiredAgentSessionAccount(record, { generation: 'generation-1', recipe })
}

describe('workerAccountView', () => {
  it('names the managed account a worker was launched under, without its home path', () => {
    const record = launched({ route: 'managed', accountId: 'acct_b', home: HOME })
    const view = workerAccountView(record, record.lease.ownerProcess?.hostId)
    expect(view).toEqual({ provider: 'claude', route: 'managed', accountId: 'acct_b' })
    expect(JSON.stringify(view)).not.toContain(HOME)
  })

  it('reports the system route without its home or config paths', () => {
    const record = launched({ route: 'system', home: HOME, configDir: HOME })
    const view = workerAccountView(record, record.lease.ownerProcess?.hostId)
    expect(view).toEqual({ provider: 'claude', route: 'system' })
    expect(JSON.stringify(view)).not.toContain(HOME)
  })

  it('is null when no launch was observed or the observation belongs elsewhere', () => {
    const record = launched({ route: 'managed', accountId: 'acct_b', home: HOME })
    expect(workerAccountView(null, undefined)).toBeNull()
    expect(workerAccountView(agentSessionRecordFixture(), undefined)).toBeNull()
    expect(workerAccountView(record, 'another-host')).toBeNull()
    expect(workerAccountView({ ...record, sessionId: 'another-chat' }, undefined)).toBeNull()
  })
})
