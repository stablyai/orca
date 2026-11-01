import type * as ProfilePaths from '../orca-profiles/profile-storage-paths'
import './rpc/unused-default-rpc-methods.test-fixture'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS } from './rpc/methods/structured-agent-session-options-read'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../ipc/desktop-renderer-runtime-capabilities'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from './structured-agent-runtime-registrations'
import * as recordStore from './agent-session-record-store-slot'
import * as registry from '../native-chat/agent-session-wire/structured-agent-session-registry'
import * as catalogService from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import * as environment from './structured-agent-shell-environment'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import * as pi from '../pi/rpc-model-catalog-probe'
import {
  ensureStructuredAgentModelCatalogOwner,
  prewarmStructuredAgentModelCatalogs
} from './structured-agent-model-catalog-wiring'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const profile = vi.hoisted(() => ({ root: '' }))
vi.mock('../orca-profiles/profile-storage-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfilePaths>()),
  getProfileUserDataPath: () => profile.root
}))
let root: string
let releases: ReturnType<typeof vi.fn<() => void>>
const installedDeps = () => ({
  stateDirectory: root,
  hostId: 'local',
  claimKeyId: 'catalog-test',
  logger: createStructuredAgentSessionLogger(),
  resolveWorkspacePath: async () => root,
  resolveLaunchArgs: () => [],
  resolveClaudeAuthPolicy: () => ({ account: 'system' as const }),
  resolveEnvironment: async () => ({}),
  resolveAgentAccountHome: async () => ({ variable: 'PI_CODING_AGENT_DIR', path: join(root, 'pi') })
})
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-catalog-owner-'))
  profile.root = root
  releases = vi.fn()
  const create = environment.createStructuredAgentEnvironmentResolvers
  vi.spyOn(environment, 'createStructuredAgentEnvironmentResolvers').mockImplementation(
    (sources) => {
      const resolvers = create({
        ...sources,
        resolveEnvironment: async () => ({ PATH: '/usr/bin' })
      })
      return {
        ...resolvers,
        bindCatalogSources: (agents) => {
          const release = resolvers.bindCatalogSources(agents)
          return () => {
            release()
            releases()
          }
        }
      }
    }
  )
})
afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

function nativeProbe(
  options: { request?: (command: string) => Promise<unknown>; close?: () => Promise<void> } = {}
) {
  const close = vi.fn(options.close ?? (async () => {}))
  const create = pi.createPiModelCatalogProbe
  const responses = readFileSync('src/main/pi/__fixtures__/command-only.jsonl', 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const row = z.object({ raw: z.string() }).parse(JSON.parse(line))
      return z
        .object({ command: z.string().optional(), data: z.unknown().optional() })
        .parse(JSON.parse(row.raw))
    })
  const request = vi.fn(
    options.request ??
      (async (command: string) => responses.find((row) => row.command === command)?.data)
  )
  const connect = vi.fn((_launch: ProviderProcessLaunch) => ({ request, close }))
  vi.spyOn(pi, 'createPiModelCatalogProbe').mockImplementation((deps) =>
    create({
      ...deps,
      resolveCommand: () => '/fixture/pi',
      probeVersion: async () => ({ version: '0.84.0' }),
      homePath: root,
      connect
    })
  )
  return { request, close, connect }
}

it('serves concurrent fresh recordless RPCs through real runtime dependencies, service and native Pi mapper without journal/host/adapters', async () => {
  const native = nativeProbe()
  const adapters = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map((registration) =>
    vi.spyOn(registration, 'createAdapter')
  )
  prewarmStructuredAgentModelCatalogs()
  expect(environment.createStructuredAgentEnvironmentResolvers).not.toHaveBeenCalled()
  const open = vi.spyOn(recordStore, 'openAgentSessionRecordStoreOnce')
  const runtime = new OrcaRuntimeService()
  const install = vi.spyOn(runtime, 'ensureStructuredAgentSessionHost')
  Object.assign(runtime, {
    requireStore: () => ({
      getSettings: () => ({
        nativeChatProviders: { pi: true },
        agentCmdOverrides: { pi: 'pi --catalog-fixture' }
      })
    }),
    resolveStructuredAgentAccountHome: async () => ({
      variable: 'PI_CODING_AGENT_DIR',
      path: join(root, 'pi')
    })
  })
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS
  })
  const replies: unknown[] = []
  const read = (clientCapabilities = DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES) =>
    dispatcher.dispatchStreaming(
      {
        id: 'catalog',
        authToken: 'token',
        method: 'agentSession.modelCatalog',
        params: { agent: 'pi', waitForListing: true }
      },
      (raw) => replies.push(JSON.parse(raw)),
      { clientId: 'picker', clientKind: 'runtime', clientCapabilities }
    )
  await read([])
  expect(replies.pop()).toMatchObject({ ok: false })
  expect(environment.createStructuredAgentEnvironmentResolvers).not.toHaveBeenCalled()
  await Promise.all([read(), read()])
  expect(replies).toHaveLength(2)
  for (const reply of replies) {
    expect(reply).toMatchObject({
      ok: true,
      result: {
        origin: 'probe',
        models: [
          { id: 'openai-codex/gpt-5.3-codex-spark' },
          { id: 'openai-codex/gpt-5.5', label: 'GPT-5.5' },
          { id: 'openai-codex/gpt-5.6-luna' },
          { id: 'openai-codex/gpt-5.6-sol' },
          { id: 'openai-codex/gpt-5.6-terra' },
          { id: 'openai-codex/gpt-6-astra' },
          { id: 'openai-codex/gpt-6-luna' },
          { id: 'openai-codex/gpt-6-sol' },
          { id: 'openai-codex/gpt-6.1-sol' }
        ]
      }
    })
  }
  expect(native.connect).toHaveBeenCalledOnce()
  expect(native.connect.mock.calls[0]?.[0]).toMatchObject({
    args: expect.arrayContaining(['--catalog-fixture', '--no-session']),
    env: { PI_CODING_AGENT_DIR: join(root, 'pi') }
  })
  expect(native.request.mock.calls.map(([command]) => command)).toEqual([
    'get_state',
    'get_available_models'
  ])
  expect(native.close).toHaveBeenCalledOnce()
  expect(open).not.toHaveBeenCalled()
  expect(install).not.toHaveBeenCalled()
  for (const adapter of adapters) {
    expect(adapter).not.toHaveBeenCalled()
  }
  expect(registry.getStructuredAgentSessionHost()).toBeNull()
  expect(environment.createStructuredAgentEnvironmentResolvers).toHaveBeenCalledOnce()
  await stopStructuredAgentSessionRuntime()
  expect(releases).toHaveBeenCalledOnce()
})

