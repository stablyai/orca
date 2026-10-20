import { webFrameMain } from 'electron'
import { installBrowserSessionHeadersReceived } from '../browser-session-request-decisions'
import { DnrEngine } from './declarative-net-request/engine'
import type { DnrRequestState } from './declarative-net-request/engine'
import {
  getBrowserExtensionActionState,
  notifyBrowserExtensionActionsChangedSoon
} from './browser-extension-action-registry'
import { DnrExtensionHostAccess } from './browser-extension-dnr-host-access'
import { DnrExtensionRules } from './browser-extension-dnr-extension-rules'
import { DnrFrameTracker } from './browser-extension-dnr-frames'
import { DNR_API_CONSTANTS, DNR_GLOBAL_STATIC_RULE_LIMIT } from './browser-extension-dnr-limits'
import { DnrMatchedRules } from './browser-extension-dnr-matched-rules'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { extensionHasPermission } from './browser-extension-namespace-registry'
import { whenBrowserExtensionProfileLoaded } from './browser-extension-session-loader'
import { resolveBrowserExtensionTab } from './browser-extension-tab-model'

// Chrome holds requests until rulesets load; a ruleset that never finishes must not stall pages.
const LOAD_HOLD_LIMIT_MS = 5_000
// Why a bound: a request's state normally ends at onHeadersReceived; cache hits and failures skip it.
const MAX_PENDING_REQUEST_STATES = 2000

export type DnrSessionExtension = {
  rules: DnrExtensionRules
  hostAccess: DnrExtensionHostAccess
  keepsMatchedRules: boolean
}

const DNR_PERMISSIONS = ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess']

export function usesDeclarativeNetRequest(
  extension: Electron.Extension,
  session: Electron.Session
): boolean {
  return DNR_PERMISSIONS.some((permission) =>
    extensionHasPermission(extension, permission, session)
  )
}

/** Everything declarativeNetRequest keeps for one profile session (RulesetManager and friends). */
export class DnrSessionRuntime {
  readonly engine = new DnrEngine()
  readonly extensions = new Map<string, DnrSessionExtension>()
  readonly frames = new DnrFrameTracker((webContentsId) =>
    resolveBrowserExtensionTab(webContentsId) ? webContentsId : -1
  )
  readonly matched = new DnrMatchedRules({
    keepsRules: (extensionId) => this.extensions.get(extensionId)?.keepsMatchedRules === true,
    displaysActionCount: (extensionId) =>
      this.extensions.get(extensionId)?.rules.displayActionCountAsBadgeText === true,
    actionCountChanged: (extensionId, tabId, count) =>
      this.showActionCount(extensionId, tabId, count)
  })
  /** Rules act at onBeforeRequest (the request path's one cheap check reads these flags). */
  evaluatesRequests = false
  /** Rules act once response headers arrive (response-header conditions or modifications). */
  evaluatesResponses = false
  /** Rules with response-header conditions. */
  evaluatesResponseConditions = false
  private readonly requestStates = new Map<number, DnrRequestState>()
  private readonly loads = new Set<Promise<void>>()
  private loadHold: Promise<void> | null = null
  /** Until the profile's startup loads finish, requests wait for extensions not loaded yet. */
  private startupLoad: (() => Promise<void>) | null = null
  private lastInstallTime = 0

  constructor(
    readonly session: Electron.Session,
    readonly profileId: string
  ) {}

  /** Whether the request path has anything to do in this session. */
  get inUse(): boolean {
    return (
      this.evaluatesRequests ||
      this.evaluatesResponses ||
      this.loads.size > 0 ||
      this.startupLoad !== null
    )
  }

  /** Chrome holds requests until rulesets load; at startup that includes extensions still loading. */
  holdForStartup(startupLoad: () => Promise<void>): void {
    this.startupLoad = startupLoad
  }

