import { Store } from '../persistence/loading-store/store'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { newChatPermissionModeForSettings } from '../../shared/agent-chat-permission-mode'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  deferred,
  fixture
} from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createCodexAtRestSkillCatalog } from '../codex/codex-at-rest-skills-probe'
import type { CodexAppServerInvocation } from '../codex/codex-app-server-session'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { bindAtRestCommandContexts } from '../native-chat/agent-session-wire/at-rest-command-context'
import { structuredAgentConfiguredArgs } from '../native-chat/structured-agent-configured-args'

const hooks = vi.hoisted(() => ({ apply: vi.fn(async () => {}) }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: hooks.apply
}))

describe('durable execution-host launch settings', () => {
  it('persists host carrier edits and reloads the same terminal and new-chat intent', async () => {
    const { store, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    await controller.mutateAgentLaunch({ type: 'permission', choice: 'ask' })
    await controller.mutateAgentLaunch({ type: 'permission', choice: 'auto' })
    await controller.mutateAgentLaunch({
      type: 'user-arguments',
      agent: 'claude',
      value: '--append-system-prompt --dangerously-skip-permissions'
    })
    await controller.mutateAgentLaunch({
      type: 'user-arguments',
      agent: 'codex',
      value: '--config=sandbox_mode=read-only'
    })
    await controller.mutateAgentLaunch({
      type: 'permission',
      agent: 'goose',
      choice: 'full-access'
    })
    await controller.update({
      agentDefaultArgs: { ...controller.get().agentDefaultArgs, goose: '--model foo' }
    })
    await store.flushPendingOrThrowAsync()
    const saved = readState()
    const reloaded = new Store({
      serializedState: JSON.stringify(saved),
      dataFile: join(saved.settings.workspaceDir, 'permission-reload.json')
    })
    try {
      const settings = reloaded.getSettings()
      expect(resolveTuiAgentLaunchArgs('claude', settings)).toBe(
        '--permission-mode auto --append-system-prompt --dangerously-skip-permissions'
      )
      expect(resolveTuiAgentLaunchArgs('codex', settings)).toBe('--config=sandbox_mode=read-only')
      expect(resolveTuiAgentLaunchEnv('goose', settings)).toMatchObject({ GOOSE_MODE: 'auto' })
      expect(newChatPermissionModeForSettings('claude', settings)).toBe('auto')
      const loadedController = new RuntimeClientSettingsController(reloaded)
      expect(loadedController.get().agentDefaultArgs?.codex).toBe('--config=sandbox_mode=read-only')
      for (const agent of ['antigravity', 'opencode', 'opencode2', 'omp']) {
        expect(newChatPermissionModeForSettings(agent, reloaded.getSettings())).toBe('ask')
        expect(resolveTuiAgentLaunchArgs(agent, reloaded.getSettings())).toBe('')
      }
    } finally {
      await reloaded.freezeWritesAsync()
    }
  })

  it('replaces legacy maps, preserving absent carriers and clearing omitted user values', async () => {
    const { store, readState } = await fixture()
    store.updateSettings({
      agentPermissionDefault: 'own',
      agentPermissionOverrides: { claude: 'full-access', goose: 'full-access', opencode: 'ask' },
      agentDefaultArgs: { claude: '--model opus', codex: '--model old' },
      agentDefaultEnv: {
        claude: { ANTHROPIC_BASE_URL: 'http://old-proxy' },
        goose: { KEEP: 'custom' }
      }
    })
    const controller = new RuntimeClientSettingsController(store)
    await controller.update({ agentDefaultArgs: { codex: '--model new' } })
    expect(store.getSettings()).toMatchObject({
      agentDefaultArgs: { codex: '--model new' },
      agentDefaultEnv: {
        claude: { ANTHROPIC_BASE_URL: 'http://old-proxy' },
        goose: { KEEP: 'custom' }
      },
      agentPermissionOverrides: { claude: 'own', goose: 'full-access', opencode: 'ask' }
    })
    expect(store.getSettings().agentDefaultArgs).not.toHaveProperty('claude')
    await controller.update({ agentDefaultEnv: { goose: { GOOSE_MODE: 'auto', KEEP: 'new' } } })
    expect(store.getSettings().agentDefaultEnv).toEqual({ goose: { KEEP: 'new' } })
    expect(store.getSettings().agentDefaultArgs).toEqual({ codex: '--model new' })
    expect(resolveTuiAgentLaunchEnv('goose', store.getSettings())).toEqual({
      GOOSE_MODE: 'auto',
      KEEP: 'new'
    })
    await controller.update({ agentDefaultArgs: {}, agentDefaultEnv: {} })
    await store.flushPendingOrThrowAsync()
    const saved = readState().settings
    expect(saved.agentDefaultArgs).toEqual({})
    expect(saved.agentDefaultEnv).toEqual({})
    expect(saved.agentPermissionOverrides).toMatchObject({
      claude: 'own',
      goose: 'own',
      opencode: 'ask'
    })
    expect(controller.get().agentDefaultArgs?.claude).toBe('')
    expect(controller.get().agentDefaultEnv?.goose).toEqual({})
    expect(newChatPermissionModeForSettings('opencode', store.getSettings())).toBe('ask')
  })

  it('withdraws cached plugin skills when saved launch arguments disable plugins', async () => {
    const { store } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    await controller.mutateAgentLaunch({ type: 'arguments', agent: 'codex', value: '' })
    const calls: CodexAppServerInvocation[] = []
    const obsolete = deferred<void>()
    const catalog = createCodexAtRestSkillCatalog({
      resolveWorkspacePath: async () => '/fixture/work',
      resolveCommand: () => '/fixture/codex',
      resolveLaunchArgs: () => structuredAgentConfiguredArgs('codex', store.getSettings()),
      resolveEnvironment: async () => ({ PATH: '/fixture/bin' }),
      sleep: async () => {},
      runSession: async (invocation, body) => {
        calls.push(invocation)
        if (calls.length === 2) {
          await obsolete.promise
        }
        return body({
          request: async () => ({
            data: [
              {
                cwd: invocation.cwd,
                skills: invocation.args.includes('plugins')
                  ? []
                  : [{ name: 'qa-plugin:mark', path: '/fixture/plugin/SKILL.md' }]
              }
            ]
          }),
          notify: () => {}
        })
      }
    })
    const record = agentSessionRecordFixture({
      sessionId: 'resting-codex',
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/fixture/home' }
    })
    const release = bindAtRestCommandContexts([catalog])
    try {
      expect(catalog.read(record)).toBeUndefined()
      await catalog.settled(record, 1000)
      expect(catalog.read(record)?.some((row) => row.name === 'qa-plugin:mark')).toBe(true)
      expect(calls).toHaveLength(1)
      catalog.retireContext()
      const started = Date.now()
      const bounded = catalog.settled(record, 1000)
      await vi.waitFor(() => expect(calls).toHaveLength(2))
      await controller.mutateAgentLaunch({
        type: 'arguments',
        agent: 'codex',
        value: '--disable plugins'
      })
      expect(catalog.read(record)).toBeUndefined()
      expect((await bounded)?.some((row) => row.name === 'qa-plugin:mark')).toBe(false)
      expect(Date.now() - started).toBeLessThan(1000)
      obsolete.resolve()
      expect(catalog.read(record)?.some((row) => row.name === 'qa-plugin:mark')).toBe(false)
      expect(calls.map(({ args }) => args)).toEqual([
        ['app-server'],
        ['app-server'],
        ['--disable', 'plugins', 'app-server']
      ])
    } finally {
      obsolete.resolve()
      release()
    }
  })

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

  it('rolls back a legacy default request when the database write fails', async () => {
    const { store, authority } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    const before = store.getSettings().defaultTuiAgent
    authority.failNextWrite()
    try {
      await expect(
        controller.mutateAgentLaunch({ type: 'default', agent: 'blank', setupOnly: true })
      ).rejects.toThrow('profile_state_write_failed')
    } finally {
      await store.flushPendingOrThrowAsync().catch(() => {})
    }
    expect(store.getSettings().defaultTuiAgent).toBe(before)
    expect(store.getSettings().newWorkspaceSetupOnly).toBe(false)
    await controller.mutateAgentLaunch({ type: 'default', agent: 'blank', setupOnly: true })
    expect(controller.getAgentLaunch()).toMatchObject({
      defaultTuiAgent: 'blank',
      newWorkspaceSetupOnly: false
    })
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

  it('rolls back the new-chat default with a failed permission preset', async () => {
    const { store, authority, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    const before = store.getSettings().nativeChatPermissionMode
    authority.failNextWrite()
    try {
      await expect(
        controller.mutateAgentLaunch({ type: 'permissions', syncNativeChat: true, mode: 'auto' })
      ).rejects.toThrow('profile_state_write_failed')
    } finally {
      await store.flushPendingOrThrowAsync().catch(() => {})
    }
    expect(store.getSettings().nativeChatPermissionMode).toBe(before)
    expect(readState().settings.nativeChatPermissionMode).toBe(before)
    await controller.mutateAgentLaunch({ type: 'permissions', syncNativeChat: true, mode: 'auto' })
    expect(readState().settings.nativeChatPermissionMode).toBe(before)
    expect(readState().settings.agentNativeChatPermissionModes).toEqual({
      claude: 'auto',
      codex: 'auto'
    })
  })

  it('rolls back a scoped chat default after a failed write and persists a retry', async () => {
    const { store, authority, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    const beforeArgs = store.getSettings().agentDefaultArgs?.codex
    const beforeNative = store.getSettings().nativeChatPermissionMode
    authority.failNextWrite()
    try {
      await expect(
        controller.mutateAgentLaunch({
          type: 'permissions',
          syncNativeChat: true,
          agent: 'codex',
          mode: 'auto'
        })
      ).rejects.toThrow('profile_state_write_failed')
    } finally {
      await store.flushPendingOrThrowAsync().catch(() => {})
    }
    expect(store.getSettings().agentDefaultArgs?.codex).toBe(beforeArgs)
    expect(store.getSettings().agentNativeChatPermissionModes).toEqual({})
    await controller.mutateAgentLaunch({
      type: 'permissions',
      syncNativeChat: true,
      agent: 'codex',
      mode: 'auto'
    })
    expect(readState().settings.agentNativeChatPermissionModes).toEqual({ codex: 'auto' })
    expect(readState().settings.nativeChatPermissionMode).toBe(beforeNative)
    expect(readState().settings.agentPermissionOverrides).toMatchObject({ codex: 'auto' })
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

  it('preserves a newer agent choice when a pending legacy default write fails', async () => {
    const { store, authority } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    authority.failNextWrite()
    const gate = authority.pause()
    const first = controller.mutateAgentLaunch({ type: 'default', agent: 'blank', setupOnly: true })
    const refused = expect(first).rejects.toThrow('profile_state_write_failed')
    try {
      await gate.started.promise
      store.updateSettings({ defaultTuiAgent: 'codex', newWorkspaceSetupOnly: false })
    } finally {
      gate.finish.resolve()
    }
    await refused
    expect(controller.getAgentLaunch()).toMatchObject({
      defaultTuiAgent: 'codex',
      newWorkspaceSetupOnly: false
    })
    await store.flushPendingOrThrowAsync()
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
