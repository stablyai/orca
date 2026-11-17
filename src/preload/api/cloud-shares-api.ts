import type {
  CloudShareResult,
  ShareCreateRequest,
  ShareLink
} from '../../shared/hosted-sandbox/hosted-sandbox-share-wire'

/** Share links for an Orca Cloud workspace's ports; every call answers `not_cloud` elsewhere. */
export type CloudSharesApi = {
  list: (args: { environmentId: string }) => Promise<CloudShareResult<{ shares: ShareLink[] }>>
  create: (args: {
    environmentId: string
    request: ShareCreateRequest
  }) => Promise<CloudShareResult<{ share: ShareLink }>>
  revoke: (args: {
    environmentId: string
    shareId: string
  }) => Promise<CloudShareResult<{ share: ShareLink }>>
  /** Opens an active link in the system browser, signing this user in first for team-only links. */
  open: (args: { environmentId: string; shareId: string }) => Promise<CloudShareResult<object>>
}
