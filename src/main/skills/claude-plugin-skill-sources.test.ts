import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveClaudePluginSkillSources } from './claude-plugin-skill-sources'

function installedPlugins(installs: Record<string, Record<string, unknown>[]>): string {
  return JSON.stringify({ version: 2, plugins: installs })
}

function settings(enabledPlugins: Record<string, boolean>): string {
  return JSON.stringify({ enabledPlugins })
}

describe('Claude plugin skill sources', () => {
  const pluginId = 'compound-engineering@compound-engineering-plugin'
  const projectPath = join('/workspace', 'orca')
  const cwd = join(projectPath, 'worktree')

  it('selects the applicable project install over a stale user version', () => {
    const roots = resolveClaudePluginSkillSources({
      cwd,
      metadata: {
        installedPlugins: installedPlugins({
          [pluginId]: [
            {
              scope: 'user',
              installPath: '/home/alice/.claude/plugins/cache/compound/3.13.1',
              lastUpdated: '2026-06-23T00:00:00.000Z'
            },
            {
              scope: 'project',
              projectPath,
              installPath: '/home/alice/.claude/plugins/cache/compound/3.14.3',
              lastUpdated: '2026-06-25T00:00:00.000Z'
            }
          ]
        }),
        settings: [settings({ [pluginId]: true })]
      }
    })

    expect(roots).toEqual([
      expect.objectContaining({
        label: 'Claude plugin compound-engineering',
        path: join('/home/alice/.claude/plugins/cache/compound/3.14.3', 'skills'),
        sourceKind: 'plugin',
        providers: ['claude'],
        owner: 'claude'
      })
    ])
  })

  it('falls back to the user install outside the project scope', () => {
    const roots = resolveClaudePluginSkillSources({
      cwd: '/workspace/another-project',
      metadata: {
        installedPlugins: installedPlugins({
          [pluginId]: [
            {
              scope: 'user',
              installPath: '/home/alice/.claude/plugins/cache/compound/user'
            },
            {
              scope: 'project',
              projectPath,
              installPath: '/home/alice/.claude/plugins/cache/compound/project'
            }
          ]
        }),
        settings: [settings({ [pluginId]: true })]
      }
    })

    expect(roots[0]?.path).toBe(join('/home/alice/.claude/plugins/cache/compound/user', 'skills'))
  })

  it('honors project and local settings overrides for disabled plugins', () => {
    const roots = resolveClaudePluginSkillSources({
      cwd,
      metadata: {
        installedPlugins: installedPlugins({
          [pluginId]: [
            {
              scope: 'project',
              projectPath,
              installPath: '/home/alice/.claude/plugins/cache/compound/3.14.3'
            }
          ]
        }),
        settings: [settings({ [pluginId]: true }), settings({ [pluginId]: false })]
      }
    })

    expect(roots).toEqual([])
  })

  it('chooses the newest applicable install within the same scope', () => {
    const roots = resolveClaudePluginSkillSources({
      cwd,
      metadata: {
        installedPlugins: installedPlugins({
          [pluginId]: [
            {
              scope: 'project',
              projectPath,
              installPath: '/home/alice/.claude/plugins/cache/compound/old',
              lastUpdated: '2026-01-01T00:00:00.000Z'
            },
            {
              scope: 'project',
              projectPath,
              installPath: '/home/alice/.claude/plugins/cache/compound/new',
              lastUpdated: '2026-07-01T00:00:00.000Z'
            }
          ]
        }),
        settings: [settings({ [pluginId]: true })]
      }
    })

    expect(roots[0]?.path).toBe(join('/home/alice/.claude/plugins/cache/compound/new', 'skills'))
  })
})
