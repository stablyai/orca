import * as tuiAgentPermissions from '../../../../shared/agent-launch/permissions/tui-agent-permissions'

import { newChatPermissionModeForSettings } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { describe, expect, it, vi } from 'vitest'
import {
  deferred,
  fixture
} from '../../../persistence/loading-store/profile-writing/profile-state-delayed-authority-fixture'
import { RuntimeClientSettingsController } from './runtime-client-settings'

const hooks = vi.hoisted(() => ({ apply: vi.fn(async () => {}) }))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('../../../agent-hooks/installation/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: hooks.apply
}))
void Object.fromEntries(Object.keys(tuiAgentPermissions.YOLO_TUI_AGENT_ARGS).map((id) => [id, '']))
void Object.fromEntries(Object.keys(tuiAgentPermissions.YOLO_TUI_AGENT_ENV).map((id) => [id, {}]))

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

  it('rolls back a failed coupled launch choice and persists an explicit retry', async () => {
    const { store, authority, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    const before = store.getSettings()
    const mutation = {
      type: 'launch-choices',
      agent: 'claude',
      patch: { model: 'sonnet', options: { effort: 'high' }, permissionMode: 'ask' },
      userArgs: '--model sonnet --effort high --verbose'
    } as const
    authority.failNextWrite()
    try {
      await expect(controller.mutateAgentLaunch(mutation)).rejects.toThrow(
        'profile_state_write_failed'
      )
    } finally {
      await store.flushPendingOrThrowAsync().catch(() => {})
    }
    for (const settings of [store.getSettings(), readState().settings]) {
      expect(settings.agentDefaultArgs?.claude).toBe(before.agentDefaultArgs?.claude)
      expect(settings.agentLaunchChoices).toEqual(before.agentLaunchChoices)
      expect(settings.agentPermissionOverrides).toEqual(before.agentPermissionOverrides)
    }
    await controller.mutateAgentLaunch(mutation)
    expect(readState().settings).toMatchObject({
      agentDefaultArgs: { claude: '--verbose' },
      agentLaunchChoices: { claude: { model: 'sonnet', options: { effort: 'high' } } }
    })
    expect(newChatPermissionModeForSettings('claude', store.getSettings())).toBe('ask')
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

vi.mock('../../../claude/agent-view/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))
