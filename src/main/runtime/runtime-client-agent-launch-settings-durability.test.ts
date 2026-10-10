import { describe, expect, it, vi } from 'vitest'
import {
  deferred,
  fixture
} from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { RuntimeClientSettingsController } from './runtime-client-settings'

const hooks = vi.hoisted(() => ({ apply: vi.fn(async () => {}) }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: hooks.apply
}))

describe('durable execution-host launch settings', () => {
  it('acknowledges a committed availability edit and its queued follow-up while hooks are pending', async () => {
    const { store, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    const started = deferred<void>()
    const finish = deferred<void>()
    hooks.apply.mockImplementationOnce(async () => {
      started.resolve()
      await finish.promise
    })
    let acknowledged = false
    let followupAcknowledged = false
    const saving = controller
      .mutateAgentLaunch({ type: 'availability', agent: 'claude', enabled: false })
      .then((settings) => {
        acknowledged = true
        return settings
      })
    const followup = saving
      .then(() =>
        controller.mutateAgentLaunch({ type: 'arguments', agent: 'codex', value: '--followup' })
      )
      .then(() => {
        followupAcknowledged = true
      })
    try {
      await started.promise
      expect(readState().settings.disabledTuiAgents).toContain('claude')
      await vi.waitFor(() => {
        expect(acknowledged).toBe(true)
        expect(followupAcknowledged).toBe(true)
      })
      expect(readState().settings.agentDefaultArgs.codex).toBe('--followup')
    } finally {
      finish.resolve()
      await saving
      await followup
    }
  })

  it('reports hook failure separately without rejecting durable settings or blocking another save', async () => {
    const { store, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    const error = new Error('hook-filesystem-unavailable')
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    hooks.apply.mockRejectedValueOnce(error)
    try {
      await expect(
        controller.mutateAgentLaunch({ type: 'availability', agent: 'claude', enabled: false })
      ).resolves.toMatchObject({ disabledTuiAgents: ['claude'] })
      await controller.mutateAgentLaunch({
        type: 'arguments',
        agent: 'codex',
        value: '--after-failure'
      })
      expect(readState().settings.agentDefaultArgs.codex).toBe('--after-failure')
      await vi.waitFor(() =>
        expect(reported).toHaveBeenCalledWith(
          '[agent-hooks] Failed to reconcile managed hooks after saving launch settings:',
          error
        )
      )
      await controller.mutateAgentLaunch({ type: 'availability', agent: 'claude', enabled: true })
      expect(readState().settings.disabledTuiAgents).not.toContain('claude')
    } finally {
      reported.mockRestore()
    }
  })

  it('acknowledges a settings change only after the real database write finishes', async () => {
    const { store, authority, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    const before = readState().settings.agentDefaultArgs.claude
    const gate = authority.pause()
    let acknowledged = false
    const writing = controller
      .mutateAgentLaunch({ type: 'arguments', agent: 'claude', value: '--durable-marker' })
      .then((result) => {
        acknowledged = true
        return result
      })
    try {
      await Promise.race([gate.started.promise, writing])
      expect(acknowledged).toBe(false)
      expect(readState().settings.agentDefaultArgs.claude).toBe(before)
    } finally {
      gate.finish.resolve()
    }
    expect((await writing).agentDefaultArgs.claude).toBe('--durable-marker')
    expect(readState().settings.agentDefaultArgs.claude).toBe('--durable-marker')
  })

  it('rejects a failed disk write, rolls back its settings, and allows an explicit retry', async () => {
    const { store, authority, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    const before = store.getSettings().agentDefaultArgs?.claude
    authority.failNextWrite()
    try {
      await expect(
        controller.mutateAgentLaunch({
          type: 'arguments',
          agent: 'claude',
          value: '--retry-marker'
        })
      ).rejects.toThrow('profile_state_write_failed')
    } finally {
      await store.flushPendingOrThrowAsync().catch(() => {})
    }
    expect(store.getSettings().agentDefaultArgs?.claude).toBe(before)
    expect(readState().settings.agentDefaultArgs.claude).toBe(before)
    await controller.mutateAgentLaunch({
      type: 'arguments',
      agent: 'claude',
      value: '--retry-marker'
    })
    expect(readState().settings.agentDefaultArgs.claude).toBe('--retry-marker')
  })

  it('recomputes queued intents after a failed write instead of persisting its stale map', async () => {
    const { store, authority, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    const before = store.getSettings().agentDefaultArgs?.claude
    authority.failNextWrite()
    const gate = authority.pause()
    const first = controller.mutateAgentLaunch({
      type: 'arguments',
      agent: 'claude',
      value: '--failed-first'
    })
    const refused = expect(first).rejects.toThrow('profile_state_write_failed')
    const second = controller.mutateAgentLaunch({
      type: 'arguments',
      agent: 'codex',
      value: '--accepted-second'
    })
    try {
      await Promise.race([gate.started.promise, first.catch(() => {})])
    } finally {
      gate.finish.resolve()
    }
    await refused
    await second
    expect(readState().settings.agentDefaultArgs.claude).toBe(before)
    expect(readState().settings.agentDefaultArgs.codex).toBe('--accepted-second')
  })

  it('round-trips special environment names through normalization and SQLite, preserving unrelated edits', async () => {
    const { store, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    for (const name of ['__proto__', 'constructor', 'KEEP']) {
      await controller.mutateAgentLaunch({
        type: 'environment-set',
        agent: 'claude',
        name,
        value: `value-for-${name}`
      })
    }
    expect(store.getSettings().agentDefaultEnv?.claude).toMatchObject({
      ['__proto__']: 'value-for-__proto__',
      constructor: 'value-for-constructor',
      KEEP: 'value-for-KEEP'
    })
    expect(readState().settings.agentDefaultEnv.claude).toMatchObject({
      ['__proto__']: 'value-for-__proto__',
      constructor: 'value-for-constructor',
      KEEP: 'value-for-KEEP'
    })
    expect(controller.getAgentLaunch().environmentNames.claude).toEqual([
      'KEEP',
      '__proto__',
      'constructor'
    ])
  })

  it('preserves a newer legacy full-map write when an older mutation fails', async () => {
    const { store, authority, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    authority.failNextWrite()
    const gate = authority.pause()
    const first = controller.mutateAgentLaunch({
      type: 'arguments',
      agent: 'claude',
      value: '--failed-first'
    })
    const refused = expect(first).rejects.toThrow('profile_state_write_failed')
    try {
      await gate.started.promise
      store.updateSettings({
        agentDefaultArgs: { ...store.getSettings().agentDefaultArgs, claude: '--newer-write' }
      })
    } finally {
      gate.finish.resolve()
    }
    await refused
    expect(store.getSettings().agentDefaultArgs?.claude).toBe('--newer-write')
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.agentDefaultArgs.claude).toBe('--newer-write')
  })
})
