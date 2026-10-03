import type * as ProfileRouting from '../../shared/claude-profile-routing'
import { afterEach, expect, it, vi } from 'vitest'
const gate = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../shared/claude-profile-routing', async (original) => ({
  ...(await original<typeof ProfileRouting>()),
  claudeProfileRoutingEnabled: () => gate.enabled
}))
import { isPersistedAgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { agentModelCatalogIdentityForRecord } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'

afterEach(() => {
  gate.enabled = false
})

const record = {
  ...agentSessionRecordFixture(),
  accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/origin' },
  launchAccountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/profile-b', accountId: 'b' }
}

it('persists the launch account and ignores it until profile routing is on', () => {
  expect(isPersistedAgentSessionRecord(record)).toBe(true)
  expect(
    isPersistedAgentSessionRecord({ ...record, launchAccountHome: { ...record.accountHome } })
  ).toBe(false)
  expect(agentModelCatalogIdentityForRecord(record).accountHomePath).toBe('/origin')
  gate.enabled = true
  expect(agentModelCatalogIdentityForRecord(record).accountHomePath).toBe('/profile-b')
})
