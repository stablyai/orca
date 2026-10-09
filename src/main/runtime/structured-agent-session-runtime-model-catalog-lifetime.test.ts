// The host's catalog listings live exactly as long as the host: installing it starts the
// runtime-start prewarm, and tearing it down (which quit does too) stops every listing it started.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import type * as ModelCatalogWiring from './structured-agent-model-catalog-wiring'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const catalog = vi.hoisted((): { service: AgentModelCatalogService | null } => ({ service: null }))

vi.mock('./structured-agent-model-catalog-wiring', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelCatalogWiring>()),
  modelCatalogHostDeps: async () => (catalog.service ? { modelCatalog: catalog.service } : {})
}))

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-structured-catalog-lifetime-'))
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  catalog.service = null
  await rm(root, { recursive: true, force: true })
})

describe('the host catalog lifetime', () => {
  it('prewarms once the host is installed and stops its listings at teardown', async () => {
    const service = {
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
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true })
    })
    expect(service.prewarm).toHaveBeenCalledOnce()
    expect(service.stop).not.toHaveBeenCalled()

    await stopStructuredAgentSessionRuntime()
    expect(service.stop).toHaveBeenCalledOnce()
  })
})
