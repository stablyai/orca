// Why: locks the statusline → per-pane contextUsage upsert contract — readings enrich the
// cached status row (no fabricated rows), unchanged values never re-emit, the reading
// survives later hook pings, last-status.json restarts, and relay re-normalization.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)

function contextStatusLineBody(
  paneKey: string,
  usage: { input?: number; cacheCreation?: number; cacheRead?: number; size?: number }
): string {
  return new URLSearchParams({
    paneKey,
    payload: JSON.stringify({
      cost: { total_duration_ms: 1_000 },
      context_window: {
        ...(usage.size !== undefined ? { context_window_size: usage.size } : {}),
        current_usage: {
          input_tokens: usage.input ?? 0,
          cache_creation_input_tokens: usage.cacheCreation ?? 0,
          cache_read_input_tokens: usage.cacheRead ?? 0
        }
      }
    })
  }).toString()
}

describe('AgentHookServer context-usage ingestion', () => {
  let server: AgentHookServer

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
  })

  function postStatusLine(body: string): Promise<Response> {
    const env = server.buildPtyEnv()
    return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/statusline/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body
    })
  }

  function postClaudeHook(payload: Record<string, unknown>): Promise<Response> {
    const env = server.buildPtyEnv()
    return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        env: 'production',
        payload
      })
    })
  }

  it('upserts the reading onto the pane row and emits exactly once per change', async () => {
    await expect(
      postClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' })
    ).resolves.toMatchObject({ status: 204 })

    const emitted: unknown[] = []
    server.subscribeEnrichedStatus((event) => {
      emitted.push(event.payload.contextUsage)
    })

    await expect(
      postStatusLine(contextStatusLineBody(PANE, { input: 8_500, cacheRead: 2_000, size: 200_000 }))
    ).resolves.toMatchObject({ status: 204 })
    expect(emitted).toEqual([
      { usedTokens: 10_500, maxTokens: 200_000, usedTokensSource: 'provider' }
    ])
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'working',
        contextUsage: { usedTokens: 10_500, maxTokens: 200_000, usedTokensSource: 'provider' }
      })
    ])

    // Same reading again: no re-emit, same snapshot.
    await postStatusLine(
      contextStatusLineBody(PANE, { input: 8_500, cacheRead: 2_000, size: 200_000 })
    )
    expect(emitted).toHaveLength(1)

    // Changed reading: one more emit.
    await postStatusLine(
      contextStatusLineBody(PANE, { input: 9_000, cacheRead: 2_000, size: 200_000 })
    )
    expect(emitted).toEqual([
      { usedTokens: 10_500, maxTokens: 200_000, usedTokensSource: 'provider' },
      { usedTokens: 11_000, maxTokens: 200_000, usedTokensSource: 'provider' }
    ])
  })

  it('drops readings at the host boundary while tracking is disabled', async () => {
    await postClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' })
    await postStatusLine(contextStatusLineBody(PANE, { input: 8_500, size: 200_000 }))
    const emitted: unknown[] = []
    server.subscribeEnrichedStatus((event) => emitted.push(event.payload.contextUsage))
    server.setContextPressureEnabled(false)
    await postStatusLine(contextStatusLineBody(PANE, { input: 8_500, size: 200_000 }))

    expect(emitted).toEqual([null])
    expect(server.getStatusSnapshotForPane(PANE)[0]).toHaveProperty('contextUsage', null)
  })

  it('never fabricates a status row for a pane without one', async () => {
    const emitted: unknown[] = []
    server.subscribeEnrichedStatus((event) => emitted.push(event))
    await expect(
      postStatusLine(contextStatusLineBody(PANE, { input: 100, size: 200_000 }))
    ).resolves.toMatchObject({ status: 204 })
    expect(emitted).toEqual([])
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('carries the reading across later hook pings that omit contextUsage', async () => {
    await postClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'first' })
    await postStatusLine(contextStatusLineBody(PANE, { input: 5_000, size: 200_000 }))
    await postClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'second' })
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([
      expect.objectContaining({
        prompt: 'second',
        contextUsage: { usedTokens: 5_000, maxTokens: 200_000, usedTokensSource: 'provider' }
      })
    ])
  })

  it('ignores readings for panes of a recently closed tab', async () => {
    await postClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' })
    server.dropStatusEntriesByTabPrefix('tab-1')
    await postStatusLine(contextStatusLineBody(PANE, { input: 100, size: 200_000 }))
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('clears the reading via an explicit null without dropping the row', async () => {
    await postClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' })
    await postStatusLine(contextStatusLineBody(PANE, { input: 5_000, size: 200_000 }))
    server.applyPaneContextUsage(PANE, null)
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([
      expect.objectContaining({ paneKey: PANE, state: 'working', contextUsage: null })
    ])
  })
})

describe('AgentHookServer context-usage persistence and relay ingest', () => {
  it('rejects mixed remote status and context envelopes', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        payload: { state: 'working', prompt: 'mixed', agentType: 'claude' },
        contextUsage: { usedTokens: 42_000, maxTokens: 200_000 }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
  })

  it('treats a whitespace-only remote context session id as absent', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        providerSession: { key: 'session_id', id: 'remote-session' },
        payload: { state: 'working', prompt: 'remote', agentType: 'claude' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        payload: undefined,
        contextUsage: { usedTokens: 42_000, maxTokens: 200_000 },
        contextSessionId: '   '
      },
      'conn-1'
    )

    expect(server.getStatusSnapshotForPane(PANE)[0]?.contextUsage).toEqual({
      usedTokens: 42_000,
      maxTokens: 200_000
    })
  })

  it('persists the reading to last-status.json and replays it after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-agent-hooks-context-'))
    const firstServer = new AgentHookServer()
    const secondServer = new AgentHookServer()
    try {
      await firstServer.start({ env: 'production', userDataPath: dir })
      firstServer.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'remote', agentType: 'claude' }
        },
        'conn-1'
      )
      firstServer.applyPaneContextUsage(PANE, { usedTokens: 120_000, maxTokens: 200_000 })
      firstServer.flushStatusPersistSync()
      firstServer.stop()

      await secondServer.start({ env: 'production', userDataPath: dir })
      expect(secondServer.getStatusSnapshotForPane(PANE)).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          contextUsage: { usedTokens: 120_000, maxTokens: 200_000 }
        })
      ])
    } finally {
      firstServer.stop()
      secondServer.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps contextUsage through ingestRemote re-normalization and drops invalid shapes', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        payload: {
          state: 'working',
          prompt: 'remote',
          agentType: 'claude',
          contextUsage: { usedTokens: 42_000, maxTokens: 200_000 }
        }
      },
      'conn-1'
    )
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([
      expect.objectContaining({
        connectionId: 'conn-1',
        contextUsage: { usedTokens: 42_000, maxTokens: 200_000 }
      })
    ])

    // Malformed reading from a skewed relay: field dropped, row still ingested.
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        payload: {
          state: 'working',
          prompt: 'skewed',
          agentType: 'claude',
          contextUsage: { usedTokens: 'lots' }
        }
      },
      'conn-1'
    )
    const [entry] = server.getStatusSnapshotForPane(PANE)
    expect(entry).toEqual(expect.objectContaining({ prompt: 'skewed' }))
    // Why not carry-forward here: normalization turned the malformed field into
    // undefined, so the previous reading is inherited — assert it stayed intact.
    expect(entry.contextUsage).toEqual({ usedTokens: 42_000, maxTokens: 200_000 })
  })
})
