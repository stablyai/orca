import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveInitializedSubmodulePathMock } = vi.hoisted(() => ({
  resolveInitializedSubmodulePathMock: vi.fn()
}))

vi.mock('../../../git/source-control/submodule-repos', () => ({
  resolveInitializedSubmodulePath: resolveInitializedSubmodulePathMock
}))

import { resolveGitActionPath } from './submodule-action-target'

beforeEach(() => {
  resolveInitializedSubmodulePathMock.mockReset().mockResolvedValue('/repo/libs/sub')
})

describe('resolveGitActionPath', () => {
  it('keeps the registered worktree when no submodule is named', async () => {
    await expect(resolveGitActionPath({}, '/repo', {})).resolves.toBe('/repo')
    expect(resolveInitializedSubmodulePathMock).not.toHaveBeenCalled()
  })

  it('runs in the submodule when one is named', async () => {
    await expect(resolveGitActionPath({ submodulePath: 'libs/sub' }, '/repo', {})).resolves.toBe(
      '/repo/libs/sub'
    )
    expect(resolveInitializedSubmodulePathMock).toHaveBeenCalledWith('/repo', 'libs/sub', {})
  })

  it('refuses the worktree fork push target for a submodule', async () => {
    await expect(
      resolveGitActionPath(
        { submodulePath: 'libs/sub', pushTarget: { remoteName: 'fork' } },
        '/repo',
        {}
      )
    ).rejects.toThrow('push target')
    expect(resolveInitializedSubmodulePathMock).not.toHaveBeenCalled()
  })

  it('passes a refusal from the submodule check to the caller', async () => {
    resolveInitializedSubmodulePathMock.mockRejectedValue(new Error('Access denied'))
    await expect(resolveGitActionPath({ submodulePath: '../x' }, '/repo', {})).rejects.toThrow(
      'Access denied'
    )
  })
})
