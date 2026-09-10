import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeHttp from 'node:http'

const { createServerMock, getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  createServerMock: vi.fn(),
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeHttp>()
  createServerMock.mockImplementation(actual.createServer)
  return { ...actual, createServer: createServerMock }
})

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

import { AgentHookServer, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE = makePaneKey('tab-lifecycle', '11111111-1111-4111-8111-111111111111')

beforeEach(() => {
  _internals.resetCachesForTests()
  createServerMock.mockClear()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentHookServer startup failure lifecycle', () => {
  it('cleans a failed hydrated start, retries, publishes hook env, and stops repeatedly', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-hook-start-failure-'))
    const persisted = new AgentHookServer()
    await persisted.start({ env: 'production', userDataPath })
    persisted.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-lifecycle',
        worktreeId: 'wt-lifecycle',
        payload: { state: 'working', prompt: 'surviving PTY', agentType: 'codex' }
      },
      'ssh-lifecycle'
    )
    persisted.stop()

    try {
      let startupErrorListener: ((error: Error) => void) | null = null
      const failedServer = {
        once: vi.fn((event: string, listener: (error: Error) => void) => {
          if (event === 'error') {
            startupErrorListener = listener
          }
          return failedServer
        }),
        off: vi.fn(() => failedServer),
        listen: vi.fn(() => {
          startupErrorListener?.(new Error('listener unavailable'))
          return failedServer
        }),
        close: vi.fn(() => failedServer)
      }
      createServerMock.mockImplementationOnce(() => failedServer)

      const server = new AgentHookServer()
      await expect(server.start({ env: 'production', userDataPath })).rejects.toThrow(
        'listener unavailable'
      )
      expect(failedServer.close).toHaveBeenCalledOnce()
      expect(server.buildPtyEnv()).toEqual({})
      expect(server.getStatusSnapshot()).toEqual([])

      await server.start({ env: 'production', userDataPath })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, worktreeId: 'wt-lifecycle' })
      ])
      expect(server.buildPtyEnv()).toMatchObject({
        ORCA_AGENT_HOOK_ENV: 'production',
        ORCA_AGENT_HOOK_PORT: expect.any(String),
        ORCA_AGENT_HOOK_TOKEN: expect.any(String),
        ORCA_AGENT_HOOK_ENDPOINT: server.endpointFilePath
      })

      server.stop()
      server.stop()
      expect(server.buildPtyEnv()).toEqual({})
      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      persisted.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
