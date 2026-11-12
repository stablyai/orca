import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, postHookEvent } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

describe('The Claude model across a restart', () => {
  let userDataPath: string

  beforeEach(() => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-claude-model-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it.each([
    { saved: 'working', next: 'Stop' },
    { saved: 'done', next: 'UserPromptSubmit' }
  ])(
    'keeps the SessionStart model when the next hook after a $saved restart omits it',
    async ({ saved, next }) => {
      const firstServer = new AgentHookServer()
      await firstServer.start({ env: 'production', userDataPath })
      await postHookEvent(
        firstServer,
        buildBody({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' })
      )
      await postHookEvent(
        firstServer,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
      )
      if (saved === 'done') {
        await postHookEvent(firstServer, buildBody({ hook_event_name: 'Stop' }))
      }
      firstServer.flushStatusPersistSync()
      firstServer.stop()

      const server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath })
      try {
        await postHookEvent(server, buildBody({ hook_event_name: next, prompt: 'next' }))
        expect(server.getStatusSnapshot()[0]?.model).toBe('claude-opus-5-5')
      } finally {
        server.stop()
      }
    }
  )
})
