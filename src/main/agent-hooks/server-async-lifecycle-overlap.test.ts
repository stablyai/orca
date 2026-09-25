import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeHttp from 'node:http'

const { createServerMock } = vi.hoisted(() => ({ createServerMock: vi.fn() }))
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeHttp>()
  createServerMock.mockImplementation(actual.createServer)
  return { ...actual, createServer: createServerMock }
})
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

import { AgentHookServer, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE = makePaneKey('tab-async-lifecycle', '11111111-1111-4111-8111-111111111111')

class LifecycleTestServer extends AgentHookServer {
  constructor() {
    super()
    this._setOpenCodeBinderDepsForTests({
      listSessions: () => [],
      listPanes: () => [],
      sweep: async () => []
    })
  }
}

describe('asynchronous hook listener lifecycle ordering', () => {
  let directory: string
  let server: LifecycleTestServer

  beforeEach(() => {
    _internals.resetCachesForTests()
    directory = mkdtempSync(join(tmpdir(), 'orca-hook-overlap-'))
    server = new LifecycleTestServer()
    createServerMock.mockClear()
  })

  afterEach(async () => {
    await server.stop()
    rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('flushes and clears owner state when stop joins a failing startup', async () => {
    const listening = Promise.withResolvers<void>()
    let failStartup: ((error: Error) => void) | undefined
    const failedServer = {
      once: vi.fn((event: string, listener: (error: Error) => void) => {
        if (event === 'error') failStartup = listener
        return failedServer
      }),
      off: vi.fn(() => failedServer),
      listen: vi.fn(() => {
        listening.resolve()
        return failedServer
      }),
      close: vi.fn(() => failedServer)
    }
    createServerMock.mockImplementationOnce(() => failedServer)
    const started = server.start({ env: 'production', userDataPath: directory })
    const rejected = expect(started).rejects.toThrow('bind failed after stop request')
    await listening.promise
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-async-lifecycle',
        worktreeId: 'worktree-async-lifecycle',
        payload: { state: 'working', prompt: 'persist before teardown', agentType: 'codex' }
      },
      'ssh-async-lifecycle'
    )
    expect(server.getStatusSnapshot()).toHaveLength(1)
    const stopped = server.stop()
    failStartup?.(new Error('bind failed after stop request'))
    await rejected
    await stopped
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.buildPtyEnv()).toEqual({})
    const persisted = JSON.parse(
      readFileSync(join(directory, 'agent-hooks', 'last-status.json'), 'utf8')
    )
    expect(persisted.entries[PANE].payload.prompt).toBe('persist before teardown')
    expect(failedServer.close).toHaveBeenCalledOnce()
  })

  it('restarts after a stop requested while the first start is pending', async () => {
    const options = { env: 'production', userDataPath: directory }
    const started = server.start(options)
    const stopped = server.stop()
    const restarted = server.start(options)
    await Promise.all([started, stopped, restarted])
    expect(server.buildPtyEnv()).toMatchObject({
      ORCA_AGENT_HOOK_PORT: expect.any(String),
      ORCA_AGENT_HOOK_TOKEN: expect.any(String)
    })
    expect(createServerMock).toHaveBeenCalledTimes(2)
  })

  it('honors a final stop queued behind a pending stop and restart', async () => {
    const options = { env: 'production', userDataPath: directory }
    await server.start(options)
    const stopped = server.stop()
    const restarted = server.start(options)
    const finalStop = server.stop()
    await Promise.all([stopped, restarted, finalStop])
    expect(server.buildPtyEnv()).toEqual({})
    expect(server.getStatusSnapshot()).toEqual([])
  })
})
