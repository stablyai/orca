import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertAccountHasNoAgentProfiles,
  assertAccountHasNoStructuredProfileOwners
} from './account-removal'
import {
  _internals,
  forgetCodexPaneAccount,
  hasRecordedProfileBoundCodexAccount,
  recordCodexPaneAccount,
  reserveCodexProfileAccountOwner
} from '../codex/codex-pane-account-registry'

let directory: string
let previous: string | undefined
beforeEach(() => {
  previous = process.env.ORCA_USER_DATA_PATH
  directory = mkdtempSync(join(tmpdir(), 'profile-removal-'))
  process.env.ORCA_USER_DATA_PATH = directory
  _internals.resetCache()
})
afterEach(() => {
  setStructuredAgentSessionHost(null)
  _internals.resetCache()
  rmSync(directory, { recursive: true, force: true })
  if (previous === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previous
  }
})
it.each(['claude', 'codex'] as const)(
  'requires unlink before removing a referenced %s account',
  (agent) => {
    const settings = {
      agentLaunchProfiles: [
        {
          id: 'a',
          name: 'A',
          agent,
          hostId: 'local' as const,
          executable: '/cli',
          binding: { kind: 'managed', accountId: 'a' } as const
        }
      ]
    }
    expect(() => assertAccountHasNoAgentProfiles(settings, agent, 'a')).toThrow(/Unlink/)
    expect(() =>
      assertAccountHasNoAgentProfiles({ agentLaunchProfiles: [] }, agent, 'a')
    ).not.toThrow()
  }
)
it('retains deletion protection from pending launch through committed process after unlink', () => {
  const release = reserveCodexProfileAccountOwner('a')
  expect(hasRecordedProfileBoundCodexAccount('a')).toBe(true)
  recordCodexPaneAccount('pty', {
    selectionKey: 'host',
    accountId: 'a',
    homeRoute: 'account-home',
    profileBound: true
  })
  release()
  expect(hasRecordedProfileBoundCodexAccount('a')).toBe(true)
  expect(hasRecordedProfileBoundCodexAccount('b')).toBe(false)
  forgetCodexPaneAccount('pty')
  expect(hasRecordedProfileBoundCodexAccount('a')).toBe(false)
})
it('refuses deletion when the ownership registry cannot be read', () => {
  writeFileSync(join(directory, 'codex-pane-accounts.json'), 'malformed')
  expect(() => hasRecordedProfileBoundCodexAccount('a')).toThrow()
})

it.each(['claude', 'codex'] as const)(
  'protects live and uncertain structured %s ownership after unlink, but permits closed history',
  async (agent) => {
    const record = agentSessionRecordFixture()
    record.accountHome.agentProfile = {
      id: 'profile',
      name: 'captured',
      agent,
      hostId: 'local',
      executable: '/trusted/cli',
      resolvedHome: record.accountHome.path,
      binding: { kind: 'managed', accountId: 'one' },
      identity: { kind: 'verified', subject: 'one', displayName: 'One' }
    }
    const probeOwner = vi.fn(async (): Promise<AgentSessionOwnerProbe> => ({
      outcome: 'identity-matched',
      matchedOn: ['spawn-token']
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: account deletion reads only the store inventory and owner probe; registry subscriptions are optional at runtime.
    setStructuredAgentSessionHost({
      deps: { store: { listRecords: () => [record] }, probeOwner }
    } as unknown as StructuredAgentSessionHost)
    await expect(assertAccountHasNoStructuredProfileOwners(agent, 'one')).rejects.toThrow(
      /uncertain/
    )
    probeOwner.mockResolvedValue({ outcome: 'indeterminate', reason: 'unknown' })
    await expect(assertAccountHasNoStructuredProfileOwners(agent, 'one')).rejects.toThrow(
      /uncertain/
    )
    await expect(assertAccountHasNoStructuredProfileOwners(agent, 'other')).resolves.toBeUndefined()
    record.lease.ownerProcess = null
    record.lease.claimStatus = 'released'
    await expect(assertAccountHasNoStructuredProfileOwners(agent, 'one')).resolves.toBeUndefined()
    expect(probeOwner).toHaveBeenCalledTimes(2)
  }
)
