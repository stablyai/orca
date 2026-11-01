import type {
  BrowserTabCurrentResult,
  BrowserTabListResult,
  BrowserTabShowResult,
  BrowserTabSwitchResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { formatTabList, formatTabListWithProfiles, formatTabShow, printResult } from '../format'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalStringFlag,
  getPresentStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { isBrowserTabSplitDirection } from '../../shared/browser-tab-split-direction'
import { getBrowserCommandTarget, getBrowserWorktreeSelector } from '../selectors'

export const BROWSER_TAB_HANDLERS: Record<string, CommandHandler> = {
  'open-url': async ({ flags, client, cwd, json }) => {
    const url = getRequiredStringFlag(flags, 'url')
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    const result = await client.call<{ browserPageId: string }>(
      'browser.openUrl',
      { url, worktree },
      { timeoutMs: 60_000 }
    )
    printResult(result, json, (v) => `Opened URL in tab ${v.browserPageId}`)
  },
  'tab list': async ({ flags, client, cwd, json }) => {
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    const result = await client.call<BrowserTabListResult>('browser.tabList', { worktree })
    const showProfile = flags.has('show-profile')
    printResult(result, json, (value) =>
      showProfile ? formatTabListWithProfiles(value, true) : formatTabList(value)
    )
  },
  'tab show': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserTabShowResult>('browser.tabShow', target)
    printResult(result, json, formatTabShow)
  },
  'tab current': async ({ flags, client, cwd, json }) => {
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    const result = await client.call<BrowserTabCurrentResult>('browser.tabCurrent', { worktree })
    printResult(result, json, formatTabShow)
  },
  'tab switch': async ({ flags, client, cwd, json }) => {
    const index = getOptionalNonNegativeIntegerFlag(flags, 'index')
    const page = getOptionalStringFlag(flags, 'page')
    if (index === undefined && !page) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --index or --page')
    }
    // Page ids are globally unique; worktree is optional validation rather than an implicit filter.
    const target = await getBrowserCommandTarget(flags, cwd, client)
    // Focus surfaces the pane only in the current worktree; otherwise the renderer pre-stages it.
    const result = await client.call<BrowserTabSwitchResult>('browser.tabSwitch', {
      index,
      page,
      ...(flags.has('focus') ? { focus: true } : {}),
      ...target
    })
    printResult(result, json, (v) => `Switched to tab ${v.switched} (${v.browserPageId})`)
  },
  'tab create': async ({ flags, client, cwd, json }) => {
    const url = getOptionalStringFlag(flags, 'url')
    const profileId = getOptionalStringFlag(flags, 'profile')
    const split = getPresentStringFlag(flags, 'split')
    if (split !== undefined && !isBrowserTabSplitDirection(split)) {
      throw new RuntimeClientError('invalid_argument', '--split must be right, left, down, or up')
    }
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    // Why the caller's tab: the split should sit beside the terminal that ran the command, not
    // wherever the user last clicked. Spread conditionally so a plain create keeps its old payload.
    const callerTabId = process.env.ORCA_TAB_ID
    const result = await client.call<{ browserPageId: string }>(
      'browser.tabCreate',
      {
        url,
        worktree,
        profileId,
        ...(split ? { split, ...(callerTabId ? { splitFromTabId: callerTabId } : {}) } : {})
      },
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
