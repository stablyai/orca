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
} from '../../shared/runtime-types'
import { BrowserError } from './cdp-bridge'
import { parseShellArgs, stripAgentBrowserTargetArgs } from './agent-browser-bridge-process'
import { AgentBrowserBridgeInteractionCommands } from './agent-browser-bridge-interaction-commands'

export abstract class AgentBrowserBridgeStateCommands extends AgentBrowserBridgeInteractionCommands {
  // ── Cookie commands ──

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
      const args = ['cookies', 'set', cookie.name ?? '', cookie.value ?? '']
      if (cookie.domain) {
        args.push('--domain', cookie.domain)
      }
      if (cookie.path) {
        args.push('--path', cookie.path)
      }
      if (cookie.secure) {
        args.push('--secure')
      }
      if (cookie.httpOnly) {
        args.push('--httpOnly')
      }
      if (cookie.sameSite) {
        args.push('--sameSite', cookie.sameSite)
      }
      if (cookie.expires != null) {
        args.push('--expires', String(cookie.expires))
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserCookieSetResult
    })
  }

  async cookieDelete(
    name?: string,
    domain?: string,
    _url?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserCookieDeleteResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      const args = ['cookies', 'clear']
      if (name) {
        args.push('--name', name)
      }
      if (domain) {
        args.push('--domain', domain)
      }
      return (await this.execAgentBrowser(sessionName, args)) as BrowserCookieDeleteResult
    })
  }

  // ── Viewport / emulation commands ──

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

      // Why: agent-browser's `set viewport` has no `mobile` flag, so apply the emulation directly via CDP to honor Orca's --mobile.
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: scale,
        mobile
      })
      // Why: BrowserView's compositor can keep the old host size after a metrics-only resize, cropping remote screencast clients.
      await Promise.resolve(dbg.sendCommand('Emulation.setVisibleSize', { width, height })).catch(
        () => {}
      )

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

  // ── Network interception commands ──

  async interceptEnable(
    patterns?: string[],
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserInterceptEnableResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      // Why: agent-browser uses "network route <url>" to intercept. Route each pattern individually.
      const urlPattern = patterns?.[0] ?? '**/*'
      const args = ['network', 'route', urlPattern]
      const result = (await this.execAgentBrowser(
        sessionName,
        args
      )) as BrowserInterceptEnableResult
      const session = this.sessions.get(sessionName)
      if (session) {
        this.pendingInterceptRestore.delete(sessionName)
        session.activeInterceptPatterns = patterns ?? ['*']
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

  // TODO: Add interceptContinue/interceptBlock once agent-browser supports per-request decisions, not just URL-pattern routing.

  // ── Capture commands ──

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
    _limit?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserConsoleResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['console'])) as BrowserConsoleResult
    })
  }

  async networkLog(
    _limit?: number,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserNetworkLogResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, [
        'network',
        'requests'
      ])) as BrowserNetworkLogResult
    })
  }

  // ── Generic passthrough ──

  async exec(command: string, worktreeId?: string, browserPageId?: string): Promise<unknown> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      // Why: strip target/session flags from passthrough so a caller can't override Orca's selected page or CDP proxy.
      const args = stripAgentBrowserTargetArgs(parseShellArgs(command.trim()))
      return await this.execAgentBrowser(sessionName, args)
    })
  }
}
