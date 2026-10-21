import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RPC_PARAMS_BY_METHOD } from '../../../shared/rpc-contract/rpc-params-catalog.generated'
import { mintBrowserScreencastSubscriptionId } from '../browser-screencast-subscription-id'
import { EXECUTION_HOST_METHODS } from '../runtime-rpc/runtime-rpc-mobile-method-routing'
import { localHostedBrowserPageRequest } from './hosted-browser-page-route'

const hosts = (environmentId: string, browserPageId: string) =>
  environmentId === 'env-1' && browserPageId === 'hosted-page'

function request(method: string, params: unknown) {
  return { id: 'r', authToken: '', method, params, executionHost: 'runtime:env-1' }
}

const PARAMS_SCHEMAS = new Map<string, unknown>(Object.entries(RPC_PARAMS_BY_METHOD))
const RELAYED_BROWSER_METHODS = EXECUTION_HOST_METHODS.filter((method) =>
  method.startsWith('browser.')
)

describe('localHostedBrowserPageRequest', () => {
  it('serves a call on a page this desktop renders for that server, without the server selector', () => {
    expect(
      localHostedBrowserPageRequest(
        request('browser.mouseClick', { worktree: 'id:repo::/srv/wt', page: 'hosted-page', x: 1 }),
        'env-1',
        hosts
      )
    ).toEqual(request('browser.mouseClick', { page: 'hosted-page', x: 1 }))
  })

  it('serves the release of a screencast it started on that page', () => {
    const subscriptionId = mintBrowserScreencastSubscriptionId('hosted-page', 'nonce')
    expect(
      localHostedBrowserPageRequest(
        request('browser.screencast.unsubscribe', { subscriptionId }),
        'env-1',
        hosts
      )
    ).toEqual(request('browser.screencast.unsubscribe', { subscriptionId }))
  })

  it.each([
    ['a server page', 'browser.goto', { page: 'server-page' }, 'env-1'],
    ['another server', 'browser.goto', { page: 'hosted-page' }, 'env-2'],
    ['no page', 'browser.reload', {}, 'env-1'],
    ['a new page', 'browser.tabCreate', { page: 'hosted-page', url: 'http://a.test' }, 'env-1'],
    ['a non-browser method', 'github.listWorkItems', { page: 'hosted-page' }, 'env-1'],
    [
      'a server screencast',
      'browser.screencast.unsubscribe',
      { subscriptionId: mintBrowserScreencastSubscriptionId('server-page', 'nonce') },
      'env-1'
    ]
  ])('leaves %s to the server', (_label, method, params, environmentId) => {
    expect(localHostedBrowserPageRequest(request(method, params), environmentId, hosts)).toBeNull()
  })

  // Why: a relayed browser method that names its page some other way would silently reach the
  // server, which cannot serve a client-placed page.
  it('covers every relayed browser method that targets an existing page', () => {
    for (const method of RELAYED_BROWSER_METHODS) {
      const schema = PARAMS_SCHEMAS.get(method)
      const keys = schema instanceof z.ZodObject ? Object.keys(schema.shape) : []
      const params =
        method === 'browser.screencast.unsubscribe'
          ? { subscriptionId: mintBrowserScreencastSubscriptionId('hosted-page', 'nonce') }
          : { page: 'hosted-page' }
      expect({ method, keys: keys.filter((key) => key in params) }).toEqual({
        method,
        keys: Object.keys(params)
      })
      const local = localHostedBrowserPageRequest(request(method, params), 'env-1', hosts)
      // tabCreate's page names the page to create, so creation always stays on the server.
      expect({ method, local: local !== null }).toEqual({
        method,
        local: method !== 'browser.tabCreate'
      })
    }
  })
})
