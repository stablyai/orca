import type { NetworkProxySettings } from '../../shared/network/network-proxy'
import type { ProxySession, SessionProxyConfig } from './electron-default-proxy-session'
import {
  clearElectronProxyCredentialsForSession,
  resetElectronProxyCredentialsForTests,
  type ElectronProxyCredentials
} from './electron-proxy-credentials'
import type { ProxyApplyResult } from './proxy-policy-resolution'
import { runBoundedProxyApplication } from './bounded-proxy-application'

export type SessionProxyApplicationState = {
  appliedKey: string | null
  settledKey: string | null
  appliedResult: Extract<ProxyApplyResult, { source: 'settings' | 'env' }> | null
  credentials: ElectronProxyCredentials | null
  tail: Promise<unknown>
  readiness: 'ready' | 'pending' | 'failed'
  retired: boolean
  override: SessionProxyConfig | null
  overrideUncertain: boolean
  restoreConfig: SessionProxyConfig
  requestedSettings: NetworkProxySettings
  requestedOptions: { env?: Record<string, string | undefined>; probeUrl?: string }
  configuration: SessionProxyConfig | null
  onConfigurationChanged?: () => void
}
let sessionProxyApplications = new WeakMap<ProxySession, SessionProxyApplicationState>()

function forgetProxySessionApplications(proxySession?: ProxySession): void {
  if (proxySession) {
    sessionProxyApplications.delete(proxySession)
  } else {
    sessionProxyApplications = new WeakMap()
  }
}

/** Wait for the newest policy; apply errors keep requests fail-closed. */
export async function awaitProxySessionApplication(proxySession: ProxySession): Promise<boolean> {
  while (true) {
    const state = sessionProxyApplications.get(proxySession)
    if (!state || state.retired) {
      return !state
    }
    const observed = state.tail
    try {
      await observed
    } catch {
      if (state.tail === observed) {
        return false
      }
      continue
    }
    if (state.tail === observed) {
      return !state.retired
    }
  }
}

export function getProxySessionApplicationReadiness(
  proxySession: ProxySession
): boolean | Promise<boolean> {
  const state = sessionProxyApplications.get(proxySession)
  if (!state) {
    return true
  }
  if (state.retired || state.readiness === 'failed') {
    return false
  }
  if (state.readiness === 'ready') {
    return true
  }
  return awaitProxySessionApplication(proxySession)
}

export function getSessionProxyApplicationState(
  proxySession: ProxySession
): SessionProxyApplicationState {
  let state = sessionProxyApplications.get(proxySession)
  if (!state) {
    state = {
      appliedKey: null,
      settledKey: null,
      appliedResult: null,
      credentials: null,
      tail: Promise.resolve(),
      readiness: 'ready',
      retired: false,
      override: null,
      overrideUncertain: false,
      restoreConfig: { mode: 'system' },
      requestedSettings: {},
      requestedOptions: {},
      configuration: null
    }
    sessionProxyApplications.set(proxySession, state)
  }
  return state
}

export async function enqueueSessionProxyApplication<T>(
  proxySession: ProxySession,
  apply: (state: SessionProxyApplicationState) => Promise<T>,
  allowRetired = false
): Promise<T> {
  const state = getSessionProxyApplicationState(proxySession)
  if (state.retired && !allowRetired) {
    throw new Error('Proxy session is retired')
  }
  const operation = state.tail
    .catch(() => {})
    .then(() => runBoundedProxyApplication(() => apply(state)))
  state.tail = operation
  state.readiness = 'pending'
  void operation.then(
    () => {
      if (state.tail === operation) {
        state.readiness = 'ready'
      }
    },
    () => {
      if (state.tail === operation) {
        state.readiness = 'failed'
      }
    }
  )
  return operation
}

export function getProxySessionConfiguration(
  proxySession: ProxySession,
  fallback: SessionProxyConfig
): SessionProxyConfig {
  const state = getSessionProxyApplicationState(proxySession)
  if (state.overrideUncertain || state.readiness === 'failed' || state.retired) {
    throw new Error('Proxy configuration is unavailable; reapply or clear the override')
  }
  return state.configuration ?? fallback
}

export function observeProxySessionConfiguration(
  proxySession: ProxySession,
  changed: () => void
): void {
  getSessionProxyApplicationState(proxySession).onConfigurationChanged = changed
}

export function clearProxySessionCredentials(proxySession: ProxySession): void {
  const state = getSessionProxyApplicationState(proxySession)
  state.credentials = null
  clearElectronProxyCredentialsForSession(proxySession)
}

export function resetProxyApplicationForTests(): void {
  forgetProxySessionApplications()
  resetElectronProxyCredentialsForTests()
}

export function resetSessionProxyApplicationForTests(proxySession: ProxySession): void {
  forgetProxySessionApplications(proxySession)
  clearElectronProxyCredentialsForSession(proxySession)
}
