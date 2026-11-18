import {
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment,
  normalizeProxyBypassRules,
  normalizeProxyUrl,
  type NetworkProxySettings
} from '../../shared/network/network-proxy'
import {
  clearElectronProxyCredentialsForSession,
  haveSameElectronProxyCredentials,
  separateElectronProxyCredentials,
  setElectronProxyCredentialsForSession,
  type ElectronProxyCredentials
} from './electron-proxy-credentials'
import {
  defaultProxySession,
  type ProxySession,
  type SessionProxyConfig
} from './electron-default-proxy-session'
import {
  resolveProxyPolicyWithoutSession,
  proxyPolicyKey,
  type ProxyApplyResult
} from './proxy-policy-resolution'

import {
  clearProxySessionCredentials,
  getSessionProxyApplicationState,
  enqueueSessionProxyApplication,
  type SessionProxyApplicationState
} from './session-proxy-application'
export {
  clearProxySessionCredentials,
  resetProxyApplicationForTests,
  resetSessionProxyApplicationForTests,
  awaitProxySessionApplication,
  getProxySessionApplicationReadiness,
  getProxySessionConfiguration,
  observeProxySessionConfiguration
} from './session-proxy-application'

const PROXY_PROBE_URL = 'https://api.anthropic.com/'

export async function releaseProxySessionApplication(
  proxySession: ProxySession,
  allowRetired = false
): Promise<void> {
  await enqueueSessionProxyApplication(
    proxySession,
    async (state) => {
      if (state.override) {
        await proxySession.setProxy(state.restoreConfig)
        state.configuration = state.restoreConfig
        await proxySession.closeAllConnections?.()
        state.override = null
      }
      await releaseSessionProxyPin(proxySession, state)
      clearElectronProxyCredentialsForSession(proxySession)
      return { source: 'none' }
    },
    allowRetired
  )
}

export async function retireProxySessionApplication(proxySession: ProxySession): Promise<void> {
  const state = getSessionProxyApplicationState(proxySession)
  state.retired = true
  try {
    await releaseProxySessionApplication(proxySession, true)
  } finally {
    clearProxySessionCredentials(proxySession)
  }
}

export function applyProxySettingsToSession(
  proxySession: ProxySession,
  settings: NetworkProxySettings,
  options: { env?: Record<string, string | undefined>; probeUrl?: string } = {}
): Promise<ProxyApplyResult> {
  return enqueueSessionProxyApplication(proxySession, (state) => {
    state.requestedSettings = settings
    state.requestedOptions = options
    if (state.overrideUncertain) {
      throw new Error('Proxy override must be reapplied or cleared before requests can resume')
    }
    return state.override
      ? Promise.resolve<ProxyApplyResult>({ source: 'extension' })
      : resolveAndApplySessionProxy(proxySession, state, settings, options)
  }).then((result) => {
    getSessionProxyApplicationState(proxySession).onConfigurationChanged?.()
    return result
  })
}

/** Extension overrides share the app policy queue; app changes are remembered until release. */
export function setProxySessionOverride(
  proxySession: ProxySession,
  config: SessionProxyConfig | null,
  restoreConfig: SessionProxyConfig
): Promise<void> {
  const operation = enqueueSessionProxyApplication(proxySession, async (state) => {
    const previous = state.override
    if (!state.overrideUncertain && JSON.stringify(previous) === JSON.stringify(config)) {
      return null
    }
    const apply = async (next: SessionProxyConfig | null): Promise<void> => {
      clearProxySessionCredentials(proxySession)
      state.appliedKey = null
      state.settledKey = null
      state.appliedResult = null
      await proxySession.setProxy(next ?? restoreConfig)
      state.configuration = next ?? restoreConfig
      if (!next) {
        await resolveAndApplySessionProxy(
          proxySession,
          state,
          state.requestedSettings,
          state.requestedOptions
        )
      }
      await proxySession.closeAllConnections?.()
      if ((next ?? restoreConfig).mode === 'pac_script') {
        await proxySession.forceReloadProxyConfig?.()
      }
    }
    try {
      await apply(config)
      state.override = config
      state.restoreConfig = restoreConfig
      state.overrideUncertain = false
      return null
    } catch (error) {
      try {
        await apply(previous)
        state.overrideUncertain = false
      } catch (rollbackError) {
        state.overrideUncertain = true
        throw new AggregateError(
          [error, rollbackError],
          'Could not apply or restore proxy configuration'
        )
      }
      return { error }
    }
  })
  return operation.then((failure) => {
    if (failure) {
      throw failure.error
    }
  })
}

