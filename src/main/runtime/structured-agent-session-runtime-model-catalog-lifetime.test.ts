import { hostTestCatalogReadOperation } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import type * as CatalogService from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import type * as ShellEnvironment from './structured-agent-shell-environment'
import * as registry from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const catalog = vi.hoisted((): { service: AgentModelCatalogService | null } => ({ service: null }))
const environmentReleases = vi.hoisted(() => vi.fn())

vi.mock('./structured-agent-shell-environment', async (importOriginal) => {
  const real = await importOriginal<typeof ShellEnvironment>()
  return {
    ...real,
    createStructuredAgentEnvironmentResolvers: (
      ...args: Parameters<typeof real.createStructuredAgentEnvironmentResolvers>
    ) => {
      const environment = real.createStructuredAgentEnvironmentResolvers(...args)
      return {
        ...environment,
        bindCatalogSources: (agents: readonly string[]) => {
          const release = environment.bindCatalogSources(agents)
          return () => {
            release()
            environmentReleases(agents)
          }
        }
      }
    }
  }
})

vi.mock(
  '../native-chat/agent-model-catalog/agent-model-catalog-service',
  async (importOriginal) => {
    const real = await importOriginal<typeof CatalogService>()
    return {
      ...real,
      createAgentModelCatalogService: (
        ...args: Parameters<typeof real.createAgentModelCatalogService>
      ) => catalog.service ?? real.createAgentModelCatalogService(...args)
    }
  }
)

let root: string

beforeEach(async () => {
  environmentReleases.mockClear()
  root = await mkdtemp(join(tmpdir(), 'orca-structured-catalog-lifetime-'))
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  catalog.service = null
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('the host catalog lifetime', () => {
  it('prewarms once the host is installed and stops its listings at teardown', async () => {
    const service = {
      captureRead: hostTestCatalogReadOperation,
      snapshot: vi.fn(() => ({ origin: 'unknown' as const })),
      demand: vi.fn(async () => {}),
      prepareSaved: vi.fn(async () => ({ origin: 'unknown' as const })),
      captureSource: () => () => true,
      retireContext: vi.fn(),
      peek: () => null,
      read: vi.fn(async () => ({ origin: 'unknown' as const })),
      recordLiveListing: vi.fn(),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted: vi.fn()
    }
    catalog.service = service
    await ensureStructuredAgentSessionHost({
      logger: createStructuredAgentSessionLogger(),
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root,
      resolveEnvironment: async () => ({}),
      resolveAgentAccountHome: async () => ({ variable: 'HOME', path: root }),
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' as const })
    })
    expect(service.prewarm).toHaveBeenCalledOnce()
    expect(service.stop).not.toHaveBeenCalled()
    expect(environmentReleases).not.toHaveBeenCalled()

    await stopStructuredAgentSessionRuntime()
    expect(service.stop).toHaveBeenCalledOnce()
    expect(environmentReleases).toHaveBeenCalledOnce()
  })

  it('retains the independent environment after failed host publication and releases it at runtime stop', async () => {
    vi.spyOn(registry, 'setStructuredAgentSessionHost').mockImplementationOnce(() => {
      throw new Error('installation publication failed')
    })
    await expect(
      ensureStructuredAgentSessionHost({
        logger: createStructuredAgentSessionLogger(),
        stateDirectory: root,
        hostId: 'local',
        claimKeyId: 'key-1',
        resolveWorkspacePath: async () => root,
        resolveEnvironment: async () => ({}),
        resolveLaunchArgs: () => [],
        resolveClaudeAuthPolicy: () => ({ account: 'managed' as const })
      })
    ).rejects.toThrow('installation publication failed')
    expect(environmentReleases).not.toHaveBeenCalled()
    await stopStructuredAgentSessionRuntime()
    expect(environmentReleases).toHaveBeenCalledOnce()
  })
})
