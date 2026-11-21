import { createHash } from 'node:crypto'
import { net, session, type Session } from 'electron'
import type { MainHttpClient } from '../network/http-client'
import { hasElectronProxyCredentialsForSession } from '../network/electron-proxy-credentials'
import {
  applyProxySettingsToSession,
  getProxySessionApplicationReadiness
} from '../network/proxy-settings'
import type { NetworkProxySettings } from '../../shared/network/network-proxy'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import { fetchWithProxyLogin } from './electron-proxy-login-fetch'

function isHttpUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

async function hasConfiguredProxyCredentials(
  proxySession: Session,
  signal: AbortSignal | undefined
): Promise<boolean> {
  // Credentials are installed while a proxy policy applies; a cold request must wait for it.
  const readiness = getProxySessionApplicationReadiness(proxySession)
  if (readiness !== true && !(await waitForPromiseWithSignal(Promise.resolve(readiness), signal))) {
    return false
  }
  return hasElectronProxyCredentialsForSession(proxySession)
}

async function fetchFromSession(
  proxySession: Session,
  url: string,
  init: RequestInit | undefined,
  fetchDirect: (url: string, init?: RequestInit) => Promise<Response>
): Promise<Response> {
  if (
    isHttpUrl(url) &&
    (await hasConfiguredProxyCredentials(proxySession, init?.signal ?? undefined))
  ) {
    return fetchWithProxyLogin(new Request(url, init), proxySession)
  }
  return fetchDirect(url, init)
}

function fetchFromDefaultSession(url: string, init?: RequestInit): Promise<Response> {
  // Not ready falls through too: the default-session request guard cancels it.
  return fetchFromSession(session.defaultSession, url, init, net.fetch)
}

/** One in-memory partition per proxy so concurrent requests through different proxies never share a session. */
async function fetchThroughProxy(
  proxy: NetworkProxySettings,
  url: string,
  init?: RequestInit
): Promise<Response> {
  // Hash so proxy credentials never appear in the partition name.
  const key = createHash('sha256')
    .update(`${proxy.httpProxyUrl ?? ''}\0${proxy.httpProxyBypassRules ?? ''}`)
    .digest('hex')
    .slice(0, 32)
  const proxySession = session.fromPartition(`orca-proxy-${key}`)
  const applied = await applyProxySettingsToSession(proxySession, proxy, { probeUrl: url })
  if (applied.source !== 'settings') {
    throw new Error('Proxy settings are invalid')
  }
  return fetchFromSession(proxySession, url, init, (directUrl, directInit) =>
    proxySession.fetch(directUrl, directInit)
  )
}

/** Chromium honors session/proxy state; read defaultSession per call because it throws before app readiness. */
export const electronHttpClient: MainHttpClient = {
  fetch: fetchFromDefaultSession,
  fetchThroughProxy,
  proxySession: () => session.defaultSession,
  partitionSession: (partition) => session.fromPartition(partition)
}
