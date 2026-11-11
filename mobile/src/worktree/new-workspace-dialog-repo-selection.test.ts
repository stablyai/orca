import { describe, expect, it } from 'vitest'
import { refreshMobileNewWorkspaceDialogSelectedRepo } from './new-workspace-dialog-repo-selection'

type Repo = {
  id: string
  path: string
  connectionId?: string | null
  executionHostId?: 'local' | `ssh:${string}` | `runtime:${string}` | null
}

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/${id}`,
    ...overrides
  }
}

describe('mobile new workspace dialog repo selection', () => {
  it('keeps a repo picked on a server when the desktop lists one with the same id', () => {
    const onDesktop = makeRepo('repo', { path: '/mac/repo' })
    const onServer = makeRepo('repo', { path: '/srv/repo', executionHostId: 'runtime:env-1' })

    expect(refreshMobileNewWorkspaceDialogSelectedRepo([onDesktop, onServer], onServer)).toBe(
      onServer
    )
    expect(refreshMobileNewWorkspaceDialogSelectedRepo([onDesktop], onServer)).toBe(null)
  })
})
