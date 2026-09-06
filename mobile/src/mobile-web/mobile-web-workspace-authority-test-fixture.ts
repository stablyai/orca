import {
  mobileWebHostWorkspaceIdFromHost,
  MobileWebWorkspaceAuthority
} from './mobile-web-workspace-authority'

export function createMobileWebWorkspaceAuthorityFixture(
  pageWorkspaceId = 'workspace-1',
  hostWorkspaceId = 'workspace-1'
): MobileWebWorkspaceAuthority {
  const authority = new MobileWebWorkspaceAuthority(() => new Uint8Array(16).fill(11))
  authority.synchronize([{ workspaceId: hostWorkspaceId, repoId: 'repo-1' }])
  const generatedPageWorkspaceId = authority.pageWorkspaceId(hostWorkspaceId)
  if (pageWorkspaceId !== generatedPageWorkspaceId) {
    authority.hostWorkspaceId = (candidate: string) => {
      if (candidate !== pageWorkspaceId) {
        throw new Error('not_found')
      }
      return mobileWebHostWorkspaceIdFromHost(hostWorkspaceId)
    }
  }
  return authority
}
