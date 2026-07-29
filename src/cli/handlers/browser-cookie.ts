import { isAbsolute, resolve } from 'node:path'
import type {
  BrowserCookieDeleteResult,
  BrowserCookieGetResult,
  BrowserCookieImportFromFileResult,
  BrowserCookieSetResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getBrowserCommandTarget } from '../selectors'

function getOptionalCookieExpiry(flags: Map<string, string | boolean>): number | undefined {
  if (!flags.has('expires')) {
    return undefined
  }
  const rawExpires = flags.get('expires')
  if (typeof rawExpires !== 'string' || rawExpires.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --expires.')
  }
  const expires = Number(rawExpires)
  if (!Number.isFinite(expires) || expires < 0) {
    throw new RuntimeClientError('invalid_argument', `Invalid --expires value: ${rawExpires}`)
  }
  return expires
}

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
    const expires = getOptionalCookieExpiry(flags)
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
    if (expires !== undefined) {
      params.expires = expires
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
  },
  // Why: bulk import targets a session profile partition so cookies persist; one-shot CDP set does not.
  'cookie import': async ({ flags, client, cwd, json }) => {
    const fileFlag = getRequiredStringFlag(flags, 'file')
    const file = isAbsolute(fileFlag) ? fileFlag : resolve(cwd, fileFlag)
    const profileId = getOptionalStringFlag(flags, 'profile')
    const params: { file: string; profileId?: string } = { file }
    if (profileId) {
      params.profileId = profileId
    }
    const result = await client.call<BrowserCookieImportFromFileResult>(
      'browser.cookie.import',
      params
    )
    if (!result.result.ok) {
      throw new RuntimeClientError('invalid_argument', result.result.reason)
    }
    printResult(result, json, (value) => {
      if (!value.ok) {
        return value.reason
      }
      const summary = value.summary
      const domainPart =
        summary.domains.length > 0 ? ` across ${summary.domains.length} domain(s)` : ''
      const skipPart = summary.skippedCookies > 0 ? ` (${summary.skippedCookies} skipped)` : ''
      return `Imported ${summary.importedCookies}/${summary.totalCookies} cookies${domainPart} into profile ${value.profileId}${skipPart}`
    })
  }
}
