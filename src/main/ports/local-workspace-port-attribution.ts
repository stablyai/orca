import path from 'node:path'
import { WorkspacePortPathIndex } from './workspace-port-path-index'
import { realpath } from 'node:fs/promises'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { blockedWslDistroForPath } from '../wsl/filesystem/wsl-unc-access-gate'
import { PrioritySemaphore } from '../../shared/priority-semaphore'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type {
  WorkspacePort,
  WorkspacePortOwner,
  WorkspacePortProbe
} from '../../shared/workspace-ports'
import type { AdvertisedUrlWatcher } from './advertised-url-watcher'
import { connectHostForBindHost } from './local-workspace-port-address'
import type {
  NormalizedWorkspacePortProbe,
  RawListeningPort
} from './local-workspace-port-scan-state'

const REALPATH_TIMEOUT_MS = 1_000
const realpathSlots = new PrioritySemaphore(2)
let aliasStart = 0
const pendingRealpaths = new Map<string, Promise<string | null | undefined>>()

function observeRealpath(root: string, deadline: number): Promise<string | null | undefined> {
  const pending = pendingRealpaths.get(root)
  if (pending) {
    return pending
  }
  const controller = new AbortController()
  const lookup = realpathSlots
    .acquire(0, controller.signal)
    .then((release) => {
      if (controller.signal.aborted || Date.now() >= deadline) {
        release()
        return undefined
      }
      return realpathUnlessWslStopped(root).finally(release)
    })
    .catch((error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        ? null
        : undefined
    )
    .finally(() => {
      if (pendingRealpaths.get(root) === operation) {
        pendingRealpaths.delete(root)
      }
    })
  const operation = withTimeout(lookup, Math.max(0, deadline - Date.now()), undefined).finally(() =>
    controller.abort()
  )
  pendingRealpaths.set(root, operation)
  return operation
}

/**
 * A WSL root's realpath is a 9P touch that starts a stopped distro (E9). The port scan is background,
 * so it never wakes one: a stopped root's alias stays unknown, as a timed-out lookup's does.
 */
async function realpathUnlessWslStopped(root: string): Promise<string | undefined> {
  if (await blockedWslDistroForPath(root)) {
    return undefined
  }
  return normalizeComparablePath(await realpath(root))
}

const HTTP_PORTS: Record<number, true> = {
  80: true,
  3000: true,
  3001: true,
  4200: true,
  5000: true,
  5173: true,
  5174: true,
  8000: true,
  8080: true,
  8888: true
}
const HTTPS_PORTS: Record<number, true> = { 443: true, 8443: true }

export function attributePortToWorkspace(
  port: Pick<RawListeningPort, 'cwd' | 'commandLine'>,
  worktrees: WorkspacePortProbe[]
): WorkspacePortOwner | undefined {
  return attributePortToNormalizedWorkspaces(
    port,
    new WorkspacePortPathIndex(normalizeWorkspacePortProbes(worktrees))
  )
}

export function normalizeWorkspacePortProbes(
  worktrees: readonly WorkspacePortProbe[]
): NormalizedWorkspacePortProbe[] {
  return worktrees.map((worktree) => ({
    worktree,
    normalizedPath: normalizeComparablePath(worktree.path)
  }))
}

export async function resolveWorkspacePortProbes(
  worktrees: readonly WorkspacePortProbe[],
  requireFresh = false
): Promise<{ probes: NormalizedWorkspacePortProbe[]; complete: boolean }> {
  const probes = normalizeWorkspacePortProbes(worktrees)
  const paths = [...new Set(worktrees.map((worktree) => worktree.path))]
  paths.push(...paths.splice(0, aliasStart++ % (paths.length || 1)))
  const older = paths.map((workspacePath) => pendingRealpaths.get(workspacePath))
  if (requireFresh) {
    // An older observation may release native work, but its alias cannot authorize this request.
    await Promise.all(older.filter((operation) => operation !== undefined))
  }
  const deadline = Date.now() + REALPATH_TIMEOUT_MS
  const resolvedPaths = new Map<string, string | null | undefined>()
  await withTimeout(
    mapWithConcurrency(paths, 2, async (workspacePath, index) => {
      const old = older[index]
      const blocked = requireFresh && old && pendingRealpaths.get(workspacePath) === old
      if (blocked || Date.now() >= deadline) {
        return
      }
      resolvedPaths.set(workspacePath, await observeRealpath(workspacePath, deadline))
    }),
    Math.max(0, deadline - Date.now()),
    []
  )
  const aliases = probes.flatMap((probe) => {
    const normalizedPath = resolvedPaths.get(probe.worktree.path)
    return normalizedPath && normalizedPath !== probe.normalizedPath
      ? [{ ...probe, normalizedPath }]
      : []
  })
  return {
    probes: [...probes, ...aliases],
    complete: paths.every((workspacePath) => resolvedPaths.get(workspacePath) !== undefined)
  }
}

function attributePortToNormalizedWorkspaces(
  port: Pick<RawListeningPort, 'cwd' | 'commandLine'>,
  index: WorkspacePortPathIndex
): WorkspacePortOwner | undefined {
  const cwd = port.cwd ? normalizeComparablePath(port.cwd) : null
  const commandLine = port.commandLine ? normalizeComparableText(port.commandLine) : null

  const cwdMatch = cwd ? index.findCwd(cwd) : undefined
  if (cwdMatch) {
    return toOwner(cwdMatch.worktree, 'cwd')
  }

  if (!commandLine) {
    return undefined
  }

  const commandMatch = index.findCommand(commandLine)
  return commandMatch ? toOwner(commandMatch.worktree, 'command') : undefined
}
type AttributedListeningPort = { port: RawListeningPort; owner: WorkspacePortOwner | undefined }

export function attributePortsToWorkspaces(
  ports: readonly RawListeningPort[],
  worktrees: readonly NormalizedWorkspacePortProbe[]
): AttributedListeningPort[] {
  let index: WorkspacePortPathIndex | undefined
  return ports.map((port) => ({
    port,
    owner:
      port.cwd || port.commandLine
        ? attributePortToNormalizedWorkspaces(
            port,
            (index ??= new WorkspacePortPathIndex(worktrees))
          )
        : undefined
  }))
}

export function enrichPort(
  { port, owner }: AttributedListeningPort,
  urlWatcher: Pick<AdvertisedUrlWatcher, 'lookup'>
): WorkspacePort {
  const base = {
    id: `${port.host}:${port.port}:${port.pid ?? 'unknown'}`,
    bindHost: port.host,
    connectHost: connectHostForBindHost(port.host),
    port: port.port,
    pid: port.pid,
    processName: port.processName,
    protocol: inferProtocol(port.port)
  }

  if (owner) {
    // Limit URL enrichment to workspace-owned ports so unrelated terminals cannot label external/container ports.
    const advertised = urlWatcher.lookup(owner.worktreeId, port.port, port.pid)
    return {
      ...base,
      protocol: advertised?.protocol ?? base.protocol,
      kind: 'workspace',
      owner,
      ...(advertised ? { advertisedUrl: advertised.origin } : {})
    }
  }
  if (isContainerProcess(port)) {
    return { ...base, kind: 'container' }
  }
  return { ...base, kind: 'external' }
}

export function reconcileAdvertisedUrls(
  ports: readonly AttributedListeningPort[],
  worktrees: readonly NormalizedWorkspacePortProbe[],
  urlWatcher: Pick<AdvertisedUrlWatcher, 'reconcileWorkspaces'>
): void {
  const observationsByWorktree = new Map<string, { port: number; pid?: number }[]>()
  for (const worktree of worktrees) {
    observationsByWorktree.set(worktree.worktree.id, [])
  }
  for (const { port, owner } of ports) {
    if (!owner) {
      continue
    }
    observationsByWorktree.get(owner.worktreeId)?.push({ port: port.port, pid: port.pid })
  }
  // Invalidate disappeared/changed listeners before lazy lookup can pin a stale banner.
  urlWatcher.reconcileWorkspaces(observationsByWorktree)
}

export function compareWorkspacePorts(a: WorkspacePort, b: WorkspacePort): number {
  const aRank = a.kind === 'workspace' ? 0 : a.kind === 'container' ? 1 : 2
  const bRank = b.kind === 'workspace' ? 0 : b.kind === 'container' ? 1 : 2
  return aRank - bRank || a.port - b.port || a.connectHost.localeCompare(b.connectHost)
}

function inferProtocol(port: number): 'http' | 'https' | 'unknown' {
  if (HTTPS_PORTS[port] === true) {
    return 'https'
  }
  if (HTTP_PORTS[port] === true) {
    return 'http'
  }
  return 'unknown'
}

export function isContainerProcess(
  port: Pick<RawListeningPort, 'processName' | 'commandLine'>
): boolean {
  const haystack = `${port.processName ?? ''} ${port.commandLine ?? ''}`.toLowerCase()
  return /\b(com\.[\w.-]+\.backend|com\.container\w*|container\w*)\b/.test(haystack)
}

function toOwner(
  worktree: WorkspacePortProbe,
  confidence: WorkspacePortOwner['confidence']
): WorkspacePortOwner {
  return {
    worktreeId: worktree.id,
    repoId: worktree.repoId,
    displayName: worktree.displayName,
    path: worktree.path,
    confidence
  }
}

function normalizeComparablePath(input: string): string {
  if (input.startsWith('/')) {
    // Windows may evaluate remote POSIX paths; native resolve would reinterpret /repo as G:/repo.
    return normalizeComparableText(path.posix.resolve(input))
  }
  return normalizeComparableText(path.resolve(input))
}

function normalizeComparableText(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/\/+/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
