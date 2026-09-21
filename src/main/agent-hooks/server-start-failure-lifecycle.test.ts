import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  it('rolls back only transport on bind failure and preserves owner state through retry', async () => {
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
    const server = new AgentHookServer()
    const rendererListener = vi.fn()
    const statusChanges = vi.fn()
    const freshness = vi.fn()
    const enrichedStatuses = vi.fn()
    const rowMutations = vi.fn()
    server.setListener(rendererListener)
    server.subscribeStatusChanges(statusChanges)
    server.subscribeStatusFreshness(freshness)
    server.subscribeEnrichedStatus(enrichedStatuses)
    server.subscribeStatusRowMutations(rowMutations)

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

      await expect(server.start({ env: 'production', userDataPath })).rejects.toThrow(
        'listener unavailable'
      )
      expect(failedServer.close).toHaveBeenCalledOnce()
      expect(server.buildPtyEnv()).toEqual({})
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, prompt: 'surviving PTY' })
      ])

      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-lifecycle',
          worktreeId: 'wt-lifecycle',
          payload: { state: 'working', prompt: 'newer in-process state', agentType: 'codex' }
        },
        'ssh-lifecycle'
      )
      const duplicateOsc = {
        paneKey: PANE,
        tabId: 'tab-lifecycle',
        worktreeId: 'wt-lifecycle',
        connectionId: 'ssh-lifecycle',
        payload: { state: 'working' as const, prompt: 'newer in-process state', agentType: 'codex' }
      }
      server.ingestTerminalStatus(duplicateOsc)

      expect(rendererListener).toHaveBeenCalledTimes(1)
      expect(enrichedStatuses).toHaveBeenCalledTimes(1)
      expect(rowMutations).toHaveBeenCalledTimes(1)
      expect(statusChanges).toHaveBeenCalledTimes(1)
      expect(freshness).toHaveBeenCalledTimes(1)
      expect(
        JSON.parse(readFileSync(server.lastStatusPath!, 'utf8')).entries[PANE].payload.prompt
      ).toBe('surviving PTY')

      await server.start({ env: 'production', userDataPath })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          worktreeId: 'wt-lifecycle',
          prompt: 'newer in-process state'
        })
      ])
      expect(server.buildPtyEnv()).toMatchObject({
        ORCA_AGENT_HOOK_ENV: 'production',
        ORCA_AGENT_HOOK_PORT: expect.any(String),
        ORCA_AGENT_HOOK_TOKEN: expect.any(String),
        ORCA_AGENT_HOOK_ENDPOINT: server.endpointFilePath
      })
      server.ingestTerminalStatus(duplicateOsc)
      expect(freshness).toHaveBeenCalledTimes(2)
      expect(rendererListener).toHaveBeenCalledTimes(1)
      expect(enrichedStatuses).toHaveBeenCalledTimes(1)
      expect(rowMutations).toHaveBeenCalledTimes(1)
      expect(statusChanges).toHaveBeenCalledTimes(1)

      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-lifecycle',
          worktreeId: 'wt-lifecycle',
          payload: { state: 'done', prompt: 'newer in-process state', agentType: 'codex' }
        },
        'ssh-lifecycle'
      )
      expect(rendererListener).toHaveBeenCalledTimes(2)
      expect(enrichedStatuses).toHaveBeenCalledTimes(2)
      expect(rowMutations).toHaveBeenCalledTimes(2)
      expect(statusChanges).toHaveBeenCalledTimes(2)

      server.stop()
      server.stop()
      expect(server.buildPtyEnv()).toEqual({})
      expect(server.getStatusSnapshot()).toEqual([])
      expect(statusChanges).toHaveBeenCalledTimes(3)
      expect(statusChanges).toHaveBeenLastCalledWith([])
    } finally {
      server.stop()
      persisted.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
