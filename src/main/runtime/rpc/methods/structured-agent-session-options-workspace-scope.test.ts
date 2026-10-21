import '../unused-default-rpc-methods.test-fixture'
// A chat at rest in a repo whose own config may pick its model: a client that takes an answer naming
// no model gets the folder's answer, while one that needs a model keeps the account default and
// every other part of the read, never a refusal.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY } from '../../../../shared/agent-session-optional-model-capability'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { agentModelCatalogFingerprintForRecord } from '../../../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from '../../../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../../../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  agentReadsProjectModelConfig,
  workspaceMayOverrideDefaultModel
} from '../../../native-chat/agent-model-catalog/agent-project-model-override'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_SESSION as SESSION,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'

const OLDER_CLIENT = {
  clientId: 'phone-1',
  clientKind: 'mobile' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  connectionId: 'connection-1'
}
const CURRENT_CLIENT = {
  ...OLDER_CLIENT,
  clientId: 'desktop-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY
  ]
}

let rig: RestTestRig
let dispatcher: RpcDispatcher

async function readOptions(client: typeof OLDER_CLIENT | typeof CURRENT_CLIENT) {
  const replies: unknown[] = []
  await dispatcher.dispatchStreaming(
    {
      id: 'request-1',
      authToken: 'token',
      method: 'agentSession.options',
      params: { sessionId: SESSION }
    },
    (raw) => replies.push(JSON.parse(raw)),
    client
  )
  return replies[0]
}

/** A Codex chat with no pick, at rest in a repo; `configured` gives the repo a `.codex/config.toml`
 *  that sets the effort. */
async function chatAtRest(repoConfig: { configured: boolean }): Promise<void> {
  await foundRestTestChat(rig)
  // The chat never picked: its next start runs whatever its config resolves.
  await rig.store.replaceSessionOptions({
    sessionId: SESSION,
    fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
    options: {},
    now: rig.clock.now
  })
  const repo = join(rig.root, 'repo')
  await mkdir(join(repo, '.codex'), { recursive: true })
  await writeFile(join(repo, '.git'), 'gitdir: /elsewhere')
  if (repoConfig.configured) {
    await writeFile(join(repo, '.codex', 'config.toml'), 'model_reasoning_effort = "high"\n')
  }
  const store = new AgentModelCatalogStore()
  // Not inline: this base's listing still requires the tier map that main has since dropped.
  const listing = {
    models: [
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        isDefault: true,
        defaultEffort: 'medium',
        efforts: [
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' }
        ]
      }
    ],
    fastModeTierByModel: new Map(),
    origin: 'probe' as const
  }
  store.recordSuccess(
    agentModelCatalogFingerprintForRecord(rig.store.getRecord(SESSION)!),
    'codex',
    listing,
    'discovery'
  )
  const modelCatalog = createAgentModelCatalogService({
    store,
    getRecord: (sessionId) => rig.store.getRecord(sessionId) ?? undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => rig.store.getRecord(SESSION)!.accountHome,
    listingNamesConfiguredModel: new Set(['codex']),
    recordWorkspacePath: async () => repo,
    agentReadsProjectModelConfig,
    workspaceMayOverrideDefaultModel
  })
  await rig.restart({ modelCatalog })
  setStructuredAgentSessionHost(rig.host)
  rig.adapter.acquire.mockClear()
}

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  setStructuredAgentSessionHost(rig.host)
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getClientSettings').mockImplementation(
    () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC gate reads only this one setting.
      ({ experimentalNativeChat: true }) as ReturnType<OrcaRuntimeService['getClientSettings']>
  )
  dispatcher = new RpcDispatcher({ runtime, methods: STRUCTURED_AGENT_SESSION_METHODS })
})

afterEach(async () => {
  vi.restoreAllMocks()
  setStructuredAgentSessionHost(null)
  await rig.dispose()
})

describe('options at rest in a repo whose config may pick the model', () => {
  it('keeps the account default model, with no effort, for a client that needs a model', async () => {
    await chatAtRest({ configured: true })

    const reply = await readOptions(OLDER_CLIENT)

    expect(reply).toMatchObject({
      ok: true,
      result: { current: { model: 'gpt-5.5' }, conversationCommands: ['clear'] }
    })
    expect(reply).not.toHaveProperty('result.current.effort')
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it('names no model or effort for a client that takes an answer without one', async () => {
    await chatAtRest({ configured: true })

    const reply = await readOptions(CURRENT_CLIENT)

    expect(reply).toMatchObject({ ok: true, result: { conversationCommands: ['clear'] } })
    expect(reply).not.toHaveProperty('result.current.model')
    expect(reply).not.toHaveProperty('result.current.effort')
  })
})

describe('options at rest in a repo with no config of its own', () => {
  it('names the default model and its effort for a client that needs a model', async () => {
    await chatAtRest({ configured: false })

    expect(await readOptions(OLDER_CLIENT)).toMatchObject({
      ok: true,
      result: { current: { model: 'gpt-5.5', effort: 'medium' } }
    })
  })
})
