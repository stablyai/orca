import { getConfiguredGitLabHost } from './gitlab-known-host-probe'
import { normalizeGitLabHost } from './project-ref-parser'

export type ConfiguredGitLabHostResolution =
  | { ok: true; host: string }
  | { ok: false; reason: string }

/**
 * Pin a caller-supplied host to the one configured instance. A supplied host is
 * a `glab --hostname` override that bypasses remote resolution entirely, so an
 * unpinned one would route credentialed calls at an arbitrary GitLab. Returns
 * the canonical configured host so downstream calls never carry the caller's
 * spelling. Non-throwing so parse-time boundaries can report their own way.
 */
export function resolveConfiguredGitLabHost(
  host: string | null | undefined
): ConfiguredGitLabHostResolution {
  const configured = getConfiguredGitLabHost()
  if (!configured) {
    return { ok: false, reason: 'no GitLab instance is configured' }
  }
  if (normalizeGitLabHost(host ?? '') !== configured) {
    return { ok: false, reason: 'GitLab host does not match the configured instance' }
  }
  return { ok: true, host: configured }
}

export function assertConfiguredGitLabHost(host: string | null | undefined): string {
  const resolution = resolveConfiguredGitLabHost(host)
  if (!resolution.ok) {
    throw new Error(`Access denied: ${resolution.reason}`)
  }
  return resolution.host
}

export function assertConfiguredProjectRef<T extends { host: string }>(
  projectRef: T | null | undefined
): T | null | undefined {
  return projectRef
    ? { ...projectRef, host: assertConfiguredGitLabHost(projectRef.host) }
    : projectRef
}
