import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, GOOD_PANE, postHookEvent } from './server.test-fixtures'

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

async function postCursorHook(
  server: AgentHookServer,
  payload: Record<string, unknown>,
  overrides: Parameters<typeof buildBody>[1] = {}
): Promise<Response> {
  return postHookEvent(server, buildBody(payload, overrides), '/hook/cursor')
}

describe('Cursor pane authority ingest', () => {
  it('a completed stop settles a tokenless Cursor pane to done', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postCursorHook(server, {
        hook_event_name: 'beforeSubmitPrompt',
        prompt: 'add a README'
      })
      await postCursorHook(server, { hook_event_name: 'stop', status: 'completed' })
      await postCursorHook(server, {
        hook_event_name: 'afterAgentResponse',
        text: 'Wrote the README.'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'done',
          agentType: 'cursor',
          prompt: 'add a README',
          lastAssistantMessage: 'Wrote the README.'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('a remote Cursor beforeSubmitPrompt restarts a retired pane so stop can settle', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'cursor',
        hookEventName: 'beforeSubmitPrompt',
        launchToken: 'remote-cursor-token',
        payload: { state: 'working', prompt: 'first remote', agentType: 'cursor' }
      },
      'ssh-1'
    )
    server.retirePaneAuthority(PANE)

    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'cursor',
        hookEventName: 'beforeSubmitPrompt',
        launchToken: 'remote-cursor-token',
        payload: { state: 'working', prompt: 'second remote', agentType: 'cursor' }
      },
      'ssh-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'cursor',
        hookEventName: 'stop',
        launchToken: 'remote-cursor-token',
        payload: { state: 'done', prompt: 'second remote', agentType: 'cursor' }
      },
      'ssh-1'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'done',
        agentType: 'cursor',
        prompt: 'second remote',
        connectionId: 'ssh-1'
      })
    ])
  })

  it('a completed stop after launch-authority retire still settles the same Cursor pane', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postCursorHook(
        server,
        { hook_event_name: 'beforeSubmitPrompt', prompt: 'add tests' },
        { launchToken: 'cursor-launch-token' }
      )
      server.retirePaneAuthority(PANE)

      await postCursorHook(
        server,
        { hook_event_name: 'beforeSubmitPrompt', prompt: 'add tests again' },
        { launchToken: 'cursor-launch-token' }
      )
      await postCursorHook(
        server,
        { hook_event_name: 'stop', status: 'completed' },
        { launchToken: 'cursor-launch-token' }
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'done',
          agentType: 'cursor',
          prompt: 'add tests again'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('a pane without matching launch authority cannot stamp a sibling Cursor pane done', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postCursorHook(
        server,
        { hook_event_name: 'beforeSubmitPrompt', prompt: 'control turn' },
        { launchToken: 'control-token' }
      )
      await postCursorHook(
        server,
        { hook_event_name: 'beforeSubmitPrompt', prompt: 'foreign turn' },
        { paneKey: GOOD_PANE, tabId: 'tab-good', launchToken: 'foreign-token' }
      )
      server.retirePaneAuthority(GOOD_PANE)

      // Why: a completed stop is not a new-turn proof. Without this fence a
      // retired pane could stamp itself (or, with a stolen paneKey, a sibling).
      await postCursorHook(
        server,
        { hook_event_name: 'stop', status: 'completed' },
        { paneKey: GOOD_PANE, tabId: 'tab-good' }
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          prompt: 'control turn'
        })
      ])
      expect(
        server.attestCompatibilityAuthority({
          paneKey: PANE,
          launchTokenHash: createHash('sha256').update('control-token').digest('hex'),
          connectionId: null,
          terminalProvenance: 'current_runtime'
        })
      ).toEqual({ paneKey: PANE, source: 'current_hook' })
      expect(
        server.attestCompatibilityAuthority({
          paneKey: GOOD_PANE,
          launchTokenHash: createHash('sha256').update('foreign-token').digest('hex'),
          connectionId: null,
          terminalProvenance: 'current_runtime'
        })
      ).toBeNull()
    } finally {
      server.stop()
    }
  })
})
