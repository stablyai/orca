import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentDrivesSession } from '../native-chat/agent-session-wire/structured-agent-session-provider-support'
import { composeStructuredLaunchRead } from '../runtime/structured-agent-launch-composition'
import { OMP_RPC_AGENT } from './rpc-agent-definition'
import { ompRpcProviderLink, resolveOmpRpcResume } from './rpc-launch'
import { recordAgentSessionProviderHandle } from '../runtime/agent-session/ownership/agent-session-provider-handle-transition'

let root: string | undefined
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('lists models and resolves the same transcript for an existing ACP chat through production admission', async () => {
  root = await mkdtemp(join(tmpdir(), 'omp-legacy-admission-'))
  const cwd = join(root, 'workspace')
  const accountDir = join(root, 'agent')
  const sessionId = '01a00000-0000-7000-8000-000000000003'
  const sessionDir = join(accountDir, 'sessions', '-workspace')
  const sessionFile = join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`)
  await mkdir(cwd, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd })}\n`
  )
  const previous = {
    linkId: 'old-acp',
    handle: { agent: 'omp', transport: 'acp', nativeId: sessionId },
    origin: 'adopted',
    mintedAtFence: 1,
    observedAt: 1
  } as const
  const record = agentSessionRecordFixture({
    sessionId: 'old-omp-chat',
    provider: 'omp',
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: accountDir },
    providerHandleChain: [previous]
  })
  const agents = { definition: () => OMP_RPC_AGENT }
  record.lease.deathEvidence = {
    kind: 'exit-observed',
    detail: 'closed by Orca',
    observedAt: 1,
    ownerFence: 1
  }
  const catalog = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getRecord: () => record,
    getConversation: () => agentSessionConversationView(record),
    drivesRecord: (saved) => agentDrivesSession(agents, saved),
    resolveAccountHome: async () => record.accountHome,
    probes: {
      omp: Object.assign(
        async () => ({
          origin: 'probe' as const,
          models: [
            { id: 'provider/model-one', label: 'Model One', isDefault: true, efforts: [] },
            { id: 'provider/model-two', label: 'Model Two', isDefault: false, efforts: [] }
          ]
        }),
        { sessionless: true as const }
      )
    },
    listsInChatFolder: new Set(['omp'])
  })
  try {
    const listing = await catalog.read({
      agent: 'omp',
      sessionId: record.sessionId,
      workspacePath: cwd,
      waitForListing: true
    })
    expect(listing).toMatchObject({
      origin: 'probe',
      models: [
        { id: 'provider/model-one', label: 'Model One' },
        { id: 'provider/model-two', label: 'Model Two' }
      ]
    })
  } finally {
    catalog.stop()
  }
  const env = { USERPROFILE: root, PI_CODING_AGENT_DIR: accountDir }
  const readLaunch = composeStructuredLaunchRead<{
    sessionFile: string
    lineage: readonly string[]
  }>(
    OMP_RPC_AGENT,
    {
      store: {
        selectWritableRecord: () => ({ kind: 'writable', record }),
        requireWritableRecord: () => record,
        pinLaunchDirectory: async () => record
      },
      resolveWorkspacePath: async () => cwd,
      resolveBaseEnvironment: async () => env,
      resolveAgentEnvironment: async () => env
    },
    async () => ({
      launch: await resolveOmpRpcResume({ previous, cwd, env }),
      env,
      inheritedEnvToDelete: []
    })
  )
  const launch = await readLaunch({
    sessionId: record.sessionId,
    agent: 'omp',
    hostId: 'local',
    workspaceId: 'workspace-1',
    providerHandle: previous.handle
  })
  expect(launch.sessionFile).toBe(sessionFile)
  expect(record.providerHandleChain).toEqual([previous])
  const link = ompRpcProviderLink(
    { ...launch, command: 'omp', fullAccess: true, previous },
    sessionFile,
    2,
    'rpc-resumed',
    2
  )
  const resumed = recordAgentSessionProviderHandle({
    record: { ...record, lease: { ...record.lease, runtimeFence: 2, claimStatus: 'live' } },
    fence: 2,
    link,
    now: 2
  })
  expect(resumed.providerHandleChain).toEqual([previous, link])
  expect(link.handle).toEqual(previous.handle)
  expect(agentDrivesSession(agents, resumed)).toBe(true)
  expect(
    agentDrivesSession(agents, {
      ...record,
      accountHome: { variable: 'CODEX_HOME', path: accountDir }
    })
  ).toBe(false)
  expect(
    agentDrivesSession(agents, {
      ...record,
      providerHandleChain: [{ ...previous, handle: { ...previous.handle, agent: 'pi' } }]
    })
  ).toBe(false)
  expect(
    agentDrivesSession(agents, {
      ...record,
      providerHandleChain: [{ ...previous, handle: { ...previous.handle, transport: 'codex-acp' } }]
    })
  ).toBe(false)
})