it('joins host construction to the same owner/environment, retains it after failed publication, and retries attachment', async () => {
  nativeProbe()
  const deps = installedDeps()
  const factory = vi.spyOn(catalogService, 'createAgentModelCatalogService')
  const acquiring = ensureStructuredAgentModelCatalogOwner(deps)
  const joining = ensureStructuredAgentModelCatalogOwner(deps)
  vi.spyOn(registry, 'setStructuredAgentSessionHost').mockImplementationOnce(() => {
    throw new Error('publication failed')
  })
  const failedInstall = expect(ensureStructuredAgentSessionHost(deps)).rejects.toThrow(
    'publication failed'
  )
  const [owner, same] = await Promise.all([acquiring, joining])
  expect(owner).toBe(same)
  const prewarm = vi.spyOn(owner.modelCatalog!, 'prewarm')
  await failedInstall
  expect(releases).not.toHaveBeenCalled()
  const host = await ensureStructuredAgentSessionHost(deps)
  expect(host.deps.modelCatalog).toBe(owner.modelCatalog)
  const source = factory.mock.calls[0][0]
  const recordRead = vi.spyOn(host.deps.store, 'getRecord')
  const liveRead = vi.spyOn(host, 'childAccountHome')
  const detachOld = owner.attach({ store: host.deps.store, host })
  const detachCurrent = owner.attach({ store: host.deps.store, host })
  detachOld()
  source.getRecord('missing')
  source.liveAccountHome?.('missing')
  expect(recordRead).toHaveBeenCalledOnce()
  expect(liveRead).toHaveBeenCalledOnce()
  detachCurrent()
  source.getRecord('missing')
  source.liveAccountHome?.('missing')
  expect(recordRead).toHaveBeenCalledOnce()
  expect(liveRead).toHaveBeenCalledOnce()
  expect(prewarm).toHaveBeenCalledTimes(2)
  expect(environment.createStructuredAgentEnvironmentResolvers).toHaveBeenCalledOnce()
  await stopStructuredAgentSessionRuntime()
  expect(releases).toHaveBeenCalledOnce()
  expect(await owner.modelCatalog!.read({ agent: 'pi' })).toEqual({ origin: 'unknown' })
})

it('releases partial construction and retries, while shutdown fences initialization from resurrection', async () => {
  const create = pi.createPiModelCatalogProbe
  vi.spyOn(pi, 'createPiModelCatalogProbe')
    .mockImplementationOnce(() => {
      throw new Error('construction failed')
    })
    .mockImplementation(create)
  await expect(ensureStructuredAgentModelCatalogOwner(installedDeps())).rejects.toThrow(
    'construction failed'
  )
  expect(releases).toHaveBeenCalledOnce()
  const initializing = ensureStructuredAgentModelCatalogOwner(installedDeps())
  const stopped = stopStructuredAgentSessionRuntime()
  await expect(initializing).rejects.toThrow('catalog runtime stopped during construction')
  await stopped
  expect(releases).toHaveBeenCalledTimes(2)
  const next = await ensureStructuredAgentModelCatalogOwner(installedDeps())
  expect(next.modelCatalog).toBeDefined()
  expect(environment.createStructuredAgentEnvironmentResolvers).toHaveBeenCalledTimes(3)
})

it('never-host shutdown aborts and drains actual native probe close before returning', async () => {
  const requested = Promise.withResolvers<void>(),
    closing = Promise.withResolvers<void>(),
    drained = Promise.withResolvers<void>()
  const native = nativeProbe({
    request: async () => {
      requested.resolve()
      return new Promise<never>(() => {})
    },
    close: async () => {
      closing.resolve()
      await drained.promise
    }
  })
  const owner = await ensureStructuredAgentModelCatalogOwner(installedDeps())
  const demand = owner.modelCatalog!.demand({ agent: 'pi' })
  await requested.promise
  let stopped = false
  const stop = stopStructuredAgentSessionRuntime().then(() => {
    stopped = true
  })
  try {
    await closing.promise
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(native.close).toHaveBeenCalledOnce()
    expect(registry.getStructuredAgentSessionHost()).toBeNull()
  } finally {
    drained.resolve()
    await stop
    await demand
  }
  expect(stopped).toBe(true)
  expect(releases).toHaveBeenCalledOnce()
})
