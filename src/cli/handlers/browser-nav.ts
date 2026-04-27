import type {
  BrowserBackResult,
  BrowserEvalResult,
  BrowserGotoResult,
  BrowserPdfResult,
  BrowserReloadResult,
  BrowserScreenshotResult,
  BrowserScrollResult,
  BrowserSnapshotResult,
  BrowserWaitResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatScreenshot, formatSnapshot, printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getBrowserCommandTarget } from '../selectors'

// Why: selector/text/url waits can legitimately take longer than a normal RPC
// round-trip, even when Orca is healthy. Give browser.wait an explicit timeout
// budget so slow waits do not get mislabeled as "Orca is not running" by the
// generic client timeout path.
const DEFAULT_BROWSER_WAIT_RPC_TIMEOUT_MS = 60_000

export const BROWSER_NAV_HANDLERS: Record<string, CommandHandler> = {
  snapshot: async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserSnapshotResult>('browser.snapshot', target)
    printResult(result, json, formatSnapshot)
  },
  screenshot: async ({ flags, client, cwd, json }) => {
    const format = getOptionalStringFlag(flags, 'format')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserScreenshotResult>('browser.screenshot', {
      format: format === 'jpeg' ? 'jpeg' : undefined,
      ...target
    })
    printResult(result, json, formatScreenshot)
  },
  goto: async ({ flags, client, cwd, json }) => {
    const url = getRequiredStringFlag(flags, 'url')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    // Why: navigation waits for network idle which can exceed the default 15s RPC timeout
    const result = await client.call<BrowserGotoResult>(
      'browser.goto',
      { url, ...target },
      { timeoutMs: 60_000 }
    )
    printResult(result, json, (v) => `Navigated to ${v.url} — ${v.title}`)
  },
  back: async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserBackResult>('browser.back', target)
    printResult(result, json, (v) => `Back to ${v.url} — ${v.title}`)
  },
  reload: async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserReloadResult>('browser.reload', target, {
      timeoutMs: 60_000
    })
    printResult(result, json, (v) => `Reloaded ${v.url} — ${v.title}`)
  },
  forward: async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.forward', target)
    printResult(result, json, (v) => {
      const url = (v as { url?: string } | null | undefined)?.url
      return url ? `Navigated forward to ${url}` : 'Navigated forward'
    })
  },
  eval: async ({ flags, client, cwd, json }) => {
    const expression = getRequiredStringFlag(flags, 'expression')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserEvalResult>('browser.eval', { expression, ...target })
    printResult(result, json, (v) => v.result)
  },
  scroll: async ({ flags, client, cwd, json }) => {
    const direction = getRequiredStringFlag(flags, 'direction')
    if (direction !== 'up' && direction !== 'down') {
      throw new RuntimeClientError('invalid_argument', '--direction must be "up" or "down"')
    }
    const amount = getOptionalPositiveIntegerFlag(flags, 'amount')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserScrollResult>('browser.scroll', {
      direction,
      amount,
      ...target
    })
    printResult(result, json, (v) => `Scrolled ${v.scrolled}`)
  },
  wait: async ({ flags, client, cwd, json }) => {
    const selector = getOptionalStringFlag(flags, 'selector')
    const timeout = getOptionalPositiveIntegerFlag(flags, 'timeout')
    const text = getOptionalStringFlag(flags, 'text')
    const url = getOptionalStringFlag(flags, 'url')
    const load = getOptionalStringFlag(flags, 'load')
    const fn = getOptionalStringFlag(flags, 'fn')
    const state = getOptionalStringFlag(flags, 'state')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserWaitResult>(
      'browser.wait',
      {
        selector,
        timeout,
        text,
        url,
        load,
        fn,
        state,
        ...target
      },
      {
        timeoutMs: timeout ? timeout + 5000 : DEFAULT_BROWSER_WAIT_RPC_TIMEOUT_MS
      }
    )
    printResult(result, json, (v) => JSON.stringify(v, null, 2))
  },
  pdf: async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserPdfResult>('browser.pdf', target)
    printResult(result, json, (v) => `PDF exported (${v.data.length} bytes base64)`)
  },
  'full-screenshot': async ({ flags, client, cwd, json }) => {
    const format = getOptionalStringFlag(flags, 'format') === 'jpeg' ? 'jpeg' : 'png'
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserScreenshotResult>('browser.fullScreenshot', {
      format,
      ...target
    })
    printResult(result, json, (v) => `Full-page screenshot captured (${v.format})`)
  }
}