  addExtension(extension: Electron.Extension): Promise<void> {
    this.removeExtension(extension.id)
    // Why monotonic: later loads win cross-extension ties, as later installs do in Chrome.
    this.lastInstallTime = Math.max(Date.now(), this.lastInstallTime + 1)
    const withHostAccessOnly = !extensionHasPermission(
      extension,
      'declarativeNetRequest',
      this.session
    )
    const rules = new DnrExtensionRules(
      {
        engine: this.engine,
        profileId: this.profileId,
        staticRuleLimit: (extensionId) => this.staticRuleLimit(extensionId),
        changed: () => this.refresh()
      },
      extension,
      this.lastInstallTime,
      withHostAccessOnly
    )
    this.extensions.set(extension.id, {
      rules,
      hostAccess: new DnrExtensionHostAccess(this.profileId, extension.id, extension.manifest),
      keepsMatchedRules: ['declarativeNetRequestFeedback', 'activeTab'].some((permission) =>
        extensionHasPermission(extension, permission, this.session)
      )
    })
    const load = rules.load().catch((error: unknown) => {
      console.warn(`[browser-extensions] Could not load rules of ${extension.id}:`, error)
    })
    this.loads.add(load)
    void load.finally(() => {
      this.loads.delete(load)
      this.refresh()
    })
    return load
  }

  removeExtension(extensionId: string): void {
    const entry = this.extensions.get(extensionId)
    if (!entry) {
      return
    }
    this.extensions.delete(extensionId)
    entry.rules.unload()
    this.matched.forgetExtension(extensionId)
  }

  /** Rules being loaded or rebuilt for extensions already added. */
  whenRulesLoaded(): Promise<void> {
    return Promise.all(this.loads).then(() => undefined)
  }

  /** Requests made while rules load wait for them (bounded); null when nothing is loading. */
  whenLoaded(): Promise<void> | null {
    const startup = this.startupLoad
    if (this.loads.size === 0 && !startup) {
      return null
    }
    if (!this.loadHold) {
      const hold = Promise.race([
        // Why rules after startup: extensions loaded meanwhile add their own rule loads.
        Promise.resolve(startup?.()).then(() => this.whenRulesLoaded()),
        new Promise<void>((resolve) => setTimeout(resolve, LOAD_HOLD_LIMIT_MS))
      ])
      this.loadHold = hold
      void hold.then(() => {
        this.startupLoad = null
        if (this.loadHold === hold) {
          this.loadHold = null
        }
      })
    }
    return this.loadHold
  }

  private refresh(): void {
    this.evaluatesRequests = this.engine.hasRules('beforeRequest')
    this.evaluatesResponseConditions = this.engine.hasRules('headersReceived')
    this.evaluatesResponses = [...this.extensions.values()].some((entry) =>
      entry.rules.usesResponseStage()
    )
    if (this.evaluatesResponses) {
      installBrowserSessionHeadersReceived(this.session)
    }
  }

  /** GetStaticRuleLimit: the guaranteed minimum plus what other extensions leave of the pool. */
  staticRuleLimit(extensionId: string): number {
    const guaranteed = DNR_API_CONSTANTS.GUARANTEED_MINIMUM_STATIC_RULES
    let othersExtra = 0
    for (const [id, entry] of this.extensions) {
      if (id !== extensionId) {
        othersExtra += Math.max(0, entry.rules.staticRuleCount() - guaranteed)
      }
    }
    return guaranteed + Math.max(0, DNR_GLOBAL_STATIC_RULE_LIMIT - othersExtra)
  }

  keepRequestState(requestId: number, state: DnrRequestState): void {
    this.requestStates.delete(requestId)
    this.requestStates.set(requestId, state)
    if (this.requestStates.size > MAX_PENDING_REQUEST_STATES) {
      const oldest = this.requestStates.keys().next()
      if (!oldest.done) {
        this.requestStates.delete(oldest.value)
      }
    }
  }

