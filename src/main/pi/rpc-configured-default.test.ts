// Pi's `--list-models` names no model it runs by default, so a new Pi chat with no saved pick showed
// "Model" and then whatever its session started on. Through the real Pi probe, adapter and catalog
// host, a chat started with no pick teaches the host the account's default for the next new chat.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionModelCatalogResult } from '../../shared/agent-session-wire'
import { structuredAgentSessionSeedCatalog } from '../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  agentReadsProjectModelConfig,
  workspaceMayOverrideDefaultModel
} from '../native-chat/agent-model-catalog/agent-project-model-override'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { agentModelCatalogFingerprint } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { createPiModelCatalogProbe, piModelCatalogFromListing } from './rpc-model-catalog-probe'
import type { PiRpcConnection } from './rpc-session'
import { PiRpcSessionAdapter } from './rpc-session-adapter'

const PI_HOME = { variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi' }
// What `pi --list-models` prints: the first row is not the model Pi starts on.
const LISTING = [
  'provider   model            context  max-out  thinking  images',
  'anthropic  claude-sonnet-4  200K     64K      yes       yes',
  'openai     gpt-6            400K     128K     yes       yes'
].join('\n')
const AVAILABLE = [
  { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4', reasoning: true },
  // Its thinking map adds xhigh, which `--list-models` never shows.
  {
    provider: 'openai',
    id: 'gpt-6',
    name: 'GPT-6',
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh' }
  }
]
const RUNS = AVAILABLE[1]!

let root: string
const adapters: PiRpcSessionAdapter[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-pi-configured-default-'))
})
afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    await adapter.closeAll()
  }
  rmSync(root, { recursive: true, force: true })
  await closeProviderTimelineRigs()
})

function workspace(name: string, files: Record<string, string> = {}): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere')
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

type PiChild = { connection: PiRpcConnection; switchTo: (modelId: string) => void }

/** A Pi child that starts on GPT-6 at `thinking`; a signed-out one lists no model. `switchTo` is
 *  a switch Orca didn't send, as an extension's `setModel` makes. */
function piChild(available: readonly object[], thinking: string): PiChild {
  let model: object | null = RUNS
  const switchTo = (modelId: string): void => {
    model = AVAILABLE.find((entry) => entry.id === modelId) ?? model
  }
  const connection: PiRpcConnection = {
    pid: 4123,
    closed: false,
    rootVerdict: 'live',
    processless: false,
    lastCloseResult: null,
    request: async (command: string, params?: Record<string, unknown>) => {
      if (command === 'get_state') {
        return {
          sessionFile: '/homes/pi/sessions/one.jsonl',
          isStreaming: false,
          isCompacting: false,
          model,
          thinkingLevel: thinking
        }
      }
      if (command === 'get_available_models') {
        return { models: available }
      }
      if (command === 'set_model') {
        switchTo(String(params?.modelId))
      }
      return command === 'get_commands' ? { commands: [] } : {}
    },
    send: async () => {},
    close: async () => ({ root: 'exited', tree: 'exited' }),
    pauseReading: () => {},
    resumeReading: () => {},
    onExit: () => {}
  }
  return { connection, switchTo }
}

type ChatOptions = {
  saved?: Record<string, string>
  resumed?: boolean
  forked?: boolean
  available?: object[]
  thinking?: string
  /** What happens between the chat's start and the pane's options read. */
  afterStart?: (chat: {
    child: PiChild
    adapter: PiRpcSessionAdapter
    sessionId: string
  }) => Promise<void>
}

