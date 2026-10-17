import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
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

/** A Pi child that starts on `startsOn` at `thinking`; a signed-out one lists no model. `switchTo`
 *  is a switch Orca didn't send, as an extension's `setModel` makes. */
function piChild(available: readonly object[], thinking: string, startsOn: string): PiChild {
  let model: object | null = AVAILABLE.find((entry) => entry.id === startsOn) ?? RUNS
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
  /** A new Pi session standing in for one whose saved file was gone. */
  replacement?: boolean
  available?: object[]
  thinking?: string
  startsOn?: string
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
    processScope: (sessionId) => (records.has(sessionId) ? `${sessionId}:1` : null),
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
  /** A Pi chat in `workspacePath`: the host saves what its start listed, then the pane reads its
   *  options once, and the host saves each read's listing too. */
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
        ...(opts.forked ? { forkFile: '/homes/pi/sessions/elsewhere.jsonl' } : {}),
        ...(opts.replacement ? { replacement: 'unsaved' as const } : {})
      }),
      readProcessStartTime: async () => 1,
      openConnection: () => {
        child = piChild(opts.available ?? AVAILABLE, opts.thinking ?? 'high', opts.startsOn ?? '')
        return child.connection
      },
      onLifecycle: vi.fn(),
      onSettled: vi.fn(),
      onIdle: vi.fn(),
      logger: { warn: vi.fn(), error: vi.fn() }
    })
    adapters.push(adapter)
    const acquired = await adapter.acquire({
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
    if (!acquired.catalogListing) {
      throw new Error('a Pi start hands the host its listing')
    }
    await catalog.read({ agent: 'pi', sessionId, savedOnly: true })
    catalog.recordLiveListing(sessionId, acquired.catalogListing)
    if (opts.afterStart && child) {
      await opts.afterStart({ child, adapter, sessionId })
    }
    const read = async (): Promise<void> => {
      const { catalogListing } = await adapter.readOptions({ sessionId, fence: 1 })
      if (catalogListing) {
        catalog.recordLiveListing(sessionId, catalogListing)
      }
    }
    await read()
    return { sessionId, listing: acquired.catalogListing, read }
  }
  return { catalog, chat, store, clock }
}

describe('Pi process configuration metadata', () => {
  it('omits configured intent for restored, resumed, or forked chats', async () => {
    const { chat, catalog } = await piHost()
    const clean = workspace('clean')
    await chat(clean)
    for (const options of [
      { saved: { model: 'openai/gpt-6' } },
      { resumed: true },
      { forked: true }
    ]) {
      expect((await chat(clean, options)).listing).not.toHaveProperty('configuredDefault')
      expect(
        (await catalog.read({ agent: 'pi', workspacePath: clean, savedOnly: true })).choiceCatalog
      ).not.toHaveProperty('configured')
    }
    await chat(clean, { available: [AVAILABLE[0]!] })
    expect(
      (await catalog.read({ agent: 'pi', workspacePath: clean, savedOnly: true })).choiceCatalog
    ).not.toHaveProperty('configured')
  })

  it('retains the whole process effort menu when a coarse text probe arrives later', async () => {
    const { catalog, chat, store, clock } = await piHost()
    const clean = workspace('clean')
    const { sessionId } = await chat(clean, {
      thinking: 'xhigh',
      afterStart: async ({ adapter, sessionId }) => {
        await adapter.setOption({
          sessionId,
          fence: 1,
          key: 'model',
          value: 'anthropic/claude-sonnet-4'
        })
      }
    })
    const nextComposer = await catalog.read({ agent: 'pi', workspacePath: clean, savedOnly: true })
    expect(nextComposer.choiceCatalog?.configured).toEqual({
      model: 'openai/gpt-6',
      effort: 'xhigh'
    })
    const seed = structuredAgentSessionSeedCatalog('pi')
    const display = applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('pi', seed),
      seed,
      nextComposer,
      { newLaunch: true }
    )
    const snapshot = structuredAgentSessionOptionSnapshot(display)
    expect(snapshot.find((option) => option.id === 'model')?.kind).toMatchObject({
      currentValue: 'openai/gpt-6'
    })
    expect(snapshot.find((option) => option.id === 'effort')?.kind).toMatchObject({
      currentValue: 'xhigh'
    })
    expect(display.record).toEqual({ agent: 'pi', valuesByModel: {} })
    expect(
      nextComposer.choiceCatalog?.models
        .find((row) => row.id === 'openai/gpt-6')
        ?.efforts.map((effort) => effort.value)
    ).toContain('xhigh')
    const entry = catalog.peek(sessionId)!
    clock.now = 2_000
    store.recordSuccess(
      entry.fingerprint,
      'pi',
      {
        models: piModelCatalogFromListing(LISTING),
        origin: 'probe',
        advisory: true
      },
      'discovery'
    )
    expect(
      catalog
        .peek(sessionId)
        ?.models.find((row) => row.id === 'openai/gpt-6')
        ?.efforts.map((effort) => effort.value)
    ).toContain('xhigh')
    expect(
      catalog
        .processCatalog(sessionId)
        ?.models.find((row) => row.id === 'openai/gpt-6')
        ?.efforts.map((effort) => effort.value)
    ).toContain('xhigh')
  })

  it('reports only configured model intent when a thinking level was saved', async () => {
    const { chat } = await piHost()
    expect(
      (await chat(workspace('clean'), { saved: { effort: 'low' } })).listing.configuredDefault
    ).toEqual({ modelId: 'openai/gpt-6' })
  })

  it('reports configuration for a replacement process with no restored selection', async () => {
    const { chat } = await piHost()
    expect(
      (await chat(workspace('clean'), { replacement: true })).listing.configuredDefault
    ).toEqual({ modelId: 'openai/gpt-6', effort: 'high' })
  })
})
