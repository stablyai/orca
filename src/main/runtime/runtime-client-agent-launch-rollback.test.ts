import { expect, it, vi } from 'vitest'
import {
  fixture,
  withReopenedProfileStore
} from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { agentLaunchSettingsRollbackUpdates } from './agent-launch-settings-rollback'
import {
  agentPermissionChoices,
  PERMISSION_CHOICE_AGENTS,
  resolveAgentPermission
} from '../../shared/tui-agent-permission-choice'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('../claude/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: vi.fn(async () => {})
}))

it.each([false, true])(
  'durably removes every failed batch addition while preserving newer ownership (%s)',
  async (newer) => {
    const { store, authority, readState } = await fixture()
    const controller = new RuntimeClientSettingsController(store)
    store.updateSettings({
      agentPermissionDefault: 'ask',
      agentPermissionOverrides: {},
      agentLaunchChoices: {}
    })
    await store.flushPendingOrThrowAsync()
    const agents = PERMISSION_CHOICE_AGENTS.filter(
      (agent) => !agentPermissionChoices(agent).includes('auto')
    )
    expect(agents.length).toBeGreaterThan(2)
    const mutation = { type: 'permission', choice: 'full-access', withoutAuto: true } as const
    authority.failNextWrite()
    const gate = authority.pause()
    const writing = controller.mutateAgentLaunch(mutation)
    const refused = expect(writing).rejects.toThrow('profile_state_write_failed')
    try {
      await gate.started.promise
      if (newer) {
        // A generic writer owns this agent's entire newer tuple, independently of the batch.
        store.updateSettings({
          agentDefaultArgs: { ...store.getSettings().agentDefaultArgs, grok: '--debug' },
          agentLaunchChoices: { grok: { model: 'opaque-current' } },
          agentDefaultEnv: { ...store.getSettings().agentDefaultEnv, grok: { KEEP: 'newer' } },
          agentPermissionOverrides: {
            ...store.getSettings().agentPermissionOverrides,
            codex: 'own'
          }
        })
        await controller.update({ machineName: 'newer-host' })
      }
    } finally {
      gate.finish.resolve()
    }
    await refused
    const check = (settings: ReturnType<typeof store.getSettings>) => {
      for (const agent of agents) {
        if (newer && agent === 'grok') {
          expect(resolveAgentPermission(agent, settings).choice).toBe('full-access')
        } else {
          expect(settings.agentPermissionOverrides).not.toHaveProperty(agent)
          expect(resolveAgentPermission(agent, settings).choice).toBe('ask')
        }
      }
      if (newer) {
        expect(settings).toMatchObject({
          machineName: 'newer-host',
          agentDefaultArgs: { grok: '--debug' },
          agentLaunchChoices: { grok: { model: 'opaque-current' } },
          agentDefaultEnv: { grok: { KEEP: 'newer' } },
          agentPermissionOverrides: { codex: 'own' }
        })
      } else {
        expect(settings.agentPermissionOverrides).toEqual({})
      }
    }
    check(store.getSettings())
    await store.flushPendingOrThrowAsync()
    await withReopenedProfileStore(readState(), 'batch-rollback-reopen.json', (reopened) =>
      check(reopened.getSettings())
    )
    // Reopen is deliberately before the legitimate retry can conceal a stale failed value.
    await controller.mutateAgentLaunch(mutation)
    await withReopenedProfileStore(readState(), 'batch-retry-reopen.json', (reopened) => {
      for (const agent of agents) {
        expect(resolveAgentPermission(agent, reopened.getSettings()).choice).toBe('full-access')
      }
    })
  }
)

it('accumulates mixed restoration and omission while preserving each newer whole-agent tuple', () => {
  const before = {
    agentDefaultArgs: { claude: '--before' },
    agentLaunchChoices: { claude: { model: 'sonnet' } },
    agentPermissionOverrides: { claude: 'ask' },
    agentDefaultEnv: { claude: { KEEP: 'before' } }
  } as const
  const applied = {
    agentDefaultArgs: { claude: '--after', codex: '--added', grok: '--added' },
    agentLaunchChoices: {
      claude: { model: 'opus' },
      codex: { model: 'opaque' },
      grok: { model: 'opaque' }
    },
    agentPermissionOverrides: { claude: 'full-access', codex: 'full-access', grok: 'full-access' },
    agentDefaultEnv: { claude: { KEEP: 'after' }, codex: { ADDED: '1' }, grok: { ADDED: '1' } }
  } as const
  expect(agentLaunchSettingsRollbackUpdates(before, applied, applied, applied)).toEqual(before)
  const current = {
    ...applied,
    agentDefaultArgs: { ...applied.agentDefaultArgs, claude: '--verbose newest' },
    agentLaunchChoices: { ...applied.agentLaunchChoices, codex: { model: 'new-codex' } }
  }
  const restored = {
    ...current,
    ...agentLaunchSettingsRollbackUpdates(before, applied, current, applied)
  }
  for (const field of [
    'agentDefaultArgs',
    'agentLaunchChoices',
    'agentPermissionOverrides',
    'agentDefaultEnv'
  ] as const) {
    expect(restored[field]?.claude).toEqual(current[field].claude)
    expect(restored[field]?.codex).toEqual(current[field].codex)
    expect(restored[field]).not.toHaveProperty('grok')
  }
})
