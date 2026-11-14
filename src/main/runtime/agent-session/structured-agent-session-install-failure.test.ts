// Failed host installation reuses the record-store slot's open journal connection; launch admission may already hold it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JournalHostDatabase } from '../../native-chat/agent-session-journal/database/journal-host-database'
import type * as ModelCatalogWiring from './model-catalog/structured-agent-model-catalog-wiring'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import type { StructuredAgentSessionRuntimeDeps } from './installation/structured-agent-session-runtime-contract'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'

const mocks = vi.hoisted(() => ({ failWiring: vi.fn(() => false) }))

// The last step before the host is built: a throw here comes after both stores opened.
vi.mock('./model-catalog/structured-agent-model-catalog-wiring', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelCatalogWiring>()
  return {
    ...actual,
    ensureStructuredAgentModelCatalogOwner: async (
      ...args: Parameters<typeof actual.ensureStructuredAgentModelCatalogOwner>
    ) => {
      const owner = await actual.ensureStructuredAgentModelCatalogOwner(...args)
      return {
        ...owner,
        attach: (...access: Parameters<typeof owner.attach>) => {
          if (mocks.failWiring()) {
            throw new Error('model catalog wiring failed')
          }
          return owner.attach(...access)
        }
      }
    }
  }
})

let root: string

function install(
  createTurnAttention?: StructuredAgentSessionRuntimeDeps['createTurnAttention']
): ReturnType<typeof ensureStructuredAgentSessionHost> {
  return ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    createTurnAttention,
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveEnvironment: async () => ({}),
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' })
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-structured-install-failure-'))
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('an install that fails after opening the chat journal', () => {
  it('keeps the one connection it opened, and the next install builds on it', async () => {
    const open = vi.spyOn(JournalHostDatabase, 'open')
    mocks.failWiring.mockReturnValueOnce(true)

    await expect(install()).rejects.toThrow('model catalog wiring failed')
    const opened = await open.mock.results[0]?.value
    expect(opened).toBeInstanceOf(JournalHostDatabase)
    expect(opened.isClosed).toBe(false)

    await expect(install()).resolves.toBeDefined()
    expect(open).toHaveBeenCalledOnce()
    expect(opened.isClosed).toBe(false)

    await stopStructuredAgentSessionRuntime()
    expect(opened.isClosed).toBe(true)
  })
  it('retries when acquiring the turn-attention owner throws', async () => {
    await expect(
      install(() => {
        throw new Error('attention acquisition failed')
      })
    ).rejects.toThrow('attention acquisition failed')
    await expect(install()).resolves.toBeDefined()
  })
})