/** A host with Pi's real probe and catalog service, and one Pi chat in `workspacePath`. */
async function piHost() {
  const records = new Map<string, AgentSessionRecord>()
  const clock = { now: 1_000 }
  const store = new AgentModelCatalogStore({ now: () => clock.now })
  const catalog = createAgentModelCatalogService({
    store,
    getRecord: (sessionId) => records.get(sessionId),
    drivesRecord: () => true,
    resolveAccountHome: async () => PI_HOME,
    recordWorkspacePath: async (row) => row.launchDirectory ?? null,
    agentReadsProjectModelConfig,
    workspaceMayOverrideDefaultModel,
    probes: {
      pi: createPiModelCatalogProbe({
        resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
        resolveCommand: () => '/opt/pi/bin/pi',
        probeVersion: async () => true,
        homePath: '/home/user',
        runListing: async () => LISTING
      })
    }
  })

  let chats = 0
  /** A Pi chat in `workspacePath` whose options the pane reads once, as the host's step does. */
  async function chat(workspacePath: string, opts: ChatOptions = {}) {
    const sessionId = `pi-${++chats}`
    let child: PiChild | undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the catalog service reads only these fields.
    records.set(sessionId, {
      sessionId,
      provider: 'pi',
      accountHome: PI_HOME,
      launchDirectory: workspacePath,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'ws-1',
        workspaceKind: 'git-worktree'
      }
    } as AgentSessionRecord)
    const rig = await openProviderTimelineRig({ agent: 'pi', sessionId })
    const adapter = new PiRpcSessionAdapter({
      resolveLaunch: async () => ({
        command: '/opt/pi/bin/pi',
        cwd: workspacePath,
        fullAccess: true,
        previous: null,
        ...(opts.resumed ? { sessionFile: '/homes/pi/sessions/one.jsonl' } : {}),
        ...(opts.forked ? { forkFile: '/homes/pi/sessions/elsewhere.jsonl' } : {})
      }),
      readProcessStartTime: async () => 1,
      openConnection: () => {
        child = piChild(opts.available ?? AVAILABLE, opts.thinking ?? 'high')
        return child.connection
      },
      onLifecycle: vi.fn(),
      onSettled: vi.fn(),
      onIdle: vi.fn(),
      logger: { warn: vi.fn(), error: vi.fn() }
    })
    adapters.push(adapter)
    await adapter.acquire({
      identity: {
        sessionId,
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'pi',
        providerHandle: null
      },
      fence: 1,
      spawnToken: 'spawn-token',
      options: opts.saved ?? {},
      events: rig.eventSink
    })
    if (opts.afterStart && child) {
      await opts.afterStart({ child, adapter, sessionId })
    }
    const { catalogListing } = await adapter.readOptions({ sessionId, fence: 1 })
    if (!catalogListing) {
      throw new Error('a Pi options read hands the host its listing')
    }
    catalog.recordLiveListing(sessionId, catalogListing)
    return catalogListing
  }
  return { catalog, chat, store, clock }
}

/** What a new Pi chat's composer paints first from a host answer. */
function firstFrame(answer: AgentSessionModelCatalogResult) {
  const seed = structuredAgentSessionSeedCatalog('pi')
  const state = applyStructuredAgentSessionModelCatalog(
    createStructuredAgentSessionOptionState('pi', seed),
    seed,
    answer,
    { newLaunch: true }
  )
  const snapshot = structuredAgentSessionOptionSnapshot(state)
  const select = (id: string) => {
    const entry = snapshot.find((descriptor) => descriptor.id === id)
    return entry?.kind.type === 'select' ? (entry.kind.currentValue ?? null) : null
  }
  return { model: select('model'), effort: select('effort') }
}

const NOTHING = { model: null, effort: null }

