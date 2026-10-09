// An install that fails after it opened the chat journal leaves that one connection to the record
// store slot, which launch admission may already be using, and the next install builds on it: the
// process never holds a second connection.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type * as ModelCatalogWiring from './structured-agent-model-catalog-wiring'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const mocks = vi.hoisted(() => ({ failWiring: vi.fn(() => false) }))

// The last step before the host is built: a throw here comes after both stores opened.
vi.mock('./structured-agent-model-catalog-wiring', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelCatalogWiring>()
  return {
    ...actual,
    modelCatalogHostDeps: async (input: Parameters<typeof actual.modelCatalogHostDeps>[0]) => {
      if (mocks.failWiring()) {
        throw new Error('model catalog wiring failed')
      }
      return actual.modelCatalogHostDeps(input)
    }
  }
})

let root: string

function install(): ReturnType<typeof ensureStructuredAgentSessionHost> {
  return ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
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
})
