import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'

vi.mock('./effective-hook-config', () => ({
  getEffectiveHooksFromConfig: () => {
    const command =
      process.platform === 'win32' ? 'echo %ORCA_HOOK_TYPE%' : 'printf %s "$ORCA_HOOK_TYPE"'
    return { scripts: { setup: command, archive: command, remove: command } }
  }
}))

afterEach(() => vi.unstubAllEnvs())

describe('native lifecycle hook intent', () => {
  it.each(['setup', 'archive', 'remove'] as const)(
    'exports %s intent even if its parent has a different marker',
    async (kind) => {
      const { runHook } = await import('./hooks')
      const repo: Repo = {
        id: 'fixture',
        path: process.cwd(),
        displayName: 'fixture',
        badgeColor: '#000',
        addedAt: 0
      }
      vi.stubEnv('ORCA_HOOK_TYPE', 'inherited-wrong-intent')
      const result = await runHook(kind, repo.path, repo)
      expect(result).toEqual({ success: true, output: kind })
    }
  )
})
