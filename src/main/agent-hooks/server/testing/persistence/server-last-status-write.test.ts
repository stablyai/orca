import { readSavedStatus } from './last-status.test-fixtures'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { recentTs, PANE } from '../server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Last-status persistence', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-laststatus-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function lastStatusPath(): string {
    return join(userDataPath, 'agent-hooks', 'last-status.json')
  }

  it('scrubs a legacy persisted launch bearer while retaining its authority commitment', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    const receivedAt = recentTs()
    const launchToken = 'legacy-launch-bearer'
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [PANE]: {
            paneKey: PANE,
            launchToken,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            connectionId: null,
            receivedAt,
            stateStartedAt: receivedAt,
            payload: {
              state: 'working',
              prompt: 'legacy worker',
              agentType: 'codex'
            }
          }
        }
      }),
      'utf8'
    )

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const launchTokenHash = createHash('sha256').update(launchToken).digest('hex')
      expect(server.getHydratedAuthorityCommitments()).toEqual([
        expect.objectContaining({ paneKey: PANE, launchTokenHash })
      ])
      expect(server.getStatusSnapshotForPane(PANE)[0]?.launchToken).toBeUndefined()

      const persisted = readSavedStatus(lastStatusPath())
      expect(persisted).not.toContain(launchToken)
      expect(JSON.parse(persisted).entries[PANE]).toMatchObject({ launchTokenHash })
    } finally {
      server.stop()
    }

    const restartedServer = new AgentHookServer()
    await restartedServer.start({ env: 'production', userDataPath })
    try {
      expect(restartedServer.getHydratedAuthorityCommitments()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          launchTokenHash: createHash('sha256').update(launchToken).digest('hex')
        })
      ])
      expect(restartedServer.getStatusSnapshotForPane(PANE)[0]?.launchToken).toBeUndefined()
    } finally {
      restartedServer.stop()
    }
  })

  it('persists SSH authority through transient clears until explicit retirement', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    const receivedAt = recentTs()
    const launchToken = 'retained-ssh-launch-bearer'
    const launchTokenHash = createHash('sha256').update(launchToken).digest('hex')
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [PANE]: {
            paneKey: PANE,
            launchTokenHash,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            connectionId: 'ssh-target',
            receivedAt,
            stateStartedAt: receivedAt,
            payload: {
              state: 'working',
              prompt: 'retained SSH worker',
              agentType: 'codex'
            }
          }
        }
      }),
      'utf8'
    )

    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath })
    first.clearStatusEntriesForConnection('ssh-target')
    first.flushStatusPersistSync()
    first.stop()

    const afterClear = JSON.parse(readSavedStatus(lastStatusPath()))
    expect(afterClear.entries).toEqual({})
    expect(afterClear.authorityCommitments[PANE]).toMatchObject({
      paneKey: PANE,
      launchTokenHash,
      connectionId: 'ssh-target'
    })

    const restored = new AgentHookServer()
    await restored.start({ env: 'production', userDataPath })
    expect(
      restored.attestCompatibilityAuthority({
        paneKey: PANE,
        launchTokenHash,
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toEqual({ paneKey: PANE, source: 'hydrated_commitment' })
    restored.retirePaneAuthority(PANE)
    restored.flushStatusPersistSync()
    restored.stop()

    const retired = new AgentHookServer()
    await retired.start({ env: 'production', userDataPath })
    try {
      expect(
        retired.attestCompatibilityAuthority({
          paneKey: PANE,
          launchTokenHash,
          connectionId: 'ssh-target',
          terminalProvenance: 'restored'
        })
      ).toBeNull()
    } finally {
      retired.stop()
    }
  })
})
