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
  it('refreshes the selected repo from the fresh repo list', () => {
    const staleSelectedRepo = makeRepo('repo', { path: '/cached/repo' })
    const freshRepo = makeRepo('repo', { path: '/fresh/repo' })

    expect(refreshMobileNewWorkspaceDialogSelectedRepo([freshRepo], staleSelectedRepo)).toBe(
      freshRepo
    )
  })

  it('clears a cached selected repo that is missing from the fresh repo list', () => {
    expect(
      refreshMobileNewWorkspaceDialogSelectedRepo([makeRepo('fresh')], makeRepo('stale'))
    ).toBe(null)
  })

  it('keeps a repo picked on a server when the desktop lists one with the same id', () => {
    const onDesktop = makeRepo('repo', { path: '/mac/repo' })
    const onServer = makeRepo('repo', { path: '/srv/repo', executionHostId: 'runtime:env-1' })

    expect(refreshMobileNewWorkspaceDialogSelectedRepo([onDesktop, onServer], onServer)).toBe(
      onServer
    )
    expect(refreshMobileNewWorkspaceDialogSelectedRepo([onDesktop], onServer)).toBe(null)
  })
})
