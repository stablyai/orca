import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createPiRpcLaunchResolver } from '../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { buildPiRpcLaunch } from './rpc-launch'

const probeVersion = vi.fn(async (..._input: unknown[]): Promise<{ version: string | null }> => ({
  version: '0.84.0'
}))
const SEED = { model: 'anthropic/claude-sonnet-4-5', effort: 'low' }
const identity: AgentSessionJournalIdentity = {
  sessionId: 'session-pi-seeding',
  workspaceId: 'folder-1',
  hostId: 'local',
  agent: 'pi',
  providerHandle: null
}

let root: string
beforeEach(async () => {
  probeVersion.mockReset().mockResolvedValue({ version: '0.84.0' })
  root = await mkdtemp(join(tmpdir(), 'orca-pi-seeding-'))
})
afterEach(async () => {
  await closeTestJournalHostDatabases()
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
  const settings: { agentCmdOverrides: Record<string, string> } = {
    // A configured provider and model must yield to the chat's pick.
    agentCmdOverrides: { pi: `"${process.execPath}" --provider openai --model gpt-5.5` }
  }
  const resolver = createPiRpcLaunchResolver({
    store,
    resolveWorkspacePath: async () => workspace,
    resolveEnvironment: async () => ({ PATH: '/host/bin', HOME: '/host/home' }),
    resolveCommandSettings: () => settings,
    resolveCommand: () => '/host/bin/pi',
    probeVersion
  })
  const withRecord = (patch: Partial<typeof record>) => {
    vi.spyOn(store, 'requireWritableRecord').mockReturnValue({ ...record, ...patch })
  }
  const prior = (file: string): AgentSessionProviderHandleLink => ({
    linkId: 'prior-link',
    handle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: file },
    origin: 'created',
    mintedAtFence: 1,
    observedAt: 100
  })
  return { workspace, resolver, withRecord, prior }
}

describe('Pi seeded launch resolution', () => {
  it('launches a new chat on its saved model and effort, without the configured model pins', async () => {
    const h = await setup()
    h.withRecord({ options: SEED })
    const launch = await h.resolver(identity)
    expect(launch.launchIntent).toEqual(SEED)
    // The configured provider and model yielded to the chat's pick.
    expect(launch.prefixArgs).toEqual([])
    const args = buildPiRpcLaunch(launch).args
    const model = args.indexOf('--model')
    expect(args.slice(model, model + 4)).toEqual([
      '--model',
      'anthropic/claude-sonnet-4-5',
      '--thinking',
      'low'
    ])
  })

  it('adds no seed flags to a resumed conversation, which keeps its own model', async () => {
    const h = await setup()
    const file = join(root, 'resumed.jsonl')
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', cwd: h.workspace })}
`
    )
    h.withRecord({ options: SEED, providerHandleChain: [h.prior(file)] })
    const launch = await h.resolver(identity)
    expect(launch.sessionFile).toBe(file)
    expect(launch.launchIntent).toBeUndefined()
    expect(launch.extraArgs).toBeUndefined()
    const args = buildPiRpcLaunch(launch).args
    expect(args.slice(0, 6)).toEqual([
      '--provider',
      'openai',
      '--model',
      'gpt-5.5',
      '--mode',
      'rpc'
    ])
    expect(args).not.toContain('--thinking')
    expect(args).toContain(file)
  })

  it('adds no seed flags to a forked conversation either', async () => {
    const h = await setup()
    const file = join(root, 'elsewhere.jsonl')
    await writeFile(
      file,
      `${JSON.stringify({ type: 'session', cwd: join(root, 'other') })}
`
    )
    h.withRecord({ options: SEED, providerHandleChain: [h.prior(file)] })
    const launch = await h.resolver(identity)
    expect(launch.forkFile).toBe(file)
    expect(launch.launchIntent).toBeUndefined()
    expect(launch.extraArgs).toBeUndefined()
    const args = buildPiRpcLaunch(launch).args
    expect(args.slice(0, 6)).toEqual([
      '--provider',
      'openai',
      '--model',
      'gpt-5.5',
      '--mode',
      'rpc'
    ])
    expect(args).not.toContain('--thinking')
    expect(args).toContain(file)
  })
})
