import type { WebContents } from 'electron'
import type {
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserConsoleEntry,
  BrowserConsoleResult,
  BrowserCookie,
  BrowserCookieDeleteResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserGeolocationResult,
  BrowserInterceptDisableResult,
  BrowserInterceptEnableResult,
  BrowserInterceptedRequest,
  BrowserNetworkEntry,
  BrowserNetworkLogResult,
  BrowserViewportResult
} from '../../shared/runtime-types'
import type { CdpCommandSender, SnapshotResult } from './snapshot-engine'

export type CdpTabState = {
  navigationId: string | null
  snapshotResult: SnapshotResult | null
  debuggerAttached: boolean
  debuggerDetachListener: (() => void) | null
  debuggerMessageListener: ((_event: unknown, method: string, params: unknown) => void) | null
  iframeSessions: Map<string, string>
  capturing: boolean
  consoleLog: BrowserConsoleEntry[]
  networkLog: BrowserNetworkEntry[]
  intercepting: boolean
  interceptPatterns: string[]
  pausedRequests: Map<string, BrowserInterceptedRequest>
  networkRequestMap: Map<string, BrowserNetworkEntry>
}

type ActiveCdpContext = {
  guest: WebContents
  sender: CdpCommandSender
  state: CdpTabState
}

export type CdpAuxiliaryCommandHost = {
  run: <T>(operation: (context: ActiveCdpContext) => Promise<T>) => Promise<T>
  // Why: captureStop must not attach the debugger — stopping a capture on a tab whose
  // debugger detached (DevTools opened) would otherwise throw before clearing state.
  runOnState: <T>(
    operation: (context: Pick<ActiveCdpContext, 'guest' | 'state'>) => Promise<T>
  ) => Promise<T>
  current: () => Pick<ActiveCdpContext, 'guest' | 'state'>
}

export class CdpAuxiliaryCommands {
  constructor(private readonly host: CdpAuxiliaryCommandHost) {}

  cookieGet(url?: string): Promise<BrowserCookieGetResult> {
    return this.host.run(async ({ sender }) => {
      const params: Record<string, unknown> = {}
      if (url) {
        params.urls = [url]
      }
      const { cookies } = (await sender('Network.getCookies', params)) as {
        cookies: BrowserCookie[]
      }
      return { cookies }
    })
  }

  cookieSet(cookie: {
    name: string
    value: string
    domain?: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    sameSite?: string
    expires?: number
  }): Promise<BrowserCookieSetResult> {
    return this.host.run(async ({ sender }) => {
      let domain = cookie.domain
      if (!domain) {
        const { result } = (await sender('Runtime.evaluate', {
          expression: 'location.hostname',
          returnByValue: true
        })) as { result: { value: string } }
        domain = result.value
      }
      const params: Record<string, unknown> = {
        name: cookie.name,
        value: cookie.value,
        domain,
        path: cookie.path ?? '/',
        secure: cookie.secure ?? false,
        httpOnly: cookie.httpOnly ?? false,
        sameSite: cookie.sameSite ?? 'Lax'
      }
      if (cookie.expires !== undefined) {
        params.expires = cookie.expires
      }
      const { success } = (await sender('Network.setCookie', params)) as { success: boolean }
      return { success }
    })
  }

  cookieDelete(name: string, domain?: string, url?: string): Promise<BrowserCookieDeleteResult> {
    return this.host.run(async ({ sender }) => {
      const params: Record<string, unknown> = { name }
      if (domain) {
        params.domain = domain
      }
      if (url) {
        params.url = url
      }
      if (!domain && !url) {
        const { result } = (await sender('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true
        })) as { result: { value: string } }
        params.url = result.value
      }
      await sender('Network.deleteCookies', params)
      return { deleted: true }
    })
  }

  setViewport(
    width: number,
    height: number,
    deviceScaleFactor = 1,
    mobile = false
  ): Promise<BrowserViewportResult> {
    return this.host.run(async ({ sender }) => {
      await sender('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile
      })
      await Promise.resolve(sender('Emulation.setVisibleSize', { width, height })).catch(() => {})
      return { width, height, deviceScaleFactor, mobile }
    })
  }

  setGeolocation(
    latitude: number,
    longitude: number,
    accuracy = 1
  ): Promise<BrowserGeolocationResult> {
    return this.host.run(async ({ sender }) => {
      await sender('Emulation.setGeolocationOverride', { latitude, longitude, accuracy })
      return { latitude, longitude, accuracy }
    })
  }

  interceptEnable(patterns: string[] = ['*']): Promise<BrowserInterceptEnableResult> {
    return this.host.run(async ({ sender, state }) => {
      await sender('Fetch.enable', { patterns: patterns.map((urlPattern) => ({ urlPattern })) })
      state.intercepting = true
      state.interceptPatterns = patterns
      return { enabled: true, patterns }
    })
  }

  interceptDisable(): Promise<BrowserInterceptDisableResult> {
    return this.host.run(async ({ sender, state }) => {
      await sender('Fetch.disable')
      state.intercepting = false
      state.interceptPatterns = []
      state.pausedRequests.clear()
      return { disabled: true }
    })
  }

  interceptList(): { requests: BrowserInterceptedRequest[] } {
    const { state } = this.host.current()
    return { requests: [...state.pausedRequests.values()] }
  }

  captureStart(): Promise<BrowserCaptureStartResult> {
    return this.host.run(async ({ sender, state }) => {
      await sender('Runtime.enable')
      state.capturing = true
      state.consoleLog = []
      state.networkLog = []
      state.networkRequestMap.clear()
      return { capturing: true }
    })
  }

  captureStop(): Promise<BrowserCaptureStopResult> {
    return this.host.runOnState(async ({ state }) => {
      state.capturing = false
      state.networkRequestMap.clear()
      return { stopped: true }
    })
  }

  consoleLog(limit = 100): BrowserConsoleResult {
    const { state } = this.host.current()
    return {
      entries: state.consoleLog.slice(-limit),
      truncated: state.consoleLog.length > limit
    }
  }

  networkLog(limit = 100): BrowserNetworkLogResult {
    const { state } = this.host.current()
    return {
      entries: state.networkLog.slice(-limit),
      truncated: state.networkLog.length > limit
    }
  }
}
