import { z } from 'zod'
import type { RpcRequest } from '../rpc/core'
import { browserScreencastSubscriptionPageId } from '../browser-screencast-subscription-id'

const BrowserCallParams = z.looseObject({
  page: z.string().optional(),
  subscriptionId: z.string().optional()
})

/** Rewrite calls for locally rendered client-placed pages; their server cannot screencast them. */
export function localHostedBrowserPageRequest(
  request: RpcRequest,
  environmentId: string,
  hostsBrowserPage: (environmentId: string, browserPageId: string) => boolean
): RpcRequest | null {
  // tabCreate names a new page; the server owns placement.
  if (!request.method.startsWith('browser.') || request.method === 'browser.tabCreate') {
    return null
  }
  const parsed = BrowserCallParams.safeParse(request.params)
  if (!parsed.success) {
    return null
  }
  // Server workspace selectors cannot resolve here; page ids are stable.
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
