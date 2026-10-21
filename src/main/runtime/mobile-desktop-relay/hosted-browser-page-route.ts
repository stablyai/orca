import { z } from 'zod'
import type { RpcRequest } from '../rpc/core'
import { browserScreencastSubscriptionPageId } from '../browser-screencast-subscription-id'

const BrowserCallParams = z.looseObject({
  page: z.string().optional(),
  subscriptionId: z.string().optional()
})

/**
 * The call rewritten for this desktop's own runtime when the page it targets is a client-placed
 * page this desktop renders for that server, or null when the call belongs to the server.
 * Why: the server cannot screencast a page it does not render; the desktop serves it as its renderer does.
 */
export function localHostedBrowserPageRequest(
  request: RpcRequest,
  environmentId: string,
  hostsBrowserPage: (environmentId: string, browserPageId: string) => boolean
): RpcRequest | null {
  // Why: tabCreate's page is the id for a new page, and placing pages is the server's.
  if (!request.method.startsWith('browser.') || request.method === 'browser.tabCreate') {
    return null
  }
  const parsed = BrowserCallParams.safeParse(request.params)
  if (!parsed.success) {
    return null
  }
  // The selector names the server's workspace, which this desktop cannot resolve; the page id is stable.
  const { worktree: _serverSelector, ...params } = parsed.data
  const page =
    request.method === 'browser.screencast.unsubscribe'
      ? browserScreencastSubscriptionPageId(params.subscriptionId ?? '')
      : params.page || null
  if (page === null || !hostsBrowserPage(environmentId, page)) {
    return null
  }
  return { ...request, params }
}
