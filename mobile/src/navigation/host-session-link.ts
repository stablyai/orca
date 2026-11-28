import { resolveHostIdForFingerprint } from '../notifications/payload-identity/push-host-fingerprint'

/**
 * `orca://session?host=<fingerprint>&worktree=<worktreeId>&paneKey=<paneKey>` opens a session from outside the app.
 * Host ids are local to each phone, so the link names its host by key fingerprint, as gateway pushes do.
 */
export type HostSessionLink = { hostFingerprint: string; worktreeId: string; paneKey?: string }

const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{16}$/
const MAX_ID_CHARS = 1024

function readBoundedParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name)
  return value && value.length <= MAX_ID_CHARS ? value : null
}

export function parseHostSessionLink(value: string): HostSessionLink | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (
    url.protocol !== 'orca:' ||
    url.host !== 'session' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    return null
  }
  const hostFingerprint = url.searchParams.get('host')
  const worktreeId = readBoundedParam(url.searchParams, 'worktree')
  if (!hostFingerprint || !FINGERPRINT_PATTERN.test(hostFingerprint) || !worktreeId) {
    return null
  }
  const paneKey = readBoundedParam(url.searchParams, 'paneKey')
  if (url.searchParams.has('paneKey') && !paneKey) {
    return null
  }
  return { hostFingerprint, worktreeId, ...(paneKey ? { paneKey } : {}) }
}

// Shaped like notification route data so the link opens through the same host-stack navigation as a push tap.
export function hostSessionLinkRouteData(
  link: HostSessionLink,
  hosts: readonly { readonly id: string; readonly publicKeyB64: string }[]
): { hostId: string; worktreeId: string; paneKey?: string } | null {
  const hostId = resolveHostIdForFingerprint(link.hostFingerprint, hosts)
  return hostId
    ? { hostId, worktreeId: link.worktreeId, ...(link.paneKey ? { paneKey: link.paneKey } : {}) }
    : null
}

// Links resolve asynchronously, so only the newest link may navigate; an older one finishing late must not win.
export function createLatestLinkGate(): { claim: () => () => boolean } {
  let latest = 0
  return {
    claim() {
      const id = ++latest
      return () => id === latest
    }
  }
}
