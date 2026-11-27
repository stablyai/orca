import { getWslCallerDistro } from '../hosts/wsl-caller-distro'
import type {
  BrowserTabAnnotationsResult,
  BrowserTabCurrentResult,
  BrowserTabListResult,
  BrowserTabShowResult,
  BrowserTabSwitchResult
} from '../../shared/browser/runtime/runtime-browser-contracts'
import type { CommandHandler } from '../dispatch/dispatch'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { formatTabAnnotations, formatTabList, formatTabShow } from './browser-format'
import { printResult } from '../output/command-result-output'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalStringFlag,
  getPresentStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/connection/types'
import { escapeTerminalControlCharacters } from '../../shared/terminal/output/terminal-control-character-escape'
import { isBrowserTabSplitDirection } from '../../shared/browser/workspaces/browser-tab-split-direction'
import { getBrowserWorktreeSelector } from '../workspace-selection/workspace-selector'
import { getBrowserCommandTarget, getScopedBrowserWorktreeSelector } from './browser-command-target'

export const BROWSER_TAB_HANDLERS: Record<string, CommandHandler> = {
  'open-url': async ({ flags, client, cwd, json }) => {
    const url = getRequiredStringFlag(flags, 'url')
    let result: RuntimeRpcSuccess<{ browserPageId: string }>
    try {
      const worktree = await getScopedBrowserWorktreeSelector(flags, cwd, client)
      result = await client.call<{ browserPageId: string }>(
        'browser.openUrl',
        { url, worktree },
        { timeoutMs: 60_000 }
      )
    } catch (error) {
      throw withOpenUrlYourselfLine(error, url)
    }
    printResult(result, json, (v) => `Opened URL in tab ${v.browserPageId}`)
  },
  'tab list': async ({ flags, client, cwd, json }) => {
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    const result = await client.call<BrowserTabListResult>('browser.tabList', { worktree })
    printResult(result, json, (value) =>
      formatTabList(value, {
        showProfile: flags.has('show-profile'),
        // Without a selector the runtime lists every worktree.
        scopedToWorktree: worktree !== undefined
      })
    )
  },
  'tab show': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserTabShowResult>('browser.tabShow', target)
    printResult(result, json, formatTabShow)
  },
  'tab annotations': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserTabAnnotationsResult>('browser.tabAnnotations', target)
    printResult(result, json, formatTabAnnotations)
  },
  'tab current': async ({ flags, client, cwd, json }) => {
    const worktree = await getScopedBrowserWorktreeSelector(flags, cwd, client)
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
    const worktree = await getScopedBrowserWorktreeSelector(flags, cwd, client)
    // Why the caller's tab: the split should sit beside the terminal that ran the command, not
    // wherever the user last clicked. Spread conditionally so a plain create keeps its old payload.
    const callerTabId = process.env.ORCA_TAB_ID
    const result = await client.call<{ browserPageId: string }>(
      'browser.tabCreate',
      {
        url,
        worktree,
        profileId,
        ...(split ? { split, ...(callerTabId ? { splitFromTabId: callerTabId } : {}) } : {}),
        ...(flags.has('headless') ? { placement: { kind: 'server' } } : {}),
        // A CLI has no screen, so a paired caller's default 'caller' audience would show it nowhere.
        ...(flags.has('focus') ? { activate: true, navigation: 'all' } : {})
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
    // A paired runtime reads another filesystem, so only a local caller's directory applies.
    const result = await client.call<unknown>('browser.exec', {
      command,
      ...(client.isRemote ? {} : { cwd, wslDistro: getWslCallerDistro(cwd) ?? undefined }),
      ...target
    })
    printResult(result, json, (v) => JSON.stringify(v, null, 2))
  }
}

// Why: BROWSER callers are often phone-only or headless sessions; when no desktop opens the page, the URL is their way on (#48645).
function withOpenUrlYourselfLine(error: unknown, url: string): Error {
  // The URL comes from whatever process ran BROWSER, so keep its control bytes off the terminal.
  const line = `\nOpen it in a browser yourself: ${escapeTerminalControlCharacters(url, true)}`
  if (!(error instanceof Error)) {
    return new RuntimeClientError('runtime_error', `${String(error)}${line}`)
  }
  // Amend in place: rebuilding would re-redact and copy the error's recovery data.
  error.message += line
  if (error instanceof RuntimeRpcFailureError) {
    error.response.error.message = error.message
  }
  return error
}
