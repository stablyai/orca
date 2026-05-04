import type {
  BrowserCookieDeleteResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { getBrowserCommandTarget } from '../selectors'

export const BROWSER_COOKIE_HANDLERS: Record<string, CommandHandler> = {
  'cookie get': async ({ flags, client, cwd, json }) => {
    const url = getOptionalStringFlag(flags, 'url')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserCookieGetResult>('browser.cookie.get', {
      url,
      ...target
    })
    printResult(result, json, (v) => {
      if (v.cookies.length === 0) {
        return 'No cookies'
      }
      return v.cookies.map((c) => `${c.name}=${c.value} (${c.domain})`).join('\n')
    })
  },
  'cookie set': async ({ flags, client, cwd, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const value = getRequiredStringFlag(flags, 'value')
    const params: Record<string, unknown> = { name, value }
    const domain = getOptionalStringFlag(flags, 'domain')
    const path = getOptionalStringFlag(flags, 'path')
    const sameSite = getOptionalStringFlag(flags, 'sameSite')
    const expires = getOptionalStringFlag(flags, 'expires')
    if (domain) {
      params.domain = domain
    }
    if (path) {
      params.path = path
    }
    if (flags.has('secure')) {
      params.secure = true
    }
    if (flags.has('httpOnly')) {
      params.httpOnly = true
    }
    if (sameSite) {
      params.sameSite = sameSite
    }
    if (expires) {
      params.expires = Number(expires)
    }
    Object.assign(params, await getBrowserCommandTarget(flags, cwd, client))
    const result = await client.call<BrowserCookieSetResult>('browser.cookie.set', params)
    printResult(result, json, (v) =>
      v.success ? `Cookie "${name}" set` : `Failed to set cookie "${name}"`
    )
  },
  'cookie delete': async ({ flags, client, cwd, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const params: Record<string, unknown> = { name }
    const domain = getOptionalStringFlag(flags, 'domain')
    const url = getOptionalStringFlag(flags, 'url')
    if (domain) {
      params.domain = domain
    }
    if (url) {
      params.url = url
    }
    Object.assign(params, await getBrowserCommandTarget(flags, cwd, client))
    const result = await client.call<BrowserCookieDeleteResult>('browser.cookie.delete', params)
    printResult(result, json, () => `Cookie "${name}" deleted`)
  }
}