  requestState(requestId: number): DnrRequestState | undefined {
    return this.requestStates.get(requestId)
  }

  takeRequestState(requestId: number): DnrRequestState | undefined {
    const state = this.requestStates.get(requestId)
    this.requestStates.delete(requestId)
    return state
  }

  /** setExtensionActionOptions displayActionCountAsBadgeText. */
  setDisplayActionCount(extensionId: string, display: boolean): void {
    const rules = this.extensions.get(extensionId)?.rules
    if (!rules) {
      return
    }
    rules.setDisplayActionCountAsBadgeText(display)
    const state = getBrowserExtensionActionState(this.profileId, rules.extension)
    let changed = display ? false : state.clearActionCounts()
    for (const [tabId, count] of display ? this.matched.actionCounts(extensionId) : []) {
      changed = state.setActionCount(tabId, count) || changed
    }
    if (changed) {
      notifyBrowserExtensionActionsChangedSoon(this.profileId)
    }
  }

  private showActionCount(extensionId: string, tabId: number, count: number): void {
    const extension = this.extensions.get(extensionId)?.rules.extension
    if (
      extension &&
      getBrowserExtensionActionState(this.profileId, extension).setActionCount(tabId, count)
    ) {
      notifyBrowserExtensionActionsChangedSoon(this.profileId)
    }
  }
}

const runtimes = new WeakMap<Electron.Session, DnrSessionRuntime>()

export function getDnrSessionRuntime(session: Electron.Session): DnrSessionRuntime | undefined {
  return runtimes.get(session)
}

/** Session setup: follows the session's extensions; rules load as each one does. */
export function attachBrowserExtensionDnr(
  session: Electron.Session,
  profileId: string,
  enabledExtensionIds: readonly string[]
): void {
  if (runtimes.has(session)) {
    return
  }
  const runtime = new DnrSessionRuntime(session, profileId)
  runtimes.set(session, runtime)
  const installs = getBrowserExtensionInstallStore()
  const expectsRules = enabledExtensionIds.some((id) =>
    installs.get(id)?.permissions.some((permission) => DNR_PERMISSIONS.includes(permission))
  )
  if (expectsRules) {
    runtime.holdForStartup(() => whenBrowserExtensionProfileLoaded(profileId))
  }
  const add = (extension: Electron.Extension): void => {
    if (usesDeclarativeNetRequest(extension, session)) {
      void runtime.addExtension(extension)
    }
  }
  session.extensions.on('extension-loaded', (_event, extension) => add(extension))
  session.extensions.on('extension-unloaded', (_event, extension) =>
    runtime.removeExtension(extension.id)
  )
  session.extensions.getAllExtensions().forEach(add)
}

/** Startup waits for an extension's rules with its other restored state. */
export function whenBrowserExtensionDnrLoaded(session: Electron.Session): Promise<void> {
  return runtimes.get(session)?.whenRulesLoaded() ?? Promise.resolve()
}

/** Frame commits and lifetime of one tab (or popout) webContents in an extension session. */
export function observeBrowserExtensionDnrContents(contents: Electron.WebContents): void {
  const { id, session } = contents
  contents.on(
    'did-frame-navigate',
    (_event, url, _code, _status, _isMainFrame, processId, routingId) => {
      const runtime = runtimes.get(session)
      const frame = runtime ? webFrameMain.fromId(processId, routingId) : undefined
      if (runtime && frame && !frame.isDestroyed()) {
        runtime.frames.commit(runtime.inUse ? runtime.engine : null, id, frame, url)
      }
    }
  )
  // Why after tabs-lifecycle's handler: that one resets the tab's badge for the new document.
  contents.on('did-navigate', () => runtimes.get(session)?.matched.commitNavigation(id))
  contents.once('destroyed', () => {
    runtimes.get(session)?.frames.forgetContents(id)
    runtimes.get(session)?.matched.forgetTab(id)
  })
}
