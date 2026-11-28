import {
  installBrowserSessionHeadersReceived,
  installBrowserSessionRequestLifecycle
} from '../../../sessions/requests/browser-session-request-decisions'
import type { DnrEngine } from '../engine'
import type { DnrRequestState } from '../request-state'
import {
  getBrowserExtensionActionState,
  notifyBrowserExtensionActionsChangedSoon
} from '../../actions/browser-extension-action-registry'
import { DnrExtensionHostAccess } from '../../permissions/browser-extension-request-host-access'
import type { DnrExtensionRules } from './browser-extension-dnr-extension-rules'
import { loadDnrRuntimeModules } from './browser-extension-dnr-runtime-loader'
import { DnrFrameTracker } from './browser-extension-dnr-frames'
import { DNR_API_CONSTANTS, DNR_GLOBAL_STATIC_RULE_LIMIT } from './browser-extension-dnr-limits'
import { DnrMatchedRules } from './browser-extension-dnr-matched-rules'
import { getBrowserExtensionInstallStore } from '../../installation/browser-extension-install-store'
import { extensionHasPermission } from '../../api-runtime/browser-extension-namespace-registry'
import { whenBrowserExtensionProfileLoaded } from '../../profile-sessions/browser-extension-session-loader'
import { resolveBrowserExtensionTab } from '../../tabs-and-windows/browser-extension-tab-model'

// Chrome holds requests until rulesets load; a ruleset that never finishes must not stall pages.
const LOAD_HOLD_LIMIT_MS = 5_000

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
  private _engine: DnrEngine | null = null
  private addToken = 0
  private readonly pendingTokens = new Map<string, number>()
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
  evaluatesRequests = false
  evaluatesResponses = false
  evaluatesResponseConditions = false
  private readonly requestStates = new Map<number, DnrRequestState>()
  private readonly loads = new Set<Promise<void>>()
  private loadHold: Promise<void> | null = null
  private startupLoad: (() => Promise<void>) | null = null

  constructor(
    readonly session: Electron.Session,
    readonly profileId: string
  ) {}

  get engine(): DnrEngine | null {
    return this._engine
  }

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
    // Why: a hold built before a reattach waits on the old loads, so later requests get a new one.
    this.loadHold = null
  }

  addExtension(extension: Electron.Extension): Promise<void> {
    this.removeExtension(extension.id)
    const token = ++this.addToken
    this.pendingTokens.set(extension.id, token)
    const load = loadDnrRuntimeModules()
      .then(async ({ DnrEngine, DnrExtensionRules }) => {
        if (this.pendingTokens.get(extension.id) !== token) {
          return
        }
        this.pendingTokens.delete(extension.id)
        const engine = (this._engine ??= new DnrEngine())
        const withHostAccessOnly = !extensionHasPermission(
          extension,
          'declarativeNetRequest',
          this.session
        )
        const rules = new DnrExtensionRules(
          {
            engine,
            profileId: this.profileId,
            staticRuleLimit: (extensionId) => this.staticRuleLimit(extensionId),
            changed: () => this.refresh()
          },
          extension,
          getBrowserExtensionInstallStore().get(extension.id)?.installTime ?? 0,
          withHostAccessOnly
        )
        this.extensions.set(extension.id, {
          rules,
          hostAccess: new DnrExtensionHostAccess(this.profileId, extension.id, extension.manifest),
          keepsMatchedRules: ['declarativeNetRequestFeedback', 'activeTab'].some((permission) =>
            extensionHasPermission(extension, permission, this.session)
          )
        })
        await rules.load()
      })
      .catch((error: unknown) => {
        if (this.pendingTokens.get(extension.id) === token) {
          this.pendingTokens.delete(extension.id)
        }
        console.warn(`[browser-extensions] Could not load rules of ${extension.id}:`, error)
      })
    this.loads.add(load)
    void load.finally(() => {
      this.loads.delete(load)
      this.refresh()
    })
    return load
  }

  reconcilePermissions(extension: Electron.Extension): Promise<void> {
    if (!usesDeclarativeNetRequest(extension, this.session)) {
      this.removeExtension(extension.id)
      return Promise.resolve()
    }
    const entry = this.extensions.get(extension.id)
    if (!entry) {
      return this.addExtension(extension)
    }
    this._engine?.setHostPermissionsAlwaysRequired(
      extension.id,
      !extensionHasPermission(extension, 'declarativeNetRequest', this.session)
    )
    entry.keepsMatchedRules = ['declarativeNetRequestFeedback', 'activeTab'].some((permission) =>
      extensionHasPermission(extension, permission, this.session)
    )
    if (!entry.keepsMatchedRules) {
      this.matched.forgetMatches(extension.id)
    }
    return this.whenRulesLoaded()
  }

  removeExtension(extensionId: string): void {
    this.pendingTokens.delete(extensionId)
    const entry = this.extensions.get(extensionId)
    if (!entry) {
      return
    }
    this.extensions.delete(extensionId)
    for (const state of this.requestStates.values()) {
      state.actions = state.actions.filter((action) => action.rule.extensionId !== extensionId)
      state.allowByExtension.delete(extensionId)
    }
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
        // A reattach may have re-armed the hold meanwhile; that one stays.
        if (this.startupLoad === startup) {
          this.startupLoad = null
        }
        if (this.loadHold === hold) {
          this.loadHold = null
        }
      })
    }
    return this.loadHold
  }

  private refresh(): void {
    this.evaluatesRequests = this._engine?.hasRules('beforeRequest') ?? false
    this.evaluatesResponseConditions = this._engine?.hasRules('headersReceived') ?? false
    this.evaluatesResponses = [...this.extensions.values()].some((entry) =>
      entry.rules.usesResponseStage()
    )
    if (this.evaluatesResponses) {
      installBrowserSessionHeadersReceived(this.session)
    }
    if (this.evaluatesRequests || this.evaluatesResponses) {
      installBrowserSessionRequestLifecycle(this.session)
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
    this.requestStates.set(requestId, state)
  }

  requestState(requestId: number): DnrRequestState | undefined {
    return this.requestStates.get(requestId)
  }

  takeRequestState(requestId: number): DnrRequestState | undefined {
    const state = this.requestStates.get(requestId)
    this.requestStates.delete(requestId)
    return state
  }

  clearPendingRequests(): void {
    this.requestStates.clear()
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
  const installs = getBrowserExtensionInstallStore()
  const expectsRules = enabledExtensionIds.some((id) =>
    installs.get(id)?.permissions.some((permission) => DNR_PERMISSIONS.includes(permission))
  )
  const existing = runtimes.get(session)
  // A session attached again (idle profile reopened, extensions turned back on) holds requests again.
  if (existing) {
    if (expectsRules) {
      existing.holdForStartup(() => whenBrowserExtensionProfileLoaded(profileId))
    }
    return
  }
  const runtime = new DnrSessionRuntime(session, profileId)
  runtimes.set(session, runtime)
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

/** A resumed extension that couldn't get all its state back starts clean: its onStartup re-adds these. */
export async function clearBrowserExtensionDnrSessionRules(
  session: Electron.Session,
  extensionId: string
): Promise<void> {
  // Why one queued step: a call the extension makes meanwhile must not see the old rules.
  await runtimes.get(session)?.extensions.get(extensionId)?.rules.updateRules('session', 'all', [])
}

/** Startup waits for an extension's rules with its other restored state. */
export function whenBrowserExtensionDnrLoaded(session: Electron.Session): Promise<void> {
  return runtimes.get(session)?.whenRulesLoaded() ?? Promise.resolve()
}
