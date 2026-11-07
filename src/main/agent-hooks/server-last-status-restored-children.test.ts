import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'

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

  it('waits for a lead boundary after a post-restart stop matches a restored child', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({
        hook_event_name: 'SubagentStart',
        agent_id: 'a0000000000000002',
        agent_type: 'reviewer'
      })
    )
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const statusListener = vi.fn()
      server.subscribeEnrichedStatus(statusListener)
      const restored = server.getStatusSnapshot()[0]
      expect(restored).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true,
        subagents: [expect.objectContaining({ id: 'a0000000000000002' })]
      })

      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'a0000000000000002' })
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true,
        subagents: undefined
      })
      expect(server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(false)
      expect(server._getStateForTests().claudeSubagentRosterByPaneKey.size).toBe(0)
      expect(statusListener).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ restoredUnconfirmed: true })
      )

      await postHookEvent(server, buildBody({ hook_event_name: 'Stop', background_tasks: [] }))

      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
      expect(server.getStatusSnapshot()[0]?.restoredUnconfirmed).toBeUndefined()
      expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
      expect(statusListener).toHaveBeenCalledTimes(2)
    } finally {
      server.stop()
    }
  })

  it('does not resurrect a matched restored child across a second restart', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({
        hook_event_name: 'SubagentStart',
        agent_id: 'a0000000000000012',
        agent_type: 'reviewer'
      })
    )
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const secondServer = new AgentHookServer()
    await secondServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      secondServer,
      buildBody({ hook_event_name: 'SubagentStop', agent_id: 'a0000000000000012' })
    )
    expect(secondServer.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      restoredUnconfirmed: true,
      subagents: undefined
    })
    secondServer.flushStatusPersistSync()
    secondServer.stop()

    const thirdServer = new AgentHookServer()
    await thirdServer.start({ env: 'production', userDataPath })
    try {
      expect(thirdServer._getStateForTests().claudeSubagentRosterByPaneKey.size).toBe(0)

      await postHookEvent(thirdServer, buildBody({ hook_event_name: 'Stop' }))

      expect(thirdServer.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
      expect(thirdServer.getStatusSnapshot()[0]?.restoredUnconfirmed).toBeUndefined()
    } finally {
      thirdServer.stop()
    }
  })

  it('keeps a legacy Stop unconfirmed when only a restored child gates it', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({
        hook_event_name: 'SubagentStart',
        agent_id: 'a0000000000000013',
        agent_type: 'reviewer'
      })
    )
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(server, buildBody({ hook_event_name: 'Stop' }))

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true,
        subagents: [expect.objectContaining({ id: 'a0000000000000013' })]
      })
      expect(server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(false)
    } finally {
      server.stop()
    }
  })

  it('keeps an unmatched restored child unconfirmed after current-runtime work drains', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({
        hook_event_name: 'SubagentStart',
        agent_id: 'a0000000000000005',
        agent_type: 'reviewer'
      })
    )
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'SubagentStart',
          agent_id: 'a0000000000000006',
          agent_type: 'reviewer'
        })
      )
      expect(server.getStatusSnapshot()[0]?.restoredUnconfirmed).toBeUndefined()

      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'a0000000000000006' })
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true,
        subagents: [expect.objectContaining({ id: 'a0000000000000005' })]
      })
      expect(server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(false)

      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'a0000000000000005' })
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true
      })
      expect(server._getStateForTests().claudeSubagentRosterByPaneKey.size).toBe(0)

      await postHookEvent(server, buildBody({ hook_event_name: 'Stop', background_tasks: [] }))

      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
      expect(server.getStatusSnapshot()[0]?.restoredUnconfirmed).toBeUndefined()
      expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('waits for a lead boundary after a post-restart idle matches a restored teammate', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({
        hook_event_name: 'SubagentStart',
        agent_id: 'areviewer-6d3cb5b5',
        agent_type: 'reviewer'
      })
    )
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const restored = server.getStatusSnapshot()[0]
      expect(restored).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true,
        subagents: [expect.objectContaining({ id: 'areviewer-6d3cb5b5' })]
      })

      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'TeammateIdle', teammate_name: 'reviewer' })
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true,
        subagents: [expect.objectContaining({ id: 'areviewer-6d3cb5b5', state: 'idle' })]
      })
      expect(server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(false)

      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'Stop',
          background_tasks: [{ id: 'treviewer', type: 'teammate', status: 'running' }]
        })
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        subagents: [expect.objectContaining({ id: 'areviewer-6d3cb5b5', state: 'idle' })]
      })
      expect(server.getStatusSnapshot()[0]?.restoredUnconfirmed).toBeUndefined()
    } finally {
      server.stop()
    }
  })
})
