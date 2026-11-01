import { describe, expect, it, vi } from 'vitest'
import { TeamRole } from './project-team-config'
import { buildTeamLaunch } from './project-team-launch'

vi.mock('../ipc/command-path-resolver', () => ({
  resolveCommandOnLocalPath: vi.fn(async () => 'codex')
}))

describe('portable Codex project settings', () => {
  const input = {
    id: 'pm',
    title: 'PM',
    provider: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    instructions: ['role.md'],
    codexSettings: {
      model_auto_compact_token_limit: 332500,
      model_auto_compact_token_limit_scope: 'total'
    }
  }
  it('puts saved compact settings in the real launch command and restart arguments', async () => {
    const role = TeamRole.parse(input)
    const launch = await buildTeamLaunch(
      role,
      '/settings/team.json',
      '/projects/example',
      '/profile/context.md'
    )
    for (const text of [launch.command, launch.launchConfig.agentArgs]) {
      expect(text).toContain('model_auto_compact_token_limit=332500')
      expect(text).toContain('model_auto_compact_token_limit_scope=')
      expect(text).toContain('total')
      expect(text).toContain('model_reasoning_effort=')
    }
  })
  it('rejects invalid limits, unknown config keys and unsupported scopes', () => {
    for (const settings of [
      { model_auto_compact_token_limit: 0, model_auto_compact_token_limit_scope: 'total' },
      { model_auto_compact_token_limit: Infinity, model_auto_compact_token_limit_scope: 'total' },
      { model_auto_compact_token_limit: 332500, model_auto_compact_token_limit_scope: 'anything' },
      { ...input.codexSettings, arbitrary_command: 'not allowed' }
    ]) {
      expect(TeamRole.safeParse({ ...input, codexSettings: settings }).success).toBe(false)
    }
  })
})
