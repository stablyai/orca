import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { recentTs, PANE } from '../server.test-fixtures'
import { holdSavedStatusLock } from './last-status.test-fixtures'

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
