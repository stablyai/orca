import { describe, expect, it, vi } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { migrateAgentLaunchProfile } from '../persistence/applying-settings/terminal-settings-migrations'

const CLAUDE_BYPASS = '--dangerously-skip-permissions'
const CODEX_BYPASS = '--dangerously-bypass-approvals-and-sandbox'

function controllerFor(initial: GlobalSettings) {
  let settings = initial
  const store = {
    getSettings: () => settings,
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: get()/update() read only getSettings/updateSettings on this path.
  return { controller: new RuntimeClientSettingsController(store as never), store }
}

type Case = { agent: TuiAgent; args?: string; env?: Record<string, string> }

const CASES: Case[] = [
  { agent: 'claude', args: '' },
  { agent: 'claude', args: CLAUDE_BYPASS },
  { agent: 'claude', args: `--model opus ${CLAUDE_BYPASS}` },
  { agent: 'claude', args: '--permission-mode bypassPermissions' },
  { agent: 'claude', args: '--permission-mode acceptEdits' },
  { agent: 'claude', args: `${CLAUDE_BYPASS} --permission-mode plan` },
  { agent: 'claude', args: '--allow-dangerously-skip-permissions' },
  { agent: 'claude', args: `--append-system-prompt "${CLAUDE_BYPASS}"` },
  { agent: 'claude', args: `"${CLAUDE_BYPASS}"` },
  { agent: 'codex', args: '--yolo' },
  { agent: 'codex', args: '-a never -s danger-full-access' },
  { agent: 'codex', args: '"-a" on-request' },
  { agent: 'codex', args: `-m o3 ${CODEX_BYPASS}` },
  { agent: 'gemini', args: '-y' },
  { agent: 'devin', args: '--permission-mode bypass' },
  { agent: 'devin', args: '--permission-mode bypass --model x' },
  { agent: 'devin', args: '--respect-workspace-trust false' },
  { agent: 'devin', args: '--respect-workspace-trust true' },
  { agent: 'devin', args: '--permission-mode bypass --respect-workspace-trust true' },
  { agent: 'grok', args: '--permission-mode=bypassPermissions' },
  { agent: 'cline', args: '--auto-approve false' },
  { agent: 'continue', args: '--allow Read' },
  { agent: 'goose', env: { GOOSE_MODE: 'auto' } },
  { agent: 'goose', env: { GOOSE_MODE: 'approve', FOO: '1' } }
]
// 'accept-edits' stands for a mode a newer build wrote.
const DEFAULTS = ['bypass', 'ask', 'accept-edits']
const OVERRIDES = [undefined, 'bypass', 'ask', 'accept-edits']

function hostSettings({ agent, args, env }: Case, mode: string, override: string | undefined) {
  return {
    ...createGlobalSettingsFixture({ workspaceDir: '/w' }),
    agentPermissionMode: mode,
    agentPermissionModeOverrides: override === undefined ? {} : { [agent]: override },
    agentDefaultArgs: args === undefined ? {} : { [agent]: args },
    agentDefaultEnv: env === undefined ? {} : { [agent]: env }
  }
}

const MATRIX = CASES.flatMap((c) =>
  DEFAULTS.flatMap((mode) => OVERRIDES.map((override) => [c, mode, override] as const))
)

// Older paired clients read settings.get and write the whole record back through settings.update.
describe('agent launch settings: get, unchanged write, get', () => {
  it.each(MATRIX)('is a fixed point for %j, default %s, override %s', async (c, mode, override) => {
    const initial = hostSettings(c, mode, override)
    const { controller, store } = controllerFor(initial)
    const before = controller.get()

    await controller.update({
      agentDefaultArgs: before.agentDefaultArgs,
      agentDefaultEnv: before.agentDefaultEnv
    })

    const after = controller.get()
    expect(after.agentDefaultArgs).toEqual(before.agentDefaultArgs)
    expect(after.agentDefaultEnv).toEqual(before.agentDefaultEnv)
    const stored = store.getSettings()
    expect(stored.agentPermissionMode).toBe(mode)
    expect(stored.agentPermissionModeOverrides).toEqual(initial.agentPermissionModeOverrides)
    expect(stored.agentDefaultArgs?.[c.agent]).toBe(initial.agentDefaultArgs[c.agent])
  })
})

describe('agent launch settings: one lift for load and write', () => {
  // The write lift must store what the load lift would keep; it used to rewrite this to the
  // current Devin flag while a load left it alone.
  it("stores an older client's short Devin bypass as written", async () => {
    const { controller, store } = controllerFor(
      hostSettings({ agent: 'devin', args: '' }, 'ask', undefined)
    )

    await controller.update({ agentDefaultArgs: { devin: '--permission-mode bypass' } })

    expect(store.getSettings().agentDefaultArgs?.devin).toBe('--permission-mode bypass')
    expect(controller.get().agentDefaultArgs?.devin).toBe('--permission-mode bypass')
    const loaded = migrateAgentLaunchProfile(store.getSettings()).profile
    expect(loaded.agentDefaultArgs?.devin).toBe('--permission-mode bypass')
    expect(loaded.agentPermissionModeOverrides).toEqual(
      store.getSettings().agentPermissionModeOverrides
    )
  })

  it('keeps a stored mode a newer build wrote when a write names other agents', async () => {
    const { controller, store } = controllerFor(
      hostSettings({ agent: 'codex', args: '' }, 'bypass', 'accept-edits')
    )

    await controller.update({ agentDefaultArgs: { claude: '--model opus' } })

    expect(store.getSettings().agentPermissionModeOverrides).toEqual({
      codex: 'accept-edits',
      claude: 'ask'
    })
  })
})
