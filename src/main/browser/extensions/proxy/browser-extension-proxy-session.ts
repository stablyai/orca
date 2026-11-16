import { emitBrowserExtensionEvent } from '../api-runtime/browser-extension-api-host'
import {
  BrowserExtensionApiError,
  extensionHasPermission
} from '../api-runtime/browser-extension-namespace-registry'
import { getBrowserExtensionInstallStore } from '../installation/browser-extension-install-store'
import { getBrowserExtensionProfileStateStore } from '../profile-storage/browser-extension-profile-state-store'
import {
  setProxySessionOverride,
  awaitProxySessionApplication,
  getProxySessionConfiguration,
  observeProxySessionConfiguration
} from '../../../network/proxy-settings'
import {
  browserExtensionProxyBaseline,
  toElectronProxyConfig,
  fromElectronProxyConfig,
  type BrowserExtensionProxyConfig
} from './browser-extension-proxy-config'

type ProxySetting = { extensionId: string | null; value: BrowserExtensionProxyConfig }
type ProxySession = {
  profileId: string
  pending: Promise<void>
  applied: ProxySetting
  enabled: Set<string>
  busy: number
  failure: unknown
  reported: ProxySetting | null
  generations: Map<string, number>
}
type SettingChange = { extensionId: string; value: BrowserExtensionProxyConfig | undefined }

const sessions = new WeakMap<Electron.Session, ProxySession>()

function precedence(left: string, right: string): number {
  const installs = getBrowserExtensionInstallStore()
  return (
    (installs.get(right)?.installTime ?? 0) - (installs.get(left)?.installTime ?? 0) ||
    left.localeCompare(right)
  )
}

function effectiveSetting(session: Electron.Session, setting: ProxySetting): ProxySetting {
  return setting.extensionId
    ? setting
    : {
        ...setting,
        value: fromElectronProxyConfig(
          getProxySessionConfiguration(session, browserExtensionProxyBaseline())
        )
      }
}

function settingFor(setting: ProxySetting, extensionId: string) {
  return {
    value: setting.value,
    levelOfControl:
      setting.extensionId === extensionId
        ? 'controlled_by_this_extension'
        : setting.extensionId === null || precedence(extensionId, setting.extensionId) < 0
          ? 'controllable_by_this_extension'
          : 'controlled_by_other_extensions'
  }
}

function resolveSetting(
  session: Electron.Session,
  state: ProxySession,
  change?: SettingChange
): ProxySetting {
  const store = getBrowserExtensionProfileStateStore()
  for (const id of [...state.enabled].sort(precedence)) {
    const loaded = session.extensions.getExtension(id)
    const saved = store.read(state.profileId, id)
    const installed = getBrowserExtensionInstallStore().get(id)
    const permitted = loaded
      ? extensionHasPermission(loaded, 'proxy', session)
      : installed &&
        (installed.permissions.includes('proxy') || saved.grantedPermissions.includes('proxy'))
    const value = change?.extensionId === id ? change.value : saved.proxy
    if (permitted && value) {
      return { extensionId: id, value }
    }
  }
  return { extensionId: null, value: { mode: 'system' } }
}

function enqueue<T>(state: ProxySession, action: () => Promise<T>): Promise<T> {
  state.busy++
  const task = state.pending.then(action).finally(() => {
    state.busy--
  })
  state.pending = task.then(
    () => {},
    () => {}
  )
  return task
}

async function apply(
  session: Electron.Session,
  state: ProxySession,
  next: ProxySetting
): Promise<void> {
  if (!state.failure && JSON.stringify(next) === JSON.stringify(state.applied)) {
    publishChange(session, state)
    return
  }
  await setProxySessionOverride(
    session,
    next.extensionId ? toElectronProxyConfig(next.value) : null,
    browserExtensionProxyBaseline()
  )
  state.applied = next
  state.failure = null
  publishChange(session, state)
}

function publishChange(session: Electron.Session, state: ProxySession): void {
  const previous = state.reported
  let next: ProxySetting
  try {
    next = effectiveSetting(session, state.applied)
  } catch {
    state.reported = null
    return
  }
  state.reported = next
  if (!previous || JSON.stringify(previous) === JSON.stringify(next)) {
    return
  }
  emitBrowserExtensionEvent({ session }, 'proxy', 'settings.onChange', (extension) => {
    const before = settingFor(previous, extension.id)
    const after = settingFor(next, extension.id)
    return JSON.stringify(before) === JSON.stringify(after) ? null : [after]
  })
}

function getSession(session: Electron.Session): ProxySession {
  const state = sessions.get(session)
  if (!state) {
    throw new BrowserExtensionApiError('Proxy settings are unavailable in this browser session')
  }
  return state
}

