import { readSavedStatus, hasSavedStatus } from './last-status.test-fixtures'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import {
  buildBody,
  postHookEvent,
  recentTs,
  PANE,
  GOOD_PANE,
  LEAF_2
} from '../server.test-fixtures'

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

  it('drops entries with malformed paneKeys but keeps valid ones', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          'no-colon': {
            paneKey: 'no-colon',
            receivedAt: recentTs(),
            stateStartedAt: recentTs(-1000),
            payload: { state: 'done', prompt: 'bad', agentType: 'claude' }
          },
          [PANE]: {
            paneKey: makePaneKey('tab-x', LEAF_2),
            receivedAt: recentTs(),
            stateStartedAt: recentTs(-1000),
            payload: { state: 'done', prompt: 'mismatch', agentType: 'claude' }
          },
          [GOOD_PANE]: {
            paneKey: GOOD_PANE,
            tabId: 'tab-good',
            receivedAt: recentTs(),
            stateStartedAt: recentTs(-1000),
            payload: { state: 'done', prompt: 'survived', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      const listener = vi.fn()
      server.setListener(listener)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: GOOD_PANE,
          payload: expect.objectContaining({ prompt: 'survived' })
        })
      )
    } finally {
      server.stop()
    }
  })

  it('clearPaneState evicts the entry from the on-disk file', async () => {
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'about to drop' })
      )
      server.flushStatusPersistSync()
      let parsed = JSON.parse(readSavedStatus(lastStatusPath()))
      expect(parsed.entries[PANE]).toBeTruthy()

      server.clearPaneState(PANE)
      server.flushStatusPersistSync()
      parsed = JSON.parse(readSavedStatus(lastStatusPath()))
      expect(parsed.entries[PANE]).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('stop() flushes pending debounced writes synchronously', async () => {
    const server = new AgentHookServer()
    await server.start({
      env: 'production',
      userDataPath
    })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'flush me' })
      )
      // Let stop flush the pending debounce instead of flushing explicitly.
    } finally {
      server.stop()
    }
    expect(hasSavedStatus(lastStatusPath())).toBe(true)
    const parsed = JSON.parse(readSavedStatus(lastStatusPath()))
    expect(parsed.entries[PANE]?.payload?.prompt).toBe('flush me')
  })
})
