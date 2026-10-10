import { beforeEach, describe, expect, it, vi } from 'vitest'

const { revokeMock } = vi.hoisted(() => ({ revokeMock: vi.fn(async () => {}) }))

vi.mock('./codex/codex-project-trust-revocation', () => ({
  revokeCodexProjectTrustForRemovedWorkspace: revokeMock
}))

const { revokeCodexTrustForRemovedLocalWorkspace } = await import('./workspace-removal-codex-trust')

const FOLDER_SESSION = '::workspace:0b5a1c7e-2f4d-4a8b-9c3e-1d2f3a4b5c6d'

function storeWith(ids: string[]): { getAllWorktreeMeta: () => Record<string, unknown> } {
  return { getAllWorktreeMeta: () => Object.fromEntries(ids.map((id) => [id, {}])) }
}

beforeEach(() => {
  revokeMock.mockClear()
})

describe('revokeCodexTrustForRemovedLocalWorkspace', () => {
  it('revokes a local workspace, passing the folders still in use', () => {
    revokeCodexTrustForRemovedLocalWorkspace(
      storeWith(['repo::/work/repo', `folders::/work/notes${FOLDER_SESSION}`]),
      `folders::/work/scratch${FOLDER_SESSION}`,
      'local'
    )

    expect(revokeMock).toHaveBeenCalledWith({
      removedRoot: '/work/scratch',
      remainingRoots: ['/work/repo', '/work/notes']
    })
  })

  it('treats a workspace with no recorded host as local', () => {
    revokeCodexTrustForRemovedLocalWorkspace(storeWith([]), 'repo::/work/repo-r1', undefined)

    expect(revokeMock).toHaveBeenCalledWith({ removedRoot: '/work/repo-r1', remainingRoots: [] })
  })

  it('leaves trust on an SSH host to that host', () => {
    revokeCodexTrustForRemovedLocalWorkspace(storeWith([]), 'repo::/home/me/repo-r1', 'ssh:devbox')

    expect(revokeMock).not.toHaveBeenCalled()
  })
})
