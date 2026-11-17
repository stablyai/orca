// Share links for an Orca Cloud workspace port, over the same authenticated control-plane request
// as the lifecycle client.
import {
  ShareLinkListResponseSchema,
  ShareLinkResponseSchema,
  ShareVisitResponseSchema,
  type ShareCreateRequest,
  type ShareLink
} from '../../shared/hosted-sandbox/hosted-sandbox-share-wire'
import type { HostedSandboxRequest } from './hosted-sandbox-control-plane-client'

export type HostedSandboxShareClient = {
  list(sandboxId: string): Promise<ShareLink[]>
  create(sandboxId: string, body: ShareCreateRequest): Promise<ShareLink>
  revoke(sandboxId: string, shareId: string): Promise<ShareLink>
  /** A URL this user can open: the link itself, or a one-time sign-in URL for team-only links. */
  visitUrl(shareUrl: string): Promise<string>
}

export function createHostedSandboxShareClient(
  call: HostedSandboxRequest
): HostedSandboxShareClient {
  const sharesPath = (sandboxId: string, suffix = ''): string =>
    `v1/sandboxes/${encodeURIComponent(sandboxId)}/shares${suffix}`
  return {
    list: async (sandboxId) =>
      (await call('GET', sharesPath(sandboxId), ShareLinkListResponseSchema, { kind: 'control' }))
        .shares,
    create: async (sandboxId, body) =>
      (
        await call('POST', sharesPath(sandboxId), ShareLinkResponseSchema, {
          body,
          kind: 'control'
        })
      ).share,
    revoke: async (sandboxId, shareId) =>
      (
        await call(
          'DELETE',
          sharesPath(sandboxId, `/${encodeURIComponent(shareId)}`),
          ShareLinkResponseSchema,
          { kind: 'control' }
        )
      ).share,
    visitUrl: async (shareUrl) => {
      const token = shareToken(shareUrl)
      if (!token) {
        return shareUrl
      }
      return (
        await call('POST', `v1/shares/${token}/visit`, ShareVisitResponseSchema, {
          kind: 'control'
        })
      ).url
    }
  }
}

/** The token in a path-mode (`/s/<token>/`) or subdomain-mode (`https://<token>.<suffix>/`) link. */
export function shareToken(shareUrl: string): string | null {
  try {
    const url = new URL(shareUrl)
    const fromPath = /^\/s\/([0-9a-f]{52})\//.exec(url.pathname)?.[1]
    const fromHost = /^([0-9a-f]{52})\./.exec(url.hostname)?.[1]
    return fromPath ?? fromHost ?? null
  } catch {
    return null
  }
}
