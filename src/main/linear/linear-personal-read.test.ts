import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearWorkspace } from '../../shared/linear/workspace-types'
import { normalizeWorkspace } from './linear-workspace-record'

class AuthenticationError extends Error {}
const mocks = vi.hoisted<{
  profileId: string
  workspace: LinearWorkspace | undefined
  viewer: ReturnType<typeof vi.fn<() => Promise<unknown>>>
  clear: ReturnType<typeof vi.fn>
  credentialError: string | undefined
  recordError: ReturnType<typeof vi.fn>
}>(() => ({
  profileId: 'profile-a',
  workspace: undefined,
  viewer: vi.fn<() => Promise<unknown>>(),
  clear: vi.fn(),
  credentialError: undefined,
  recordError: vi.fn()
}))
vi.mock('../orca-profiles/profile-index-store', () => ({
  getOrcaProfileListState: () => ({ activeProfileId: mocks.profileId })
}))
vi.mock('./linear-workspace-registry', () => ({
  getWorkspaceState: () => ({ workspaces: mocks.workspace ? [mocks.workspace] : [] }),
  getCredentialError: () => mocks.credentialError,
  recordCredentialError: mocks.recordError
}))
vi.mock('./client', () => ({
  getClient: () => ({
    get viewer() {
      return mocks.viewer()
    }
  }),
  isAuthError: (error: unknown) => error instanceof AuthenticationError
}))
vi.mock('./linear-token-store', () => ({ clearToken: mocks.clear }))
import { readWithVerifiedLinearViewer } from './linear-personal-read'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.profileId = 'profile-a'
  mocks.credentialError = undefined
  mocks.workspace = {
    id: 'org',
    organizationId: 'org',
    organizationName: 'Org',
    displayName: 'Ada',
    email: null,
    viewerId: 'viewer-a',
    credentialOwnerProfileId: 'profile-a',
    credentialRevision: 4,
    credentialEpoch: 'epoch-a'
  }
  mocks.viewer.mockResolvedValue({ id: 'viewer-a', organization: Promise.resolve({ id: 'org' }) })
})

describe('verified personal Linear reads', () => {
  it('verifies before reading and returns the full cache namespace', async () => {
    const read = vi.fn().mockResolvedValue('data')
    await expect(readWithVerifiedLinearViewer('org', read)).resolves.toEqual({
      scope: {
        profileId: 'profile-a',
        workspaceId: 'org',
        viewerId: 'viewer-a',
        credentialRevision: 4,
        credentialEpoch: 'epoch-a'
      },
      data: 'data'
    })
    expect(mocks.viewer.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]!)
  })

  it.each(['absent', 'legacy', 'older-rewrite', 'profile'] as const)(
    'refuses %s ownership before personal reads',
    async (kind) => {
      if (kind === 'absent') {
        mocks.workspace = undefined
      }
      if (kind === 'legacy' && mocks.workspace) {
        mocks.workspace.viewerId = undefined
      }
      if (kind === 'older-rewrite' && mocks.workspace) {
        const { viewerId: _dropped, ...olderRecord } = mocks.workspace
        mocks.workspace = normalizeWorkspace(olderRecord) ?? undefined
      }
      if (kind === 'profile') {
        mocks.profileId = 'profile-b'
      }
      const read = vi.fn()
      await expect(readWithVerifiedLinearViewer('org', read)).rejects.toThrow(/Reconnect|requires/)
      expect(read).not.toHaveBeenCalled()
      expect(mocks.viewer).not.toHaveBeenCalled()
    }
  )

  it.each([
    { id: 'other', organization: Promise.resolve({ id: 'org' }) },
    { id: 'viewer-a', organization: Promise.resolve({ id: 'other-org' }) }
  ])('refuses a changed provider identity', async (viewer) => {
    mocks.viewer.mockResolvedValue(viewer)
    const read = vi.fn()
    await expect(readWithVerifiedLinearViewer('org', read)).rejects.toThrow('identity changed')
    expect(read).not.toHaveBeenCalled()
    expect(mocks.recordError).toHaveBeenCalled()
  })

  it('discards in-flight data after a profile switch', async () => {
    await expect(
      readWithVerifiedLinearViewer('org', async () => {
        mocks.profileId = 'profile-b'
        return 'private data'
      })
    ).rejects.toThrow('profile changed')
  })

  it('discards in-flight data after disconnect and reconnect, even to the same viewer', async () => {
    await expect(
      readWithVerifiedLinearViewer('org', async () => {
        if (mocks.workspace) {
          mocks.workspace = { ...mocks.workspace, credentialEpoch: 'epoch-b' }
        }
        return 'private data'
      })
    ).rejects.toThrow('connection')
  })

  it('refuses a revoked credential and clears it', async () => {
    mocks.viewer.mockRejectedValue(new AuthenticationError('revoked'))
    await expect(readWithVerifiedLinearViewer('org', vi.fn())).rejects.toThrow('revoked')
    expect(mocks.clear).toHaveBeenCalledWith('org')
  })

  it('never clears a replacement credential after an old request fails', async () => {
    await expect(
      readWithVerifiedLinearViewer('org', async () => {
        if (mocks.workspace) {
          mocks.workspace = { ...mocks.workspace, credentialEpoch: 'epoch-b' }
        }
        throw new AuthenticationError('old revoked token')
      })
    ).rejects.toThrow('revoked')
    expect(mocks.clear).not.toHaveBeenCalled()
  })
})
