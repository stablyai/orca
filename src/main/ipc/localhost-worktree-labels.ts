import { ipcMain } from 'electron'
import { URL } from 'node:url'
import {
  LOOPBACK_LOCALHOST_HOSTS,
  normalizeLocalhostHostname,
  type LocalhostWorktreeLabelResult,
  type LocalhostWorktreeLabelRoute
} from '../../shared/localhost-worktree-labels'
import type { Store } from '../persistence'
import { localhostWorktreeLabelProxy } from '../localhost-worktree-label-proxy'
import {
  getStoreWorkspacePortProbes,
  scanWorkspacePortProbes
} from '../ports/workspace-port-ownership'

export function registerLocalhostWorktreeLabelHandlers(store: Store): void {
  ipcMain.handle(
    'localhostWorktreeLabels:register',
    async (_event, rawArgs: unknown): Promise<LocalhostWorktreeLabelResult> => {
      const route = parseRegisterArgs(rawArgs)
      // Why: the proxy will forward to any host it's given, so we restrict the
      // target to loopback or a host:port that matches a live workspace port —
      // otherwise this IPC is an open proxy / SSRF vector.
      await assertAllowedTarget(store, route.targetUrl)
      return localhostWorktreeLabelProxy.registerRoute(route)
    }
  )
}

async function assertAllowedTarget(store: Store, targetUrl: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(targetUrl)
  } catch {
    throw new Error('Localhost label target is not a valid URL.')
  }
  const targetHost = normalizeLocalhostHostname(parsed.hostname)
  if (LOOPBACK_LOCALHOST_HOSTS.has(targetHost)) {
    return
  }

  // Why: URL drops the port for protocol defaults (e.g. http://host/ on 80),
  // so compare against the effective port rather than the raw (empty) string.
  const targetPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
  const scan = await scanWorkspacePortProbes(getStoreWorkspacePortProbes(store))
  const matches = scan.ports.some((port) => {
    if (String(port.port) !== targetPort) {
      return false
    }
    if (normalizeLocalhostHostname(port.connectHost) === targetHost) {
      return true
    }
    const advertisedUrl = 'advertisedUrl' in port ? port.advertisedUrl : undefined
    if (!advertisedUrl) {
      return false
    }
    try {
      return normalizeLocalhostHostname(new URL(advertisedUrl).hostname) === targetHost
    } catch {
      return false
    }
  })
  if (!matches) {
    throw new Error('Localhost label target is not an allowed workspace port.')
  }
}

function parseRegisterArgs(value: unknown): LocalhostWorktreeLabelRoute {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid localhost label route.')
  }
  const candidate = value as Record<string, unknown>
  const targetUrl = readRequiredString(candidate.targetUrl, 'targetUrl')
  const projectName = readRequiredString(candidate.projectName, 'projectName')
  const worktreeName = readRequiredString(candidate.worktreeName, 'worktreeName')
  return {
    targetUrl,
    projectName,
    worktreeName,
    repoId: readOptionalString(candidate.repoId),
    worktreeId: readOptionalString(candidate.worktreeId)
  }
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid localhost label ${field}.`)
  }
  return value.trim()
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
