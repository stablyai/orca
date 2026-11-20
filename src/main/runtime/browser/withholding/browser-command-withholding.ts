// While a workspace's browser may show a secret (Google's client dialog during setup), an agent's
// browser commands there run only from a small set of actions and get a fixed acknowledgement, on
// every route (this host's browser, a paired desktop's, a bridged desktop's). It is decided from the
// command's workspace before the command runs, never from a page address that may be stale.
import { BROWSER_WITHHELD_RESULT } from '../../../../shared/browser/runtime/browser-withheld-result'
import { BrowserError } from '../../../browser/browser-error'
import { isAgentRpcCaller, type RpcCallerIdentity } from '../../rpc/callers/rpc-caller-identity'

/** Whether the workspace's pages may show a secret now; `null`: the command names no workspace. */
export type BrowserWorkspaceWithheld = (workspaceId: string | null) => boolean

let withheld: BrowserWorkspaceWithheld | null = null

export function setBrowserWorkspaceWithheld(next: BrowserWorkspaceWithheld | null): void {
  withheld = next
}

// Tab commands return page ids, addresses and titles, which an agent needs to keep going.
const TAB_METHODS = new Set([
  'browser.tabCreate',
  'browser.tabList',
  'browser.tabCurrent',
  'browser.tabClose',
  'browser.tabSwitch',
  'browser.tabShow',
  'browser.openUrl'
])

// Acting on a page by what it says; everything else (snapshots, reads, eval, screenshots, console,
// downloads to a path, raw exec) is refused while withheld.
const ACTIONS = new Set([
  'browser.goto',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.click',
  'browser.dblclick',
  'browser.find',
  'browser.fill',
  'browser.type',
  'browser.keyboardInsertText',
  'browser.keypress',
  'browser.select',
  'browser.check',
  'browser.focus',
  'browser.clear',
  'browser.hover',
  'browser.scroll',
  'browser.scrollIntoView',
  'browser.wait',
  'browser.dialogAccept',
  'browser.dialogDismiss'
])

export const BROWSER_WITHHELD_REFUSAL =
  "Orca doesn't run this while the page may show a secret. Act on the page by its labels (click, find, fill, wait) instead."
export const BROWSER_WITHHELD_FAILURE =
  "That didn't work, and Orca doesn't say why while the page may show a secret."

export async function runWithheldBrowserCommand<T>(
  command: {
    method: string
    caller: RpcCallerIdentity | undefined
    workspaceOf: () => Promise<string | null>
  },
  run: () => Promise<T>
): Promise<T | typeof BROWSER_WITHHELD_RESULT> {
  if (
    !withheld ||
    !command.method.startsWith('browser.') ||
    command.method.startsWith('browser.clientHost.') ||
    TAB_METHODS.has(command.method) ||
    !isAgentRpcCaller(command.caller)
  ) {
    return run()
  }
  const workspaceId = await command.workspaceOf().catch(() => null)
  if (!withheld(workspaceId)) {
    return run()
  }
  if (!ACTIONS.has(command.method)) {
    throw new BrowserError('browser_withheld', BROWSER_WITHHELD_REFUSAL)
  }
  try {
    await run()
  } catch {
    throw new BrowserError('browser_withheld', BROWSER_WITHHELD_FAILURE)
  }
  return BROWSER_WITHHELD_RESULT
}
