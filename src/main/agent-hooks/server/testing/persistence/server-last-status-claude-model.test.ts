import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, ingestProgramStatusOsc, postHookEvent } from '../server.test-fixtures'

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
    { saved: 'working', next: 'Stop', osc: false },
    { saved: 'done', next: 'UserPromptSubmit', osc: false },
    // Claude reports OSC 7501 `working` just before UserPromptSubmit.
    { saved: 'done', next: 'UserPromptSubmit', osc: true }
  ])(
    'keeps the SessionStart model after a $saved restart (OSC first: $osc)',
    async ({ saved, next, osc }) => {
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
        if (osc) {
          ingestProgramStatusOsc(server, '\x1b]7501;state=working:app=claude-code\x1b\\')
        }
        await postHookEvent(server, buildBody({ hook_event_name: next, prompt: 'next' }))
        expect(server.getStatusSnapshot()[0]?.model).toBe('claude-opus-5-5')
      } finally {
        server.stop()
      }
    }
  )
})
