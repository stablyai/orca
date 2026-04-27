import type { BrowserTabListResult, BrowserTabSwitchResult } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatTabList, printResult } from '../format'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getBrowserCommandTarget, getBrowserWorktreeSelector } from '../selectors'

export const BROWSER_TAB_HANDLERS: Record<string, CommandHandler> = {
  'tab list': async ({ flags, client, cwd, json }) => {
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    const result = await client.call<BrowserTabListResult>('browser.tabList', { worktree })
    printResult(result, json, formatTabList)
  },
  'tab switch': async ({ flags, client, cwd, json }) => {
    const index = getOptionalNonNegativeIntegerFlag(flags, 'index')
    const page = getOptionalStringFlag(flags, 'page')
    if (index === undefined && !page) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --index or --page')
    }
    // Why: a stable browser page id is globally unique across Orca, so page-
    // targeted tab switches should match the rest of the --page command model:
    // global by default, with --worktree only acting as explicit validation.
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserTabSwitchResult>('browser.tabSwitch', {
      index,
      page,
      ...target
    })
    printResult(result, json, (v) => `Switched to tab ${v.switched} (${v.browserPageId})`)
  },
  'tab create': async ({ flags, client, cwd, json }) => {
    const url = getOptionalStringFlag(flags, 'url')
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    const result = await client.call<{ browserPageId: string }>(
      'browser.tabCreate',
      { url, worktree },
      { timeoutMs: 60_000 }
    )
    printResult(result, json, (v) => `Created tab ${v.browserPageId}`)
  },
  'tab close': async ({ flags, client, cwd, json }) => {
    const index = getOptionalNonNegativeIntegerFlag(flags, 'index')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<{ closed: boolean }>('browser.tabClose', {
      index,
      ...target
    })
    printResult(result, json, () => 'Tab closed')
  },
  exec: async ({ flags, client, cwd, json }) => {
    const command = getRequiredStringFlag(flags, 'command')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.exec', { command, ...target })
    printResult(result, json, (v) => JSON.stringify(v, null, 2))
  }
}
