import type { Session } from 'electron'

/**
 * Outbound HTTP for main-process integrations.
 *
 * Why a port: the desktop uses Electron's Chromium-backed network stack — it follows
 * session/proxy state, avoids undici's stale keep-alive sockets after a VPN path change,
 * and sends a Chrome user agent that some APIs (Jira's XSRF check) depend on. None of
 * that exists on a host with no Chromium.
 *
 * The Node default is the platform global. That is a real behavioural difference, not a
 * transparent swap, which is why this is a named port rather than a silent fallback:
 * a Node host reads proxy configuration from the environment instead of from Chromium,
 * and sends Node's user agent.
 *
 * Body safety (orca#8695): the global uses undici, where an unread response body can
 * crash the process. This port hands the Response straight to its caller and never
 * inspects it, so the consume/cancel obligation stays exactly where it already was —
 * with the caller, unchanged from when they called Electron's net directly.
 */

export type MainHttpClient = {
  fetch(url: string, init?: RequestInit): Promise<Response>
  /** The Chromium session whose proxy state applies, or null on a host without one. */
  proxySession(): Session | null
}

const nodeHttpClient: MainHttpClient = {
  fetch: (url, init) => globalThis.fetch(url, init),
  proxySession: () => null
}

let current: MainHttpClient = nodeHttpClient

export function setMainHttpClient(client: MainHttpClient | null): void {
  current = client ?? nodeHttpClient
}

export function getMainHttpClient(): MainHttpClient {
  return current
}
