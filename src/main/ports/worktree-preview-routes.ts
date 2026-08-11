// Why: the preview proxy (Host-header routing) and the workspace port scan
// enrichment (previewUrl per port) must derive identical labels and URLs, or a
// URL shown in the ports panel would not resolve on the proxy. Both sides
// import this module and nothing else computes preview labels.
import { URL } from 'node:url'
import {
  getLocalhostWorktreeHostLabel,
  parseLoopbackUrlWithPort
} from '../../shared/localhost-worktree-labels'
import type { WorkspacePort, WorkspacePortScanResult } from '../../shared/workspace-ports'

export const PREVIEW_TOKEN_QUERY_PARAM = 'orca-preview-token'
/** `--` never occurs inside a generated label (slugify collapses runs to one `-`),
 *  so it can unambiguously separate an explicit port suffix. */
const PREVIEW_PORT_SEPARATOR = '--'

export type PreviewPublicOrigin = {
  protocol: 'http' | 'https'
  host: string
  port: number | null
}

export type PreviewWorktreeDescriptor = {
  worktreeId: string
  repoId: string
  projectName: string
  worktreeName: string
  worktreePath: string
}

export type PreviewProxyPublicConfig = {
  origin: PreviewPublicOrigin
  token: string | null
}

/** Parses `--preview-domain`: `[scheme://]host[:port]`, no path/query. */
export function parsePreviewDomain(raw: string): PreviewPublicOrigin {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Preview domain must not be empty.')
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`Invalid preview domain: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Preview domain must use http or https: ${raw}`)
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`Preview domain must be a bare host, without path or query: ${raw}`)
  }
  const host = url.hostname.toLowerCase()
  if (!host || host.includes('*')) {
    throw new Error(`Preview domain must name the base host, not a wildcard: ${raw}`)
  }
  return {
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    host,
    port: url.port ? Number(url.port) : null
  }
}

/** Deterministic label per worktree so proxy and enrichment agree across
 *  processes and scans: sort by worktreeId, then suffix `-2`, `-3`… on collision. */
export function buildPreviewLabels(
  descriptors: readonly PreviewWorktreeDescriptor[]
): Map<string, string> {
  const labels = new Map<string, string>()
  const taken = new Set<string>()
  const sorted = [...descriptors].sort((a, b) => a.worktreeId.localeCompare(b.worktreeId))
  for (const descriptor of sorted) {
    const base = getLocalhostWorktreeHostLabel({
      projectName: descriptor.projectName,
      worktreeName: descriptor.worktreeName,
      worktreePath: descriptor.worktreePath
    })
    let label = base
    for (let index = 2; taken.has(label); index += 1) {
      label = `${base}-${index}`
    }
    taken.add(label)
    labels.set(descriptor.worktreeId, label)
  }
  return labels
}

export function buildPreviewPortUrl(options: {
  origin: PreviewPublicOrigin
  label: string
  port: number
  token: string | null
}): string {
  const { origin, label, port, token } = options
  const originPort = origin.port ? `:${origin.port}` : ''
  const url = new URL(
    `${origin.protocol}://${label}${PREVIEW_PORT_SEPARATOR}${port}.${origin.host}${originPort}/`
  )
  if (token) {
    url.searchParams.set(PREVIEW_TOKEN_QUERY_PARAM, token)
  }
  return url.toString()
}

export type ParsedPreviewHost = {
  label: string
  /** Explicit `--<port>` suffix; null routes to the worktree's primary port. */
  port: number | null
}

export function parsePreviewHost(
  hostHeader: string | undefined,
  origin: PreviewPublicOrigin
): ParsedPreviewHost | null {
  const host = String(hostHeader ?? '')
    .split(':')[0]
    ?.toLowerCase()
  const suffix = `.${origin.host}`
  if (!host || !host.endsWith(suffix)) {
    return null
  }
  const sub = host.slice(0, -suffix.length)
  // Why: exactly one DNS label — a dotted prefix is either a spoofed Host or a
  // wildcard-DNS typo, and must not fuzzy-match a route.
  if (!sub || sub.includes('.') || !/^[a-z0-9-]+$/.test(sub)) {
    return null
  }
  const separatorIndex = sub.lastIndexOf(PREVIEW_PORT_SEPARATOR)
  if (separatorIndex > 0) {
    const portText = sub.slice(separatorIndex + PREVIEW_PORT_SEPARATOR.length)
    if (/^\d{1,5}$/.test(portText)) {
      const port = Number(portText)
      if (port > 0 && port <= 65535) {
        return { label: sub.slice(0, separatorIndex), port }
      }
    }
  }
  return { label: sub, port: null }
}

/** Ports the preview proxy can serve: workspace-attributed and not https
 *  (v1 forwards plain http; an https dev server would need TLS to the target). */
export function isPreviewablePort(
  port: WorkspacePort
): port is WorkspacePort & { kind: 'workspace' } {
  return port.kind === 'workspace' && port.protocol !== 'https'
}

export function advertisedLoopbackPort(port: WorkspacePort & { kind: 'workspace' }): number | null {
  if (!port.advertisedUrl) {
    return null
  }
  const advertised = parseLoopbackUrlWithPort(port.advertisedUrl)
  return advertised ? Number(advertised.port) : null
}

export function enrichScanWithPreviewUrls(
  scan: WorkspacePortScanResult,
  descriptors: readonly PreviewWorktreeDescriptor[],
  config: PreviewProxyPublicConfig
): WorkspacePortScanResult {
  const labels = buildPreviewLabels(descriptors)
  return {
    ...scan,
    ports: scan.ports.map((port) => {
      if (!isPreviewablePort(port)) {
        return port
      }
      const label = labels.get(port.owner.worktreeId)
      if (!label) {
        return port
      }
      return {
        ...port,
        previewUrl: buildPreviewPortUrl({
          origin: config.origin,
          label,
          port: port.port,
          token: config.token
        })
      }
    })
  }
}

// Why: module-level so orca-runtime's scan enrichment can see the serve-time
// proxy config without threading serve options through its constructor.
let activePreviewProxyConfig: PreviewProxyPublicConfig | null = null

export function setActivePreviewProxyConfig(config: PreviewProxyPublicConfig | null): void {
  activePreviewProxyConfig = config
}

export function getActivePreviewProxyConfig(): PreviewProxyPublicConfig | null {
  return activePreviewProxyConfig
}
