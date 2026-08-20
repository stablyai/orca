import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, PANE, RUNNING_SHELL } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Persisted Claude lead boundaries', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-lead-boundary-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('keeps a restored-only child unconfirmed after a done lead and live sibling drain', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'arestored-child' })
    )
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'continue after restart' })
      )
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStart', agent_id: 'alive-sibling' })
      )
      await postHookEvent(server, buildBody({ hook_event_name: 'Stop' }))
      expect(server.getStatusSnapshot()[0]?.restoredUnconfirmed).toBeUndefined()

      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'alive-sibling' })
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true,
        subagents: [expect.objectContaining({ id: 'arestored-child' })]
      })
      expect(server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(false)
    } finally {
      server.stop()
    }
  })

  it('restores a persisted lead boundary before its last child stops', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'finish after child' })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'arestored-child' })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'Stop', last_assistant_message: 'Lead finished.' })
    )
    expect(firstServer.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      prompt: 'finish after child',
      lastAssistantMessage: 'Lead finished.',
      subagents: [expect.objectContaining({ id: 'arestored-child', state: 'working' })]
    })
    const turnCompletedAt = firstServer.getStatusSnapshot()[0]?.turnCompletedAt
    expect(turnCompletedAt).toEqual(expect.any(Number))
    expect(firstServer._getStateForTests().lastStatusByPaneKey.get(PANE)?.hookEventName).toBe(
      'Stop'
    )
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'arestored-child' })
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        agentType: 'claude',
        prompt: 'finish after child',
        lastAssistantMessage: 'Lead finished.',
        turnCompletedAt
      })
      expect(server.getStatusSnapshot()[0]?.restoredUnconfirmed).toBeUndefined()
      expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('keeps a persisted child boundary across an OSC repaint and restart', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'finish after child' })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'arestored-child' })
    )
    await postHookEvent(firstServer, buildBody({ hook_event_name: 'Stop' }))
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const secondServer = new AgentHookServer()
    await secondServer.start({ env: 'production', userDataPath })
    secondServer.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: null,
      payload: { state: 'working', prompt: '', agentType: 'claude' }
    })
    secondServer.flushStatusPersistSync()
    secondServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'arestored-child' })
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        agentType: 'claude',
        turnCompletedAt: expect.any(Number)
      })
      expect(server.getStatusSnapshot()[0]?.restoredUnconfirmed).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('preserves a persisted lead boundary across sibling drain', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'finish after siblings' })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'achilda' })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'achildb' })
    )
    await postHookEvent(firstServer, buildBody({ hook_event_name: 'Stop' }))
    expect(
      (
        firstServer._getStateForTests().lastStatusByPaneKey.get(PANE) as
          | { claudeLeadBoundaryChildOnly?: true }
          | undefined
      )?.claudeLeadBoundaryChildOnly
    ).toBe(true)
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStop', agent_id: 'achilda' })
    )
    expect(
      (
        firstServer._getStateForTests().lastStatusByPaneKey.get(PANE) as
          | { claudeLeadBoundaryChildOnly?: true }
          | undefined
      )?.claudeLeadBoundaryChildOnly
    ).toBe(true)
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'achildb' })
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', agentType: 'claude' })
      expect(server.getStatusSnapshot()[0]?.restoredUnconfirmed).toBeUndefined()
      expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('clears a persisted lead boundary when sticky permission hides new lead work', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'resume after boundary' })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'achild-a' })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'achild-b' })
    )
    await postHookEvent(firstServer, buildBody({ hook_event_name: 'Stop' }))
    await postHookEvent(
      firstServer,
      buildBody({
        hook_event_name: 'PermissionRequest',
        agent_id: 'achild-a',
        tool_name: 'Bash',
        tool_input: { command: 'false' }
      })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'PreToolUse', tool_name: 'Read' })
    )
    expect(firstServer.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting', toolName: 'Bash' })
    expect(
      (
        firstServer._getStateForTests().lastStatusByPaneKey.get(PANE) as
          | { claudeLeadBoundaryChildOnly?: true }
          | undefined
      )?.claudeLeadBoundaryChildOnly
    ).toBeUndefined()
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStop', agent_id: 'achild-a' })
    )
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'achild-b' })
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true
      })
      expect(server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(false)
    } finally {
      server.stop()
    }
  })

  it('keeps a persisted lead boundary unconfirmed after an unrelated child stop', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'ignore unrelated stop' })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'arestored-child' })
    )
    await postHookEvent(firstServer, buildBody({ hook_event_name: 'Stop' }))
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'aunrelated' })
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true,
        subagents: [expect.objectContaining({ id: 'arestored-child', state: 'working' })]
      })
      expect(server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(false)
    } finally {
      server.stop()
    }
  })

  it('invalidates a persisted lead boundary behind a sticky child permission', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'resume after stop' })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'achilda' })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'achildb' })
    )
    await postHookEvent(firstServer, buildBody({ hook_event_name: 'Stop' }))
    await postHookEvent(
      firstServer,
      buildBody({
        hook_event_name: 'PermissionRequest',
        agent_id: 'achilda',
        tool_name: 'Bash',
        tool_input: { command: 'false' }
      })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'PreToolUse', tool_name: 'Read' })
    )
    expect(firstServer.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting', toolName: 'Bash' })
    expect(
      (
        firstServer._getStateForTests().lastStatusByPaneKey.get(PANE) as
          | { claudeLeadBoundaryChildOnly?: true }
          | undefined
      )?.claudeLeadBoundaryChildOnly
    ).toBeUndefined()
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStop', agent_id: 'achilda' })
    )
    expect(
      (
        firstServer._getStateForTests().lastStatusByPaneKey.get(PANE) as
          | { claudeLeadBoundaryChildOnly?: true }
          | undefined
      )?.claudeLeadBoundaryChildOnly
    ).toBeUndefined()
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'achildb' })
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true
      })
      expect(server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(false)
    } finally {
      server.stop()
    }
  })

  it('keeps a restored lead boundary unconfirmed when background work was running', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'finish background work' })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'arestored-child' })
    )
    await postHookEvent(
      firstServer,
      buildBody({
        hook_event_name: 'Stop',
        background_tasks: [
          { id: 'arestored-child', type: 'subagent', status: 'running' },
          RUNNING_SHELL
        ]
      })
    )
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'arestored-child' })
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true
      })
      expect(server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(false)
    } finally {
      server.stop()
    }
  })
})
