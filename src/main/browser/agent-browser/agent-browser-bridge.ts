import type {
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserCookieDeleteResult,
  BrowserCookie,
  BrowserViewportResult,
  BrowserGeolocationResult,
  BrowserInterceptEnableResult,
  BrowserInterceptDisableResult,
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserConsoleResult,
  BrowserNetworkLogResult
} from '../../../shared/browser/runtime/runtime-browser-contracts'
import { BrowserError } from '../browser-error'
import { parseShellArgs } from '../../../shared/shell-args'
import { assertAgentBrowserPassthroughStaysOnPage } from './protocol/agent-browser-passthrough-arguments'
import { agentBrowserCookieSetArguments } from './protocol/agent-browser-cookie-set-arguments'
import { AgentBrowserBridgeInteractionCommands } from './commands/agent-browser-bridge-interaction-commands'
import { sendGuestCdpCommand } from '../cdp/debugger/guest-cdp-command'
import { deleteCookieByName } from '../cookies/browser-cookie-delete-by-name'
import {
  toBrowserConsoleResult,
  toBrowserNetworkLogResult,
  type AgentBrowserConsoleOutput,
  type AgentBrowserNetworkOutput
} from './observation/agent-browser-log-entries'
import { touchEmulationParams } from '../cdp/input/guest-touch-emulation'

export class AgentBrowserBridge extends AgentBrowserBridgeInteractionCommands {
  async cookieGet(
    _url?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCookieGetResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'cookies',
        'get'
      ])) as BrowserCookieGetResult
    })
  }

  async cookieSet(
    cookie: Partial<BrowserCookie>,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCookieSetResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = agentBrowserCookieSetArguments(cookie)
      return (await this.execAgentBrowser(sessionName, args)) as BrowserCookieSetResult
    })
  }

  async cookieDelete(
    name: string,
    domain?: string,
    url?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCookieDeleteResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (_sessionName, target) => {
      const wc = this.requireTargetWebContents(target)
      // agent-browser's `cookies clear` ignores filters and wipes the profile's whole cookie jar.
      return deleteCookieByName((method, params) => sendGuestCdpCommand(wc, method, params), name, {
        domain,
        url,
        pageUrl: wc.getURL()
      })
    })
  }

  async setViewport(
    width: number,
    height: number,
    scale = 1,
    mobile = false,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserViewportResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (_sessionName, target) => {
      const wc = this.getWebContents(target.webContentsId)
      if (!wc) {
        throw new BrowserError('browser_tab_not_found', 'Tab is no longer available')
      }
      const dbg = wc.debugger
      if (!dbg.isAttached()) {
        throw new BrowserError('browser_error', 'Debugger not attached')
      }

      // agent-browser lacks a mobile viewport flag; apply Orca's emulation through CDP.
      await sendGuestCdpCommand(wc, 'Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: scale,
        mobile
      })
      await sendGuestCdpCommand(
        wc,
        'Emulation.setTouchEmulationEnabled',
        touchEmulationParams(mobile)
      )
      // Metrics-only resize can leave the compositor at its old size and crop remote screencasts.
      await sendGuestCdpCommand(wc, 'Emulation.setVisibleSize', { width, height }).catch(() => {})
      this.browserManager.showAgentViewportInPane(target.webContentsId, {
        width,
        height,
        deviceScaleFactor: scale,
        mobile
      })

      return {
        width,
        height,
        deviceScaleFactor: scale,
        mobile
      }
    })
  }

  async setGeolocation(
    lat: number,
    lon: number,
    _accuracy?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserGeolocationResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'set',
        'geo',
        String(lat),
        String(lon)
      ])) as BrowserGeolocationResult
    })
  }

  async interceptEnable(
    patterns?: string[],
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserInterceptEnableResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const urlPattern = patterns?.[0] ?? '**/*'
      const args = ['network', 'route', urlPattern]
      const result = (await this.execAgentBrowser(
        sessionName,
        args
      )) as BrowserInterceptEnableResult
      const session = this.sessions.get(sessionName)
      if (session) {
        this.pendingInterceptRestore.delete(sessionName)
        session.activeInterceptPatterns = patterns?.length ? patterns : ['*']
      }
      return result
    })
  }

  async interceptDisable(
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserInterceptDisableResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'network',
        'unroute'
      ])) as BrowserInterceptDisableResult
      const session = this.sessions.get(sessionName)
      if (session) {
        this.pendingInterceptRestore.delete(sessionName)
        session.activeInterceptPatterns = []
      }
      return result
    })
  }

  async interceptList(
    worktreeId?: string,
    browserPageId?: string
  ): Promise<{ requests: unknown[] }> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['network', 'requests'])) as {
        requests: unknown[]
      }
    })
  }

  // TODO: Per-request continue/block requires agent-browser support.

  async captureStart(
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCaptureStartResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'network',
        'har',
        'start'
      ])) as BrowserCaptureStartResult
      const session = this.sessions.get(sessionName)
      if (session) {
        session.activeCapture = true
      }
      return result
    })
  }

  async captureStop(
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCaptureStopResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'network',
        'har',
        'stop'
      ])) as BrowserCaptureStopResult
      const session = this.sessions.get(sessionName)
      if (session) {
        session.activeCapture = false
      }
      return result
    })
  }

  async consoleLog(
    limit?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserConsoleResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: agent-browser's `console --json` data has this shape.
      const output = (await this.execAgentBrowser(sessionName, [
        'console'
      ])) as AgentBrowserConsoleOutput
      return toBrowserConsoleResult(output, limit)
    })
  }

  async networkLog(
    limit?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserNetworkLogResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: agent-browser's `network requests --json` data has this shape.
      const output = (await this.execAgentBrowser(sessionName, [
        'network',
        'requests'
      ])) as AgentBrowserNetworkOutput
      return toBrowserNetworkLogResult(output, limit)
    })
  }

  async exec(command: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    const args = parseShellArgs(command.trim())
    assertAgentBrowserPassthroughStaysOnPage(args)
    const movesFocus = passthroughMovesPageFocus(args)
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName, target) => {
        if (movesFocus) {
          await this.refuseWhileUserComposes(this.requireTargetWebContents(target))
        }
        return await this.execAgentBrowser(sessionName, args, { cliArgv: true })
      },
      // Raw commands and batches can click or press keys too.
      { elements: passthroughElementArgs(args), blockFileChooser: true }
    )
  }
}

