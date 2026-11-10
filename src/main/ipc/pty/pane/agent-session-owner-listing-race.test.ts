import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../../shared/constants'
import { LegacyTerminalIdentityClaims } from '../../../persistence/loading-store/legacy-terminal-identity-claims'
import * as providers from '../provider/registry'
import {
  ptyIncarnationById,
  ptyOwnership,
  restorePtyIncarnation
} from '../provider/ownership-state'
import { admitPtySpawnOwnership } from './spawn-registration'
import { reconcileAgentSessionOwnerListings, agentSessionOwners } from './agent-session-owners'
import {
  stageSelectedTerminal,
  selectedTerminalForPane
} from '../../../pty/selected-terminal-retirement'
import { clearProviderPtyState } from '../provider/state-cleanup'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { IPtyProvider, PtyProcessInfo } from '../../../providers/pty-provider-contract'
import type { AgentSessionOwnerBinding } from '../../../../shared/agent-session/agent-session-host-authority'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
const id = 'workspace@@feedcafe'
const oldIncarnation = '11111111-1111-4111-8111-111111111111'
const newIncarnation = '22222222-2222-4222-8222-222222222222'
const tabId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const leafId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const paneKey = `${tabId}:${leafId}`
const owner: AgentSessionOwnerBinding = {
  claim: {
    digestVersion: 1,
    keyId: 'test',
    identityDigest: 'a'.repeat(43),
    worktreeScopeDigest: 'b'.repeat(43),
    agent: 'claude'
  },
  generation: 'owner-generation',
  phase: 'live',
  ptyId: id,
  surface: { worktreeId: 'workspace', tabId, leafId, terminalHandle: 'term_test' }
}
afterEach(() => {
  clearProviderPtyState(id)
  agentSessionOwners.release(id)
  vi.restoreAllMocks()
})
it('keeps a newly admitted selected incarnation and claim when an older multi-provider listing settles', async () => {
  const authority = new LegacyTerminalIdentityClaims(
    getDefaultPersistedState('/tmp/restore-pty-listing-race')
  )
  let release!: (value: PtyProcessInfo[]) => void
  const delayed = new Promise<PtyProcessInfo[]>((resolve) => {
    release = resolve
  })
  const localListing = {
    listProcesses: async () => [{ id, incarnationId: oldIncarnation, agentSessionOwners: [owner] }],
    providesAgentSessionOwnerListings: () => true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This listing-only fixture supplies the only provider methods reconciliation calls.
  const local = localListing as unknown as IPtyProvider
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This listing-only fixture supplies the only provider method reconciliation calls.
  const second = { listProcesses: () => delayed } as unknown as IPtyProvider
  vi.spyOn(providers, 'registeredPtyProviders').mockReturnValue([
    { provider: local, hostId: LOCAL_EXECUTION_HOST_ID },
    { provider: second, hostId: LOCAL_EXECUTION_HOST_ID }
  ])
  vi.spyOn(providers, 'tryGetProviderForPty').mockReturnValue(local)
  restorePtyIncarnation(id, oldIncarnation)
  ptyOwnership.set(id, LOCAL_EXECUTION_HOST_ID)
  const pending = reconcileAgentSessionOwnerListings()
  const result = { id, incarnationId: newIncarnation }
  stageSelectedTerminal(result, {
    authority,
    workspace: 'workspace',
    paneKey,
    provider: local,
    result
  })
  admitPtySpawnOwnership(undefined, result)
  const successorClaim = { ...owner, generation: 'successor-generation' }
  agentSessionOwners.register(successorClaim)
  try {
    release([])
    await pending
    expect(ptyIncarnationById.get(id)).toBe(newIncarnation)
    expect(ptyOwnership.get(id)).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(
      selectedTerminalForPane(authority, 'workspace', paneKey, id, newIncarnation)?.result
    ).toEqual(result)
    expect(agentSessionOwners.listForPty(id)).toEqual([successorClaim])
  } finally {
    release([])
    await pending
  }
})
