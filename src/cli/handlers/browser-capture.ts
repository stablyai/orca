import type {
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserConsoleResult,
  BrowserInterceptDisableResult,
  BrowserInterceptEnableResult,
  BrowserInterceptedRequest,
  BrowserNetworkLogResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from '../flags'
import { getBrowserCommandTarget } from '../selectors'

export const BROWSER_CAPTURE_HANDLERS: Record<string, CommandHandler> = {
  'intercept enable': async ({ flags, client, cwd, json }) => {
    const params: Record<string, unknown> = {}
    const patternsStr = getOptionalStringFlag(flags, 'patterns')
    if (patternsStr) {
      params.patterns = patternsStr.split(',').map((p) => p.trim())
    }
    Object.assign(params, await getBrowserCommandTarget(flags, cwd, client))
    const result = await client.call<BrowserInterceptEnableResult>(
      'browser.intercept.enable',
      params
    )
    printResult(
      result,
      json,
      (v) => `Interception enabled for: ${(v.patterns ?? []).join(', ') || '*'}`
    )
  },
  'intercept disable': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserInterceptDisableResult>(
      'browser.intercept.disable',
      target
    )
    printResult(result, json, () => 'Interception disabled')
  },
  'intercept list': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<{ requests: BrowserInterceptedRequest[] }>(
      'browser.intercept.list',
      target
    )
    printResult(result, json, (v) => {
      if (v.requests.length === 0) {
        return 'No paused requests'
      }
      return v.requests.map((r) => `[${r.id}] ${r.method} ${r.url} (${r.resourceType})`).join('\n')
    })
  },
  'capture start': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserCaptureStartResult>('browser.capture.start', target)
    printResult(result, json, () => 'Capture started (console + network)')
  },
  'capture stop': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserCaptureStopResult>('browser.capture.stop', target)
    printResult(result, json, () => 'Capture stopped')
  },
  console: async ({ flags, client, cwd, json }) => {
    const params: Record<string, unknown> = {}
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    if (limit !== undefined) {
      params.limit = limit
    }
    Object.assign(params, await getBrowserCommandTarget(flags, cwd, client))
    const result = await client.call<BrowserConsoleResult>('browser.console', params)
    printResult(result, json, (v) => {
      if (v.entries.length === 0) {
        return 'No console entries'
      }
      return v.entries.map((e) => `[${e.level}] ${e.text}`).join('\n')
    })
  },
  network: async ({ flags, client, cwd, json }) => {
    const params: Record<string, unknown> = {}
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    if (limit !== undefined) {
      params.limit = limit
    }
    Object.assign(params, await getBrowserCommandTarget(flags, cwd, client))
    const result = await client.call<BrowserNetworkLogResult>('browser.network', params)
    printResult(result, json, (v) => {
      if (v.entries.length === 0) {
        return 'No network entries'
      }
      return v.entries.map((e) => `${e.status} ${e.url} (${e.mimeType}, ${e.size}B)`).join('\n')
    })
  }
}
