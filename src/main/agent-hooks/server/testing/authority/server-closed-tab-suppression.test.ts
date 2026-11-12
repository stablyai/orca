import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { CLOSED_AGENT_STATUS_TAB_IDS_MAX } from '../../server-constants'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { buildBody, PANE, LEAF_2, LEAF_3 } from '../server.test-fixtures'

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

describe('AgentHookServer listener replay', () => {
  it('suppresses local HTTP hook writes for a recently closed tab', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postHook = (prompt: string): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody({ hook_event_name: 'UserPromptSubmit', prompt }))
        })

      await expect(postHook('before close')).resolves.toMatchObject({ status: 204 })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, prompt: 'before close' })
      ])

      server.dropStatusEntriesByTabPrefix('tab-1')
      await expect(postHook('late local')).resolves.toMatchObject({ status: 204 })

      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      server.stop()
    }
  })

  it('accepts a new local prompt after launch authority retires in a reusable pane', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload, { launchToken: 'retired-launch-token' }))
        })

      await postHook({ hook_event_name: 'UserPromptSubmit', prompt: 'first launch' })
      server.retirePaneAuthority(PANE)
      await postHook({ hook_event_name: 'Stop', last_assistant_message: 'late prior hook' })
      expect(server.getStatusSnapshot()).toEqual([])

      await postHook({ hook_event_name: 'UserPromptSubmit', prompt: 'manual restart' })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'working', prompt: 'manual restart' })
      ])
      expect(
        server.attestCompatibilityAuthority({
          paneKey: PANE,
          launchTokenHash: createHash('sha256').update('retired-launch-token').digest('hex'),
          connectionId: null,
          terminalProvenance: 'current_runtime'
        })
      ).toBeNull()
    } finally {
      server.stop()
    }
  })

  // Reattach must restore mid-turn and idle panes without waiting for a new-turn event.
  for (const kind of ['pi', 'omp'] as const) {
    it(`re-attaching a retired ${kind} pane restores status without needing a new turn`, async () => {
      const server = new AgentHookServer()
      await server.start({ env: 'production' })
      try {
        const env = server.buildPtyEnv()
        const postHook = (payload: Record<string, unknown>): Promise<Response> =>
          fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/${kind}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
            },
            body: JSON.stringify(buildBody(payload, { launchToken: `retired-${kind}-token` }))
          })

        await postHook({ hook_event_name: 'before_agent_start', prompt: 'turn in flight' })
        server.retirePaneAuthority(PANE)

        // A surviving turn may have only its completion left to report.
        await postHook({ hook_event_name: 'agent_end' })
        expect(server.getStatusSnapshot()).toEqual([])

        expect(server.restorePaneAuthority(PANE)).toBe(true)

        await postHook({ hook_event_name: 'agent_end' })
        expect(server.getStatusSnapshot()).toEqual([
          expect.objectContaining({ paneKey: PANE, state: 'done' })
        ])
      } finally {
        server.stop()
      }
    })
  }

  it('re-attach does not lift a closed-tab tombstone', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload, { launchToken: 'closed-tab-token' }))
        })

      server.retirePaneAuthority(PANE)
      server.dropStatusEntriesByTabPrefix('tab-1')
      expect(server.restorePaneAuthority(PANE)).toBe(false)

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'after tab close' })
      expect(server.getStatusSnapshot()).toEqual([])

      expect(server.restorePaneAuthority(PANE)).toBe(false)
    } finally {
      server.stop()
    }
  })

  // Reattach must rebuild retired aliases because the live process still posts its original pane key.
  it('re-attaching a detached pane accepts hooks on the pane key its process launched under', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const detachedPane = makePaneKey('tab-2', LEAF_2)
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload, { launchToken: 'detached-token' }))
        })

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'turn in flight' })
      // Detached processes keep posting their original key; aliases route them to the new owner.
      server.transferPaneAuthority(PANE, detachedPane, 'pty-detached')
      server.retirePaneAuthority(detachedPane)
      expect(server.restorePaneAuthority(detachedPane)).toBe(true)

      await postHook({ hook_event_name: 'agent_end' })
      // Restoring fences without aliases would create a duplicate row under the old key.
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: detachedPane, state: 'done' })
      ])
    } finally {
      server.stop()
    }
  })

  // Restoring the original key must not rebuild an alias into the closed owner tab.
  it('re-opens the original pane instead of rebuilding an alias into a closed tab', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const detachedPane = makePaneKey('tab-2', LEAF_2)
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload, { launchToken: 'reopen-origin-token' }))
        })

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'turn in flight' })
      server.transferPaneAuthority(PANE, detachedPane, 'pty-detached')
      server.retirePaneAuthority(detachedPane)
      server.dropStatusEntriesByTabPrefix('tab-2')

      expect(server.restorePaneAuthority(PANE)).toBe(true)

      await postHook({ hook_event_name: 'agent_end' })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'done' })
      ])
    } finally {
      server.stop()
    }
  })

  // After tab-ID eviction, the pane fence must remain; use a non-boundary event that cannot lift it.
  it('leaves a closed tab pane fenced once its tab id is evicted', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const detachedPane = makePaneKey('tab-2', LEAF_2)
      const env = server.buildPtyEnv()
      const postHook = (
        payload: Record<string, unknown>,
        overrides: Record<string, unknown> = {}
      ): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload, { launchToken: 'evict-token', ...overrides }))
        })

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'turn in flight' })
      server.transferPaneAuthority(PANE, detachedPane, 'pty-detached')
      server.retirePaneAuthority(detachedPane)
      server.dropStatusEntriesByTabPrefix('tab-2')
      expect(server.restorePaneAuthority(PANE)).toBe(true)

      for (let i = 0; i <= CLOSED_AGENT_STATUS_TAB_IDS_MAX; i += 1) {
        server.dropStatusEntriesByTabPrefix(`tab-evict-${i}`)
      }

      await postHook(
        { hook_event_name: 'agent_end', prompt: 'after eviction' },
        { paneKey: detachedPane, tabId: 'tab-2' }
      )
      expect(server.getStatusSnapshot()).toEqual([])

      // An unfenced control proves the event itself is active.
      await postHook(
        { hook_event_name: 'agent_end', prompt: 'unfenced control' },
        { paneKey: makePaneKey('tab-9', LEAF_3), tabId: 'tab-9' }
      )
      expect(server.getStatusSnapshot()).toHaveLength(1)
    } finally {
      server.stop()
    }
  })

  // Detached legacy aliases can span tabs; their own closed tab must remain fenced.
  it('keeps a legacy alias fenced when its own tab closed but the owner tab did not', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const legacyPane = 'tab-1:0'
      const detachedPane = makePaneKey('tab-2', LEAF_2)
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(
            buildBody(payload, { paneKey: legacyPane, launchToken: 'legacy-cross-tab-token' })
          )
        })

      server.registerPaneKeyAlias(legacyPane, PANE, 'pty-cross')
      server.transferPaneAuthority(PANE, detachedPane, 'pty-cross')
      server.retirePaneAuthority(detachedPane)
      server.dropStatusEntriesByTabPrefix('tab-1')

      // Restore the open owner without reviving an alias from the closed tab.
      expect(server.restorePaneAuthority(detachedPane)).toBe(true)

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'after tab-1 close' })
      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      server.stop()
    }
  })

  it('does not clobber a newer alias when replaying a retired fence', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const legacyPane = 'tab-1:0'
      const reboundPane = makePaneKey('tab-1', LEAF_3)
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(
            buildBody(payload, { paneKey: legacyPane, launchToken: 'rebind-token' })
          )
        })

      server.registerPaneKeyAlias(legacyPane, PANE, 'pty-old')
      server.retirePaneAuthority(PANE)
      server.registerPaneKeyAlias(legacyPane, reboundPane, 'pty-new')
      server.restorePaneAuthority(PANE)

      await postHook({ hook_event_name: 'before_agent_start', prompt: 'after rebind' })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: reboundPane, state: 'working' })
      ])
    } finally {
      server.stop()
    }
  })

  it('accepts a live remote prompt but not replay after launch authority retires', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'UserPromptSubmit',
        launchToken: 'retired-remote-launch-token',
        payload: { state: 'working', prompt: 'first launch', agentType: 'claude' }
      },
      'conn-1'
    )
    server.retirePaneAuthority(PANE)

    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'UserPromptSubmit',
        launchToken: 'retired-remote-launch-token',
        isReplay: true,
        payload: { state: 'working', prompt: 'stale replay', agentType: 'claude' }
      },
      'conn-1'
    )
    expect(server.getStatusSnapshot()).toEqual([])

    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'UserPromptSubmit',
        launchToken: 'retired-remote-launch-token',
        payload: { state: 'working', prompt: 'remote manual restart', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'working',
        prompt: 'remote manual restart',
        connectionId: 'conn-1'
      })
    ])
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE,
        launchTokenHash: createHash('sha256').update('retired-remote-launch-token').digest('hex'),
        connectionId: 'conn-1',
        terminalProvenance: 'current_runtime'
      })
    ).toBeNull()
  })
})
