import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, GOOD_PANE, postHookEvent, PANE } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

const REMINTED = '$$MFRGGZDFMY:L$$'
const FOREIGN = '$$ONXW2ZJAON:L$$'

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('reminted $$ pane keys on the OMP hook pipeline', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-reminted-pane-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function lastStatusPath(): string {
    return join(userDataPath, 'agent-hooks', 'last-status.json')
  }

  it('routes a reminted $$ key to its canonical pane and settles at done', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      server.registerPaneKeyAlias(REMINTED, PANE, 'pty-remint')
      const start = await postHookEvent(
        server,
        buildBody(
          { hook_event_name: 'before_agent_start', prompt: 'finish the reminted pane' },
          { paneKey: REMINTED, launchToken: 'launch-remint' }
        ),
        '/hook/omp'
      )
      const end = await postHookEvent(
        server,
        buildBody(
          { hook_event_name: 'agent_end' },
          { paneKey: REMINTED, launchToken: 'launch-remint' }
        ),
        '/hook/omp'
      )
      expect(start.status).toBe(204)
      expect(end.status).toBe(204)
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          state: 'done',
          prompt: 'finish the reminted pane',
          agentType: 'omp'
        })
      ])
      server.flushStatusPersistSync()
      expect(existsSync(lastStatusPath())).toBe(true)
      const file = JSON.parse(readFileSync(lastStatusPath(), 'utf8')) as {
        entries: Record<string, { payload: { state: string } }>
      }
      expect(file.entries[PANE]?.payload.state).toBe('done')
      expect(file.entries[REMINTED]).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('leaves a canonical UUID pane key on the same path', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'before_agent_start', prompt: 'canonical omp' }),
        '/hook/omp'
      )
      await postHookEvent(server, buildBody({ hook_event_name: 'agent_end' }), '/hook/omp')
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'done',
          prompt: 'canonical omp',
          agentType: 'omp'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('does not let a foreign reminted key stamp another pane', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      server.registerPaneKeyAlias(REMINTED, PANE, 'pty-remint')
      await postHookEvent(
        server,
        buildBody(
          { hook_event_name: 'before_agent_start', prompt: 'owned turn' },
          { paneKey: REMINTED }
        ),
        '/hook/omp'
      )
      const foreign = await postHookEvent(
        server,
        buildBody(
          { hook_event_name: 'agent_end', prompt: 'stolen done' },
          { paneKey: FOREIGN, tabId: 'tab-1' }
        ),
        '/hook/omp'
      )
      expect(foreign.status).toBe(204)
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          prompt: 'owned turn',
          agentType: 'omp'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('does not rebind a reminted token onto a different pane', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      // Why: spawn A then spawn B can share one $$ token in env with different tab/leaf.
      // Overwriting would let leftover remint posts stamp spawn B's pane.
      server.registerPaneKeyAlias(REMINTED, PANE, 'pty-a', 10, { authorityVerified: true })
      server.registerPaneKeyAlias(REMINTED, GOOD_PANE, 'pty-b', 20, { authorityVerified: true })
      const start = await postHookEvent(
        server,
        buildBody(
          { hook_event_name: 'before_agent_start', prompt: 'owned remint turn' },
          { paneKey: REMINTED, tabId: 'tab-good' }
        ),
        '/hook/omp'
      )
      expect(start.status).toBe(204)
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          state: 'working',
          prompt: 'owned remint turn',
          agentType: 'omp'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('updates the remint alias pty when the destination pane is unchanged', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setPaneKeyAliasPersistenceListener(listener)
    server.registerPaneKeyAlias(REMINTED, PANE, 'pty-a', 10, { authorityVerified: true })
    server.registerPaneKeyAlias(REMINTED, PANE, 'pty-b', 20, { authorityVerified: true })
    expect(listener).toHaveBeenLastCalledWith([
      expect.objectContaining({
        legacyPaneKey: REMINTED,
        stablePaneKey: PANE,
        ptyId: 'pty-b',
        updatedAt: 20
      })
    ])
  })

  it('does not let a later persist row rebind a reminted token', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      server.registerPaneKeyAlias(REMINTED, PANE, 'pty-a', 10, { authorityVerified: true })
      server.registerPaneKeyAlias(REMINTED, GOOD_PANE, 'pty-b', 20, { overwriteExisting: false })
      await postHookEvent(
        server,
        buildBody(
          { hook_event_name: 'before_agent_start', prompt: 'restored remint' },
          { paneKey: REMINTED, tabId: 'tab-good' }
        ),
        '/hook/omp'
      )
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          state: 'working',
          prompt: 'restored remint',
          agentType: 'omp'
        })
      ])
    } finally {
      server.stop()
    }
  })
})