// Commands whose first operand is an element, where agent-browser reads a bare `e2` as a ref.
const ELEMENT_FIRST_COMMANDS = new Set([
  'click',
  'dblclick',
  'hover',
  'focus',
  'check',
  'uncheck',
  'fill',
  'type',
  'select',
  'scrollintoview',
  'upload',
  'highlight',
  'download',
  'drag'
])

// These focus an element or run page code that may. The proxy already guards the helper's mouse presses and Tab.
const FOCUS_MOVING_COMMANDS = new Set(['eval', 'focus', 'fill', 'type', 'batch', 'pushstate'])
// A page's WebMCP tool, a replayed flow and a wait condition also run in the page.
const PAGE_CODE_OPERANDS = new Map([
  ['webmcp', 'invoke'],
  ['flow', 'run'],
  ['wait', '--fn']
])
// Options of `find` that take a value, so neither word is positional.
const FIND_VALUE_OPTIONS = new Set(['--name', '--session'])

// `find <locator> <value> [action] [text]`, where `nth` takes two value words and the action defaults to click.
// The values are required, so the helper takes them first even when they start with `--`.
function findAction([locator, ...rest]: string[]): string | undefined {
  const afterValues = rest.slice(locator === 'nth' ? 2 : 1)
  return afterValues.find(
    (arg, index) => !arg.startsWith('--') && !FIND_VALUE_OPTIONS.has(afterValues[index - 1] ?? '')
  )
}

export function passthroughMovesPageFocus([command, ...operands]: string[]): boolean {
  if (!command) {
    return false
  }
  // The helper's fill focuses the element it found.
  if (command === 'find') {
    return findAction(operands) === 'fill'
  }
  const operand = PAGE_CODE_OPERANDS.get(command)
  return (
    FOCUS_MOVING_COMMANDS.has(command) ||
    (operand !== undefined &&
      operands.some((arg) => arg === operand || arg.startsWith(`${operand}=`)))
  )
}

// Free text such as `keyboard type e2` is not a ref; explicit `@e2`/`ref=e2` are refs anywhere.
function passthroughElementArgs([command, ...operands]: string[]): string[] {
  const explicit = operands.filter((arg) => arg.startsWith('@') || arg.startsWith('ref='))
  return command && ELEMENT_FIRST_COMMANDS.has(command) && operands[0]
    ? [operands[0], ...explicit]
    : explicit
}
