import { describe, expect, it } from 'vitest'
import { parseOrcaYaml } from '../shared/orca-yaml'
import { getEffectiveHooksFromConfig } from './effective-hook-config'
import type { Repo } from '../shared/repo-types'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}

describe('permanent removal configuration', () => {
  it('preserves a remove-only YAML script through parsing and effective selection', () => {
    const hooks = parseOrcaYaml('scripts:\n  remove: |\n    taskctl remove\n')
    expect(getEffectiveHooksFromConfig(repo, hooks)).toEqual({
      scripts: { remove: 'taskctl remove' }
    })
  })

  it('selects the local removal script independently of legacy archive', () => {
    const configured = {
      ...repo,
      hookSettings: {
        mode: 'auto' as const,
        scripts: { setup: '', archive: 'taskctl stop', remove: 'taskctl remove' }
      }
    }
    expect(getEffectiveHooksFromConfig(configured, null)).toEqual({
      scripts: { archive: 'taskctl stop', remove: 'taskctl remove' }
    })
  })
})
