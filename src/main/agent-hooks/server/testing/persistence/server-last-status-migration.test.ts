import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { recentTs, PANE } from '../server.test-fixtures'
import { holdSavedStatusLock, readSavedStatus } from './last-status.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

describe('saved agent status from an older build', () => {
  let userDataPath: string
  const lastStatusPath = (): string => join(userDataPath, 'agent-hooks', 'last-status.json')
  const writeLegacyFile = (prompt: string): void => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [PANE]: {
            paneKey: PANE,
            tabId: 'tab-1',
            receivedAt: recentTs(),
            stateStartedAt: recentTs(),
            payload: { state: 'done', prompt, agentType: 'claude' }
          }
        }
      })
    )
  }
  const restoredPrompt = async (): Promise<string | undefined> => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      return server.getStatusSnapshot()[0]?.prompt
    } finally {
      server.stop()
    }
  }

  beforeEach(() => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-last-status-migration-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('moves the old file into the saved rows once and keeps restoring from them', async () => {
    writeLegacyFile('from the old file')

    expect(await restoredPrompt()).toBe('from the old file')
    expect(existsSync(lastStatusPath())).toBe(false)
    expect(await restoredPrompt()).toBe('from the old file')
  })

  it('leaves the old file alone for a session whose rows cannot be read', async () => {
    writeLegacyFile('from the old file')
    const release = holdSavedStatusLock(lastStatusPath())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    release()
    server.stop()
    expect(existsSync(lastStatusPath())).toBe(true)

    expect(await restoredPrompt()).toBe('from the old file')
    expect(existsSync(lastStatusPath())).toBe(false)
  })

  it('never reports disabled writes saved and resumes from authoritative rows with the next writer', async () => {
    writeLegacyFile('protected original')
    const release = holdSavedStatusLock(lastStatusPath())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    release()
    try {
      for (let index = 0; index < 100; index++) {
        const paneKey = `disabled-${index}:11111111-1111-4111-8111-111111111111`
        server.recordLaunchResumeIdentity({
          paneKey,
          agentType: 'codex',
          providerSession: { key: 'session_id', id: `session-${index}` },
          launchedAt: 1
        })
        server.dropStatusEntry(paneKey, { preserveResumeIdentity: false })
      }
      server.ingestTerminalStatus({
        paneKey: PANE,
        payload: {
          state: 'done',
          prompt: 'uncommitted session',
          agentType: 'codex'
        }
      })
      expect(server.flushStatusPersistSync()).toBe(false)
    } finally {
      server.stop()
      vi.restoreAllMocks()
    }
    expect(existsSync(lastStatusPath())).toBe(true)

    const next = new AgentHookServer()
    await next.start({ env: 'production', userDataPath })
    try {
      expect(next.getStatusSnapshot().map((row) => row.prompt)).toEqual(['protected original'])
      next.ingestTerminalStatus({
        paneKey: PANE,
        payload: {
          state: 'working',
          prompt: 'recovered writer',
          agentType: 'claude'
        }
      })
      expect(next.flushStatusPersistSync()).toBe(true)
      expect(JSON.parse(readSavedStatus(lastStatusPath())).entries[PANE].payload.prompt).toBe(
        'recovered writer'
      )
    } finally {
      next.stop()
    }
    expect(await restoredPrompt()).toBe('recovered writer')
  })

  it('keeps the saved rows when an old file is rejected', async () => {
    writeLegacyFile('saved in rows')
    expect(await restoredPrompt()).toBe('saved in rows')
    writeFileSync(lastStatusPath(), 'null')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await restoredPrompt()).toBe('saved in rows')
    expect(existsSync(lastStatusPath())).toBe(false)
    expect(await restoredPrompt()).toBe('saved in rows')
  })

  it('prefers a file an older build wrote after the rows were saved', async () => {
    writeLegacyFile('first')
    expect(await restoredPrompt()).toBe('first')

    writeLegacyFile('written by an older build later')
    expect(await restoredPrompt()).toBe('written by an older build later')
  })
})
