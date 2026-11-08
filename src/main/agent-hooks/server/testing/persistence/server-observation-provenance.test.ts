import { hasSavedStatus, readSavedStatus } from './last-status.test-fixtures'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../telemetry/client', () => ({ track: trackMock }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)
const CONNECTION = 'ssh-provenance'

describe('agent status observation provenance', () => {
  const servers: AgentHookServer[] = []

  beforeEach(() => {
    _internals.resetCachesForTests()
    getCohortAtEmitMock.mockReturnValue({})
  })

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
    vi.restoreAllMocks()
  })

  function newServer(): AgentHookServer {
    const server = new AgentHookServer()
    servers.push(server)
    return server
  }

  // Reuse provider boundary classification; raw event-name lists miss providers with different spellings.

  it('never persists the observation to last-status.json', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-observation-'))
    try {
      const server = newServer()
      await server.start({ env: 'production', userDataPath })
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          source: 'claude',
          hookEventName: 'UserPromptSubmit',
          payload: { state: 'working', prompt: 'persist me', agentType: 'claude' }
        },
        CONNECTION
      )
      server.flushStatusPersistSync()

      const path = join(userDataPath, 'agent-hooks', 'last-status.json')
      expect(hasSavedStatus(path)).toBe(true)
      const file = readSavedStatus(path)
      // Process-local sequencing cannot remain ordering authority after restart.
      expect(file).not.toContain('observation')
      expect(JSON.parse(file).entries[PANE].observation).toBeUndefined()
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
