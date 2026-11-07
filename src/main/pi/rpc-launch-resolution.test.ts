import { createPiRpcLaunchResolver } from '../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { closeTestJournalHostDatabase } from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store-test-harness'

const probeVersion = vi.fn(async (..._input: unknown[]): Promise<{ version: string | null }> => ({
  version: '0.84.0'
}))

const identity: AgentSessionJournalIdentity = {
  sessionId: 'session-pi-resolve',
  workspaceId: 'folder-1',
  hostId: 'local',
  agent: 'pi',
  providerHandle: null
}
let root: string
beforeEach(async () => {
  probeVersion.mockReset().mockResolvedValue({ version: '0.84.0' })
  root = await mkdtemp(join(tmpdir(), 'orca-pi-resolver-'))
})
afterEach(async () => {
  await closeTestJournalHostDatabase(root)
  await rm(root, { recursive: true, force: true })
})

async function setup() {
  const store = await openTestAgentSessionRecordStore(root)
  const { record } = await store.reserveOwner({
    sessionId: identity.sessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-1',
      workspaceKind: 'folder'
    },
    provider: 'pi',
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/host/account' },
    expectedFence: null,
    spawnToken: 'spawn-pi',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client-1',
      operationId: '1800000000000-00000000000000000000000000000001',
      fingerprint: 'pi-create'
    },
    now: 1_800_000_000_000
  })
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const resolveEnvironment = vi.fn(async () => ({
    PATH: '/host/bin',
    HOME: '/host/home',
    PI_CODING_AGENT_DIR: '/inherited/wrong'
  }))
  const resolveCommand = vi.fn((..._input: unknown[]) => '/host/bin/pi')
  const settings: { agentCmdOverrides: Record<string, string> } = { agentCmdOverrides: {} }
  const resolver = createPiRpcLaunchResolver({
    store,
    resolveWorkspacePath: async () => workspace,
    resolveEnvironment,
    resolveCommandSettings: () => settings,
    resolveCommand,
    probeVersion
  })
  const prior = (
    file: string,
    origin: AgentSessionProviderHandleLink['origin'] = 'created'
  ): AgentSessionProviderHandleLink => ({
    linkId: 'prior-link',
    handle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: file },
    origin,
    mintedAtFence: 1,
    observedAt: 100
  })
  const withPrior = (link: AgentSessionProviderHandleLink) => {
    vi.spyOn(store, 'requireWritableRecord').mockReturnValue({
      ...record,
      providerHandleChain: [link]
    })
  }
  return { resolver, prior, withPrior }
}

it.each(['created', 'resumed'] as const)(
  'refuses a %s session whose file is gone, starting no other',
  async (origin) => {
    const h = await setup()
    h.withPrior(h.prior(join(root, 'missing.jsonl'), origin))
    await expect(h.resolver(identity)).rejects.toMatchObject({
      name: 'AgentSessionAcquisitionRefusal',
      reason: 'savedConversationMissing'
    })
  }
)