async function resolveAndApplySessionProxy(
  proxySession: ProxySession,
  state: SessionProxyApplicationState,
  settings: NetworkProxySettings,
  options: { env?: Record<string, string | undefined>; probeUrl?: string }
): Promise<ProxyApplyResult> {
  const env = options.env ?? process.env
  const configured = normalizeProxyUrl(settings.httpProxyUrl)
  if (configured.ok && configured.value) {
    const { proxyRules, credentials } = separateElectronProxyCredentials(configured.value)
    const bypassRules = normalizeProxyBypassRules(settings.httpProxyBypassRules)
    const result: ProxyApplyResult = {
      source: 'settings',
      proxyRules,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    }
    return applySessionProxyResult(proxySession, state, result, credentials)
  }

  const envProxy = getProxyUrlFromEnvironment(env)
  if (envProxy.ok && envProxy.value) {
    const { proxyRules, credentials } = separateElectronProxyCredentials(envProxy.value)
    const bypassRules = normalizeProxyBypassRules(getProxyBypassRulesFromEnvironment(env))
    const result: Extract<ProxyApplyResult, { source: 'env' }> = {
      source: 'env',
      proxyRules,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    }
    if (
      state.settledKey === proxyPolicyKey(result) &&
      haveSameElectronProxyCredentials(state.credentials, credentials)
    ) {
      return result
    }
  }

  // Release our pin before probing or it would answer instead of system policy.
  await releaseSessionProxyPin(proxySession, state)
  if ((await proxySession.resolveProxy(options.probeUrl ?? PROXY_PROBE_URL)) !== 'DIRECT') {
    return { source: 'system' }
  }
  if (!envProxy.ok) {
    return { source: configured.ok ? 'invalid-env' : 'invalid-settings' }
  }
  if (!envProxy.value) {
    return { source: configured.ok ? 'none' : 'invalid-settings' }
  }

  const { proxyRules, credentials } = separateElectronProxyCredentials(envProxy.value)
  const bypassRules = normalizeProxyBypassRules(getProxyBypassRulesFromEnvironment(env))
  return applySessionProxyResult(
    proxySession,
    state,
    {
      source: 'env',
      proxyRules,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    },
    credentials
  )
}

async function releaseSessionProxyPin(
  proxySession: ProxySession,
  state: SessionProxyApplicationState
): Promise<void> {
  if (state.appliedKey === null) {
    return
  }
  await proxySession.setProxy({ mode: 'system' })
  state.configuration = { mode: 'system' }
  // Retain the pin marker until stale pooled connections close so retries cannot skip cleanup.
  state.settledKey = null
  state.credentials = null
  setElectronProxyCredentialsForSession(proxySession, null)
  await proxySession.closeAllConnections?.()
  state.appliedKey = null
  state.appliedResult = null
}

async function applySessionProxyResult(
  proxySession: ProxySession,
  state: SessionProxyApplicationState,
  result: Extract<ProxyApplyResult, { source: 'settings' | 'env' }>,
  credentials: ElectronProxyCredentials | null
): Promise<ProxyApplyResult> {
  const key = proxyPolicyKey(result)
  if (
    state.settledKey === key &&
    haveSameElectronProxyCredentials(state.credentials, credentials)
  ) {
    return result
  }
  await proxySession.setProxy({
    mode: 'fixed_servers',
    proxyRules: result.proxyRules,
    ...(result.proxyBypassRules ? { proxyBypassRules: result.proxyBypassRules } : {})
  })
  state.configuration = {
    mode: 'fixed_servers',
    proxyRules: result.proxyRules,
    proxyBypassRules: result.proxyBypassRules
  }
  state.appliedKey = key
  state.settledKey = null
  state.appliedResult = result
  state.credentials = credentials
  setElectronProxyCredentialsForSession(proxySession, credentials)
  await proxySession.closeAllConnections?.()
  state.settledKey = key
  return result
}

export async function ensureElectronProxyFromEnvironment(
  options: {
    proxySession?: ProxySession
    env?: Record<string, string | undefined>
    force?: boolean
    probeUrl?: string
  } = {}
): Promise<ProxyApplyResult> {
  const proxySession = options.proxySession ?? defaultProxySession()
  if (!proxySession) {
    return resolveProxyPolicyWithoutSession({}, options.env ?? process.env)
  }
  return enqueueSessionProxyApplication(proxySession, (state) => {
    if (state.overrideUncertain) {
      throw new Error('Proxy override must be reapplied or cleared before requests can resume')
    }
    if (state.override) {
      return Promise.resolve<ProxyApplyResult>({ source: 'extension' })
    }
    if (!options.force && state.appliedResult !== null) {
      if (state.settledKey === proxyPolicyKey(state.appliedResult)) {
        return Promise.resolve(state.appliedResult)
      }
      return applySessionProxyResult(proxySession, state, state.appliedResult, state.credentials)
    }
    return resolveAndApplySessionProxy(proxySession, state, {}, options)
  })
}

export function applyElectronProxySettings(
  settings: NetworkProxySettings,
  options: {
    proxySession?: ProxySession
    env?: Record<string, string | undefined>
    probeUrl?: string
  } = {}
): Promise<ProxyApplyResult> {
  const proxySession = options.proxySession ?? defaultProxySession()
  if (!proxySession) {
    return Promise.resolve(resolveProxyPolicyWithoutSession(settings, options.env ?? process.env))
  }
  return applyProxySettingsToSession(proxySession, settings, {
    env: options.env,
    probeUrl: options.probeUrl
  })
}