export function observeBrowserExtensionProxySession(
  session: Electron.Session,
  profileId: string,
  enabledExtensionIds: string[] = []
): void {
  const existing = sessions.get(session)
  if (existing) {
    existing.enabled = new Set(enabledExtensionIds)
    void reconcileBrowserExtensionProxyPermissions(session).catch(() => {})
    return
  }
  const state: ProxySession = {
    profileId,
    pending: Promise.resolve(),
    busy: 0,
    failure: null,
    reported: null,
    generations: new Map(),
    applied: { extensionId: null, value: { mode: 'system' } },
    enabled: new Set([
      ...enabledExtensionIds,
      ...session.extensions.getAllExtensions().map((extension) => extension.id)
    ])
  }
  sessions.set(session, state)
  const refresh = () => {
    void reconcileBrowserExtensionProxyPermissions(session).catch((error: unknown) => {
      console.warn('[browser-extensions] Could not apply proxy settings:', error)
    })
  }
  observeProxySessionConfiguration(session, refresh)
  session.extensions.on('extension-loaded', (_event, extension) => {
    state.generations.set(extension.id, (state.generations.get(extension.id) ?? 0) + 1)
    state.enabled.add(extension.id)
    refresh()
  })
  session.extensions.on('extension-unloaded', (_event, extension) => {
    state.generations.set(extension.id, (state.generations.get(extension.id) ?? 0) + 1)
    state.enabled.delete(extension.id)
    refresh()
  })
  refresh()
}

export async function whenBrowserExtensionProxyReady(session: Electron.Session): Promise<void> {
  const state = getSession(session)
  while (true) {
    const pending = state.pending
    await pending
    if (pending === state.pending) {
      if (state.failure) {
        throw state.failure
      }
      return
    }
  }
}

export function browserExtensionProxyRequestReadiness(
  session: Electron.Session
): boolean | Promise<boolean> {
  const state = sessions.get(session)
  if (!state) {
    return true
  }
  return state.busy > 0
    ? whenBrowserExtensionProxyReady(session).then(
        () => true,
        () => false
      )
    : !state.failure
}

export async function reconcileBrowserExtensionProxyPermissions(
  session: Electron.Session
): Promise<void> {
  const state = sessions.get(session)
  if (state) {
    await enqueue(state, async () => {
      try {
        await apply(session, state, resolveSetting(session, state))
      } catch (error) {
        state.failure = error
        throw error
      }
    })
  }
}

export function reportBrowserExtensionProxyError(session: Electron.Session, error: string): void {
  if (
    !sessions.has(session) ||
    !/^net::ERR_(PROXY_|TUNNEL_CONNECTION_FAILED|SOCKS_|PAC_|MANDATORY_PROXY_CONFIGURATION_FAILED|NO_SUPPORTED_PROXIES)/.test(
      error
    )
  ) {
    return
  }
  emitBrowserExtensionEvent({ session }, 'proxy', 'onProxyError', [
    { fatal: true, error, details: '' }
  ])
}

export function getBrowserExtensionProxySetting(session: Electron.Session, extensionId: string) {
  const state = getSession(session)
  return enqueue(state, async () => {
    if (state.failure || !(await awaitProxySessionApplication(session))) {
      throw new BrowserExtensionApiError(
        'Proxy configuration is unavailable; clear or reapply the setting to recover'
      )
    }
    return settingFor(effectiveSetting(session, state.applied), extensionId)
  })
}

export function changeBrowserExtensionProxySetting(
  session: Electron.Session,
  extensionId: string,
  value: BrowserExtensionProxyConfig | undefined
): Promise<void> {
  const state = getSession(session)
  const generation = state.generations.get(extensionId) ?? 0
  return enqueue(state, async () => {
    const extension = session.extensions.getExtension(extensionId)
    if (
      generation !== (state.generations.get(extensionId) ?? 0) ||
      !state.enabled.has(extensionId) ||
      !extension ||
      !extensionHasPermission(extension, 'proxy', session)
    ) {
      throw new BrowserExtensionApiError('The extension is unloaded or lacks the proxy permission')
    }
    try {
      await apply(session, state, resolveSetting(session, state, { extensionId, value }))
    } catch (error) {
      if (!(await awaitProxySessionApplication(session))) {
        state.failure = error
      }
      throw error
    }
    const current = session.extensions.getExtension(extensionId)
    if (
      generation !== (state.generations.get(extensionId) ?? 0) ||
      !current ||
      !extensionHasPermission(current, 'proxy', session)
    ) {
      try {
        await apply(session, state, resolveSetting(session, state))
      } catch (error) {
        state.failure = error
        throw error
      }
      throw new BrowserExtensionApiError(
        'The extension was unloaded while applying its proxy setting'
      )
    }
    getBrowserExtensionProfileStateStore().update(state.profileId, extensionId, (entry) => ({
      ...entry,
      proxy: value
    }))
  })
}