describe('Pi’s default comes from what a chat with no pick runs', () => {
  it('names no model from the listing, then the model and thinking level a no-pick chat ran', async () => {
    const { catalog, chat } = await piHost()
    const clean = workspace('clean')
    const listed = await catalog.read({ agent: 'pi', workspacePath: clean, waitForListing: true })
    expect(listed).toMatchObject({ origin: 'probe', listingNamesConfiguredModel: false })
    expect(firstFrame(listed)).toEqual(NOTHING)

    await chat(clean)
    // The next new chat, in this workspace or another whose config picks nothing.
    for (const path of [clean, workspace('other')]) {
      const answer = await catalog.read({ agent: 'pi', workspacePath: path })
      expect(answer).toMatchObject({ listingNamesConfiguredModel: true })
      expect(answer).not.toHaveProperty('defaultHoldsInEveryWorkspace')
      expect(firstFrame(answer)).toEqual({ model: 'openai/gpt-6', effort: 'high' })
    }
  })

  it('keeps the placeholder in a workspace whose Pi settings pick the model', async () => {
    const { catalog, chat } = await piHost()
    await chat(workspace('clean'))
    const configured = workspace('configured', {
      '.pi/settings.json': '{"defaultProvider":"anthropic","defaultModel":"claude-sonnet-4"}'
    })
    expect(firstFrame(await catalog.read({ agent: 'pi', workspacePath: configured }))).toEqual(
      NOTHING
    )
  })

  it('learns nothing from a chat whose workspace picks its model', async () => {
    const { catalog, chat } = await piHost()
    await catalog.read({ agent: 'pi', waitForListing: true })
    await chat(workspace('configured', { '.pi/extensions/pick.ts': 'export default () => {}\n' }))
    expect(
      firstFrame(await catalog.read({ agent: 'pi', workspacePath: workspace('clean') }))
    ).toEqual(NOTHING)
  })

  it('learns nothing from a chat that restored a pick or resumed a conversation', async () => {
    const { catalog, chat } = await piHost()
    await catalog.read({ agent: 'pi', waitForListing: true })
    const clean = workspace('clean')
    expect(await chat(clean, { saved: { model: 'openai/gpt-6' } })).not.toHaveProperty(
      'configuredDefault'
    )
    expect(await chat(clean, { resumed: true })).not.toHaveProperty('configuredDefault')
    expect(firstFrame(await catalog.read({ agent: 'pi', workspacePath: clean }))).toEqual(NOTHING)
  })

  it('saves no default from a signed-out Pi, which lists no model', async () => {
    const { catalog, chat } = await piHost()
    const clean = workspace('clean')
    await catalog.read({ agent: 'pi', waitForListing: true })
    expect(await chat(clean, { available: [] })).not.toHaveProperty('configuredDefault')
    expect(firstFrame(await catalog.read({ agent: 'pi', workspacePath: clean }))).toEqual(NOTHING)

    // Nor does it forget one a signed-in chat taught.
    await chat(clean)
    await chat(clean, { available: [] })
    expect(firstFrame(await catalog.read({ agent: 'pi', workspacePath: clean }))).toEqual({
      model: 'openai/gpt-6',
      effort: 'high'
    })
  })

  it('teaches the model the chat started on, not one an extension switched to later', async () => {
    const { catalog, chat } = await piHost()
    const clean = workspace('clean')
    await catalog.read({ agent: 'pi', waitForListing: true })
    await chat(clean, { afterStart: async ({ child }) => child.switchTo('claude-sonnet-4') })
    expect(firstFrame(await catalog.read({ agent: 'pi', workspacePath: clean }))).toEqual({
      model: 'openai/gpt-6',
      effort: 'high'
    })
  })

  it('teaches the start model after a pick made in the chat, never the pick', async () => {
    const { catalog, chat } = await piHost()
    const clean = workspace('clean')
    await catalog.read({ agent: 'pi', waitForListing: true })
    await chat(clean, {
      afterStart: async ({ adapter, sessionId }) => {
        await adapter.setOption({
          sessionId,
          fence: 1,
          key: 'model',
          value: 'anthropic/claude-sonnet-4'
        })
      }
    })
    expect(firstFrame(await catalog.read({ agent: 'pi', workspacePath: clean }))).toEqual({
      model: 'openai/gpt-6',
      effort: 'high'
    })
  })

  it('learns nothing from a chat forked from a conversation in another folder', async () => {
    const { catalog, chat } = await piHost()
    await catalog.read({ agent: 'pi', waitForListing: true })
    const clean = workspace('clean')
    expect(await chat(clean, { forked: true })).not.toHaveProperty('configuredDefault')
    expect(firstFrame(await catalog.read({ agent: 'pi', workspacePath: clean }))).toEqual(NOTHING)
  })

  it('keeps a learned thinking level only the chat’s menu offers when a later listing is newer', async () => {
    const { catalog, chat, store, clock } = await piHost()
    const clean = workspace('clean')
    await chat(clean, { thinking: 'xhigh' })
    // A background re-list after the chat: `--list-models` offers no xhigh.
    clock.now = 2_000
    store.recordSuccess(
      agentModelCatalogFingerprint({ agent: 'pi', accountHome: PI_HOME, wslDistro: null }),
      'pi',
      {
        models: piModelCatalogFromListing(LISTING),
        fastModeTierByModel: new Map(),
        origin: 'probe'
      },
      'discovery'
    )
    expect(firstFrame(await catalog.read({ agent: 'pi', workspacePath: clean }))).toEqual({
      model: 'openai/gpt-6',
      effort: 'xhigh'
    })
  })
})
