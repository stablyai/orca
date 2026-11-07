import type * as ProfilePaths from '../../../orca-profiles/profile-storage-paths'
import '../../rpc/unused-default-rpc-methods.test-fixture'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as registry from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import * as environment from '../environment/structured-agent-shell-environment'
import type { ProviderProcessLaunch } from '../../../provider-process/provider-process-launch'
import * as pi from '../../../pi/rpc-model-catalog-probe'
import { ensureStructuredAgentModelCatalogOwner } from './structured-agent-model-catalog-wiring'
import { stopStructuredAgentSessionRuntime } from '../structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'

const profile = vi.hoisted(() => ({ root: '' }))
vi.mock('../../../orca-profiles/profile-storage-paths', async (importOriginal) => ({
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
