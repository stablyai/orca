import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

beforeEach(() => _internals.resetCachesForTests())

function workingPane(
  agentType = 'antigravity',
  connectionId: string | null = null
): AgentHookServer {
  const server = new AgentHookServer()
  server.ingestTerminalStatus({
    paneKey: PANE,
    terminalHandle: 'term-screen',
    connectionId,
    payload: { state: 'working', agentType, prompt: 'print marker', toolName: 'run_command' }
  })
  return server
}

function baseline(server: AgentHookServer) {
  const row = server.getStatusSnapshot()[0]
  if (!row) {
    throw new Error('Missing test status row')
  }
  return row
}

describe('host-owned Antigravity screen permission', () => {
  it('publishes permission through the canonical store and clears only its own prompt', () => {
    const server = workingPane()
    const listener = vi.fn()
    server.setListener(listener)
    listener.mockClear()
    expect(
      server.ingestAntigravityScreenPermission({ baseline: baseline(server), command: 'echo OK' })
    ).toBe(true)
    expect(baseline(server)).toMatchObject({
      state: 'waiting',
      toolName: 'run_command',
      observation: { origin: 'process' }
    })
    expect(JSON.parse(baseline(server).interactivePrompt ?? '')).toEqual({
      approval: { source: 'antigravity-screen', tool: 'run_command', summary: 'echo OK' }
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(
      server.ingestAntigravityScreenPermission({
        baseline: baseline(server),
        command: null,
        clearedState: 'done'
      })
    ).toBe(true)
    expect(baseline(server)).toMatchObject({ state: 'done', prompt: 'print marker' })
    expect(baseline(server).interactivePrompt).toBeUndefined()
    expect(baseline(server).toolName).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not overwrite a newer provider state with a late snapshot', () => {
    const server = workingPane()
    const old = baseline(server)
    server.ingestTerminalStatus({
      paneKey: PANE,
      terminalHandle: 'term-screen',
      payload: { state: 'done', agentType: 'antigravity', prompt: 'print marker' }
    })
    expect(server.ingestAntigravityScreenPermission({ baseline: old, command: 'echo OK' })).toBe(
      false
    )
    expect(baseline(server).state).toBe('done')
  })

  it('rejects another terminal incarnation and missing observation proof', () => {
    const server = workingPane()
    const row = baseline(server)
    expect(
      server.ingestAntigravityScreenPermission({
        baseline: { ...row, terminalHandle: 'replaced' },
        command: 'echo OK'
      })
    ).toBe(false)
    expect(
      server.ingestAntigravityScreenPermission({
        baseline: { ...row, observation: undefined },
        command: 'echo OK'
      })
    ).toBe(false)
  })

  it.each([
    ['claude', null],
    ['antigravity', 'ssh-connection']
  ] as const)('does not infer permission for %s on %s', (agent, connection) => {
    const server = workingPane(agent, connection)
    expect(
      server.ingestAntigravityScreenPermission({ baseline: baseline(server), command: 'echo OK' })
    ).toBe(false)
  })

  it('publishes permission for a WSL relay row, whose pty this host owns', () => {
    const server = workingPane('antigravity', 'wsl:Ubuntu-26.04')
    expect(
      server.ingestAntigravityScreenPermission({ baseline: baseline(server), command: 'echo OK' })
    ).toBe(true)
    expect(baseline(server)).toMatchObject({ state: 'waiting', connectionId: 'wsl:Ubuntu-26.04' })
  })

  it('does not clear a permission prompt from another producer', () => {
    const server = workingPane()
    server.ingestTerminalStatus({
      paneKey: PANE,
      terminalHandle: 'term-screen',
      payload: {
        state: 'waiting',
        agentType: 'antigravity',
        prompt: 'print marker',
        interactivePrompt: '{"questions":[]}'
      }
    })
    expect(
      server.ingestAntigravityScreenPermission({
        baseline: baseline(server),
        command: null,
        clearedState: 'done'
      })
    ).toBe(false)
    expect(baseline(server).state).toBe('waiting')
  })

  it('coalesces an unchanged permission observation without refreshing its revision', () => {
    const server = workingPane()
    server.ingestAntigravityScreenPermission({ baseline: baseline(server), command: 'echo OK' })
    const waiting = baseline(server)
    expect(
      server.ingestAntigravityScreenPermission({ baseline: waiting, command: 'echo OK' })
    ).toBe(true)
    expect(baseline(server).observation).toEqual(waiting.observation)
  })
})

it('accepts the runtime-attested binding absent from a native hook row', () => {
  const server = new AgentHookServer()
  server.ingestTerminalStatus({
    paneKey: PANE,
    payload: { state: 'working', agentType: 'antigravity', prompt: 'print marker' }
  })
  const row = baseline(server)
  expect(row.terminalHandle).toBeUndefined()
  expect(server.ingestAntigravityScreenPermission({ baseline: row, command: 'echo OK' })).toBe(
    false
  )
  expect(
    server.ingestAntigravityScreenPermission({
      baseline: { ...row, terminalHandle: 'term-runtime' },
      command: 'echo OK'
    })
  ).toBe(true)
  expect(baseline(server)).toMatchObject({ state: 'waiting', terminalHandle: 'term-runtime' })
})
