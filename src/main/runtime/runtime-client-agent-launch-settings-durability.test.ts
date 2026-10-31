import { structuredLaunchSeedOptions } from '../../shared/native-chat/input/native-chat-session-option-defaults'
import {
  adoptClaudeStructuredSpawnOptions,
  claudeStructuredSpawnOptions
} from '../claude/claude-structured-spawn-options'
import { applyClaudeMessageOptions } from '../claude/claude-structured-message-options'
import { sessionFor } from '../claude/claude-structured-dispatch-test-support'
import { fakeClaude } from '../claude/claude-structured-session-test-support'
import { readAgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import { resolveAgentLaunchCommand } from '../../shared/tui-agent-launch-command'
import { quoteStartupArg, tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  DEFAULT_TUI_AGENT_ARGS,
  DEFAULT_TUI_AGENT_ENV,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { newChatPermissionModeForSettings } from '../../shared/agent-chat-permission-mode'
import { describe, expect, it, vi } from 'vitest'
import {
  deferred,
  fixture,
  withReopenedProfileStore
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

const emptyLoadedArgs = Object.fromEntries(
  Object.keys(DEFAULT_TUI_AGENT_ARGS).map((id) => [id, ''])
)
const emptyLoadedEnv = Object.fromEntries(Object.keys(DEFAULT_TUI_AGENT_ENV).map((id) => [id, {}]))

function legacyLaunchEditor(
  controller: RuntimeClientSettingsController,
  target: 'arguments' | 'user-arguments' | 'whole-map',
  wholeMapSettings: Partial<GlobalSettings> = {}
) {
  const publication = controller.getAgentLaunch()
  const text =
    target === 'user-arguments'
      ? publication.agentPermission?.userArgs.claude
      : publication.agentDefaultArgs.claude
  if (!text) {
    throw new Error('missing legacy publication')
  }
  const edit = (value: string) =>
    target === 'whole-map'
      ? controller.update({
          ...wholeMapSettings,
          agentDefaultArgs: { ...controller.get().agentDefaultArgs, claude: value }
        })
      : controller.mutateAgentLaunch({ type: target, agent: 'claude', value })
  return { text, edit }
}

describe('durable execution-host launch settings', () => {
  it('maps an old dropdown without clearing agent choices, persists it and publishes typed precedence', async () => {
    const { store, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    await controller.mutateAgentLaunch({
      type: 'permission',
      agent: 'claude',
      choice: 'full-access'
    })
    await controller.update({ nativeChatPermissionMode: 'ask' })
    await store.flushPendingOrThrowAsync()
    expect(readState().settings).toMatchObject({
      agentPermissionDefault: 'ask',
      agentPermissionOverrides: { claude: 'full-access' }
    })
    expect(controller.get().nativeChatPermissionMode).toBe('ask')
    expect(resolveTuiAgentLaunchArgs('claude', store.getSettings())).toBe(
      '--dangerously-skip-permissions'
    )
    expect(newChatPermissionModeForSettings('claude', store.getSettings())).toBe('full-access')
    store.updateSettings({ nativeChatPermissionMode: 'full-access', agentPermissionDefault: 'own' })
    await store.flushPendingOrThrowAsync()
    const saved = readState()
    expect(saved.settings.agentPermissionDefault).toBe('own')
    await withReopenedProfileStore(saved, 'legacy-permission-reload.json', (reloaded) => {
      expect(new RuntimeClientSettingsController(reloaded).get().nativeChatPermissionMode).toBe(
        'ask'
      )
      expect(newChatPermissionModeForSettings('claude', reloaded.getSettings())).toBe('full-access')
    })
  })

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
    await withReopenedProfileStore(saved, 'permission-reload.json', (reloaded) => {
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
    })
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
      agentDefaultArgs: { codex: '' },
      agentLaunchChoices: { codex: { model: 'new' } },
      agentDefaultEnv: {
        claude: { ANTHROPIC_BASE_URL: 'http://old-proxy' },
        goose: { KEEP: 'custom' }
      },
      agentPermissionOverrides: { claude: 'own', goose: 'full-access', opencode: 'ask' }
    })
    expect(store.getSettings().agentDefaultArgs).not.toHaveProperty('claude')
    await controller.update({ agentDefaultEnv: { goose: { GOOSE_MODE: 'auto', KEEP: 'new' } } })
    expect(store.getSettings().agentDefaultEnv).toEqual({ goose: { KEEP: 'new' } })
    expect(store.getSettings().agentDefaultArgs).toEqual({ codex: '' })
    expect(controller.get().agentDefaultArgs?.codex).toBe('-m new')
    expect(resolveTuiAgentLaunchEnv('goose', store.getSettings())).toEqual({
      GOOSE_MODE: 'auto',
      KEEP: 'new'
    })
    await controller.update({ agentDefaultArgs: {}, agentDefaultEnv: {} })
    await store.flushPendingOrThrowAsync()
    const saved = readState().settings
    expect(saved.agentLaunchChoices).toEqual({})
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
    await withReopenedProfileStore(readState(), 'cleared-launch-records.json', (reloaded) => {
      expect(reloaded.getSettings().agentLaunchChoices).toEqual({})
      expect(reloaded.getSettings().agentDefaultArgs).toEqual(emptyLoadedArgs)
      expect(reloaded.getSettings().agentDefaultEnv).toEqual(emptyLoadedEnv)
      const published = new RuntimeClientSettingsController(reloaded).get()
      expect(published.agentDefaultArgs?.codex).toBe('')
      expect(published.agentDefaultEnv?.goose).toEqual({})
    })
  })

  it('withdraws cached plugin skills when saved launch arguments disable plugins', async () => {
    const { store } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    await controller.mutateAgentLaunch({ type: 'arguments', agent: 'codex', value: '' })
    const calls: CodexAppServerInvocation[] = []
    const obsolete = deferred<void>()
    const catalog = createCodexAtRestSkillCatalog({
      resolveWorkspacePath: async () => process.cwd(),
      resolveCommand: () => ({ command: '/fixture/codex', prefixArgs: [] }),
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
    expect(readState().settings.nativeChatPermissionMode).toBe('auto')
    expect(readState().settings).not.toHaveProperty('agentNativeChatPermissionModes')
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
    expect(store.getSettings()).not.toHaveProperty('agentNativeChatPermissionModes')
    await controller.mutateAgentLaunch({
      type: 'permissions',
      syncNativeChat: true,
      agent: 'codex',
      mode: 'auto'
    })
    expect(readState().settings).not.toHaveProperty('agentNativeChatPermissionModes')
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

vi.mock('../claude/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))

it('conserves the canonical tuple through durable legacy edit, reopen, terminal/native consumption and removal', async () => {
  for (const target of ['arguments', 'user-arguments', 'whole-map'] as const) {
    const { store, readState } = await fixture()
    store.updateSettings({
      agentPermissionDefault: 'own',
      agentDefaultArgs: { claude: '--verbose', codex: '--search' },
      agentDefaultEnv: { claude: { KEEP: 'owner' } },
      agentLaunchChoices: { claude: { model: String.raw`org\model`, options: { effort: 'high' } } },
      nativeChatSessionOptions: {
        claude: { model: 'sonnet', valuesByModel: { sonnet: { effort: 'low' } } }
      }
    })
    const controller = new RuntimeClientSettingsController(store)
    const { text, edit } = legacyLaunchEditor(controller, target)
    await edit(`${text} --debug`)
    await store.flushPendingOrThrowAsync()
    const saved = readState()
    await withReopenedProfileStore(saved, `canonical-${target}.json`, async (reloaded) => {
      const settings = reloaded.getSettings()
      expect(settings.agentLaunchChoices?.claude).toEqual({
        model: String.raw`org\model`,
        options: { effort: 'high' }
      })
      expect(settings.agentDefaultArgs?.claude).toBe('--verbose --debug')
      expect(settings.agentDefaultArgs?.codex).toBe('--search')
      expect(settings.agentDefaultEnv?.claude).toEqual({ KEEP: 'owner' })
      const seed = structuredLaunchSeedOptions(settings, 'claude')
      expect(seed).toMatchObject({ model: String.raw`org\model`, effort: 'high' })
      const native = claudeStructuredSpawnOptions({
        launch: {
          options: { extraArgs: { model: 'configured-raw', 'add-dir': 'docs' } },
          resumesTranscript: false
        },
        saved: seed,
        effortFlag: 'supported',
        flagSettingsControl: 'supported'
      })
      expect(native.sdkOptions.model).toBe(String.raw`org\model`)
      expect(native.sdkOptions.effort).toBe('high')
      expect(native.sdkOptions.extraArgs).toEqual({ 'add-dir': 'docs' })
      const terminal = resolveAgentLaunchCommand({
        agent: 'claude',
        cmdOverrides: {},
        platform: 'darwin',
        shell: 'posix',
        agentArgs: settings.agentDefaultArgs?.claude,
        sessionOptions: seed
      })
      if (!terminal.ok) {
        throw new Error(terminal.error)
      }
      expect(tokenizeStartupCommand(terminal.command, 'posix')).toMatchObject({
        ok: true,
        tokens: [
          'claude',
          '--model',
          String.raw`org\model`,
          '--effort',
          'high',
          '--verbose',
          '--debug'
        ]
      })
      await edit('--verbose --debug')
      expect(store.getSettings().agentLaunchChoices?.claude).toBeUndefined()
      expect(structuredLaunchSeedOptions(store.getSettings(), 'claude')).toMatchObject({
        model: 'sonnet',
        effort: 'low'
      })
    })
  }
})

it('persists compound publication ownership through both DTOs and whole-map edits to terminal and native controls', async () => {
  const originalPlatform = process.platform
  for (const target of ['arguments', 'user-arguments', 'whole-map'] as const) {
    const { store, authority, readState } = await fixture()
    const expected = {
      agentPermissionDefault: 'own' as const,
      agentPermissionOverrides: { goose: 'full-access' as const },
      agentDefaultArgs: {
        ...emptyLoadedArgs,
        claude: `--settings ${quoteStartupArg('{"theme":"light"}', 'cmd')} --add-dir docs`,
        codex: '--search'
      },
      agentDefaultEnv: {
        claude: { KEEP: 'owner' },
        codex: { OTHER: 'sibling' },
        goose: { KEEP: 'permission-owner' }
      },
      agentLaunchChoices: {
        claude: { model: 'sonnet', options: { fastMode: 'true' } },
        codex: { model: 'gpt-5.6-sol' }
      },
      nativeChatSessionOptions: {
        claude: { model: 'sonnet', valuesByModel: { sonnet: { fastMode: false } } }
      }
    }
    const expectTuple = (settings: GlobalSettings) => {
      expect(settings.agentLaunchChoices).toEqual(expected.agentLaunchChoices)
      expect(settings.agentDefaultArgs).toEqual(expected.agentDefaultArgs)
      expect(settings.agentDefaultEnv).toEqual(expected.agentDefaultEnv)
      expect(settings.agentPermissionDefault).toBe(expected.agentPermissionDefault)
      expect(settings.agentPermissionOverrides).toEqual(expected.agentPermissionOverrides)
      expect(settings.nativeChatSessionOptions).toEqual(expected.nativeChatSessionOptions)
    }
    store.updateSettings({ ...expected, terminalWindowsShell: 'cmd.exe' })
    await store.flushPendingOrThrowAsync()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const controller = new RuntimeClientSettingsController(store)
      const { text, edit } = legacyLaunchEditor(controller, target, {
        machineName: 'accepted-generic-setting'
      })
      const before = store.getSettings()
      if (target === 'whole-map') {
        const published = controller.get()
        expect(published.agentDefaultEnv?.goose).toEqual({
          GOOSE_MODE: 'auto',
          KEEP: 'permission-owner'
        })
        const response = await controller.update({
          agentDefaultArgs: published.agentDefaultArgs,
          agentDefaultEnv: published.agentDefaultEnv
        })
        expectTuple(store.getSettings())
        expect(response.agentDefaultArgs).toEqual(published.agentDefaultArgs)
        expect(response.agentDefaultEnv).toEqual(published.agentDefaultEnv)
        await store.flushPendingOrThrowAsync()
        const unchanged = readState()
        expectTuple(unchanged.settings)
        await withReopenedProfileStore(
          unchanged,
          'unchanged-compound-publication.json',
          (unchangedReload) => {
            expectTuple(unchangedReload.getSettings())
            const reopened = new RuntimeClientSettingsController(unchangedReload).get()
            expect(reopened.agentDefaultArgs).toEqual(published.agentDefaultArgs)
            expect(reopened.agentDefaultEnv).toEqual(published.agentDefaultEnv)
          }
        )
      } else {
        await edit(text)
      }
      expectTuple(store.getSettings())
      authority.failNextWrite()
      const gate = authority.pause()
      const failed = controller.mutateAgentLaunch({
        type: 'arguments',
        agent: 'claude',
        value: '--model sonnet --debug'
      })
      const refused = expect(failed).rejects.toThrow('profile_state_write_failed')
      const accepted = edit(`${text} --debug`)
      try {
        await gate.started.promise
      } finally {
        gate.finish.resolve()
      }
      await refused
      await accepted
      await store.flushPendingOrThrowAsync()
      const saved = readState()
      expect(saved.settings.agentLaunchChoices).toEqual(before.agentLaunchChoices)
      await withReopenedProfileStore(saved, `compound-${target}.json`, async (reloaded) => {
        const settings = reloaded.getSettings()
        if (target === 'whole-map') {
          expect(saved.settings.machineName).toBe('accepted-generic-setting')
          expect(settings.machineName).toBe('accepted-generic-setting')
        }
        expect(settings.agentLaunchChoices).toEqual(before.agentLaunchChoices)
        expect(settings.agentDefaultEnv).toEqual(before.agentDefaultEnv)
        expect(settings.agentDefaultArgs?.codex).toBe('--search')
        expect(
          tokenizeStartupCommand(settings.agentDefaultArgs?.claude ?? '', 'cmd')
        ).toMatchObject({
          ok: true,
          tokens: ['--settings', '{"theme":"light"}', '--add-dir', 'docs', '--debug']
        })
        const seed = structuredLaunchSeedOptions(settings, 'claude')
        expect(seed).toMatchObject({ model: 'sonnet', fastMode: 'true', permissionMode: 'own' })
        const terminal = tokenizeStartupCommand(
          resolveTuiAgentLaunchArgs('claude', settings, undefined, 'cmd'),
          'cmd'
        )
        expect(terminal).toMatchObject({
          ok: true,
          tokens: [
            '--model',
            'sonnet',
            '--settings',
            '{"theme":"light","fastMode":true}',
            '--add-dir',
            'docs',
            '--debug'
          ]
        })
        const spawn = claudeStructuredSpawnOptions({
          launch: {
            options: {
              extraArgs: { settings: '{"theme":"light"}', 'add-dir': 'docs', debug: null }
            },
            resumesTranscript: false
          },
          saved: seed,
          effortFlag: 'supported',
          flagSettingsControl: 'supported'
        })
        expect(spawn.sdkOptions.model).toBe('sonnet')
        expect(spawn.sdkOptions.extraArgs).toEqual({
          settings: '{"theme":"light"}',
          'add-dir': 'docs',
          debug: null
        })
        expect(spawn.fastModeAtStart).toBe(true)
        const fake = fakeClaude({ settings: null })
        const connection = await fake.openConnection({
          pathToClaudeCodeExecutable: 'inert-claude',
          cwd: settings.workspaceDir,
          options: spawn.sdkOptions
        })
        const session = sessionFor()
        session.connection = connection
        session.options = spawn.options
        adoptClaudeStructuredSpawnOptions(session, { ...spawn, flagSettingsControl: 'supported' })
        const messageOptions = readAgentSessionExecutionOptions(seed)
        if (!messageOptions) {
          throw new Error('missing message choices')
        }
        await applyClaudeMessageOptions(session, messageOptions, undefined)
        expect(
          fake.connections[0].calls.filter((call) => call.subtype === 'apply_flag_settings')
        ).toEqual([{ subtype: 'apply_flag_settings', params: { settings: { fastMode: true } } }])
        expect(session.appliedInputOptions.get('fastMode')).toBe('true')
        await connection.close()
        await edit(
          `--model sonnet --settings ${quoteStartupArg('{"theme":"dark"}', 'cmd')} --add-dir docs --debug`
        )
        expect(store.getSettings().agentLaunchChoices?.claude).toEqual({ model: 'sonnet' })
        expect(structuredLaunchSeedOptions(store.getSettings(), 'claude')?.fastMode).toBe('false')
        expect(store.getSettings().agentDefaultEnv).toEqual(before.agentDefaultEnv)
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  }
})
