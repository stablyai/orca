/* eslint-disable max-lines -- Why: package-manager detection, target building,
and fixed-command execution share one safety boundary. */
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createPackageManagerCacheTargetId,
  detectPackageManagersFromFilenames,
  getPackageManagerCacheCleanupAction,
  getPackageManagerCacheCleanupActions,
  getPackageManagerLabel
} from '../shared/package-manager-cache-cleanup'
import type {
  WorkspacePackageManager,
  WorkspacePackageManagerCacheCleanupRequest,
  WorkspacePackageManagerCacheCleanupResult,
  WorkspacePackageManagerCacheTarget,
  WorkspacePackageManagerCacheTargetWorktree
} from '../shared/workspace-space-types'
import type { IFilesystemProvider } from './providers/types'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import { commandExecFileAsync } from './git/runner'

const CLI_CHECK_TIMEOUT_MS = 8_000
const CACHE_PATH_TIMEOUT_MS = 8_000
const CACHE_SIZE_TIMEOUT_MS = 30_000
const CLEANUP_TIMEOUT_MS = 120_000
const CLEANUP_MAX_BUFFER_BYTES = 4 * 1024 * 1024

export type WorkspacePackageManagerDetection = {
  packageManager: WorkspacePackageManager
  connectionId: string | null
  isRemote: boolean
  repoDisplayName: string
  worktreeId: string
  worktreePath: string
  lockfiles: string[]
}

type PackageManagerTargetSeed = {
  packageManager: WorkspacePackageManager
  connectionId: string | null
  isRemote: boolean
  repoDisplayNames: Set<string>
  cwd: string
  cachePath: string | null
  cliAvailable: boolean
  lockfiles: Set<string>
  detectedWorktrees: Map<string, Set<string>>
  worktreePaths: Set<string>
}

type ExecResult = {
  stdout: string
  stderr: string
}

type CacheSizeSnapshot = {
  path: string
  sizeBytes: number | null
}

function createTargetLabel(seed: PackageManagerTargetSeed): string {
  const manager = getPackageManagerLabel(seed.packageManager)
  const cachePath = seed.cachePath ? ` cache at ${seed.cachePath}` : ''
  if (!seed.isRemote) {
    return `${manager}${cachePath || ' on this computer'}`
  }
  const repoNames = [...seed.repoDisplayNames].sort((a, b) => a.localeCompare(b))
  return `${manager}${cachePath || ` on ${repoNames[0] ?? seed.connectionId ?? 'SSH target'}`}`
}

function isKnownPackageManager(value: unknown): value is WorkspacePackageManager {
  return value === 'npm' || value === 'pnpm' || value === 'yarn' || value === 'bun'
}

function normalizeConnectionId(value: unknown): string | null | undefined {
  if (value === null) {
    return null
  }
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  return undefined
}

function validateCleanupRequest(request: unknown):
  | {
      ok: true
      value: {
        targetId: string
        actionId: string
        packageManager: WorkspacePackageManager
        connectionId: string | null
        cwd: string
      }
    }
  | { ok: false; error: string } {
  if (!request || typeof request !== 'object') {
    return { ok: false, error: 'Invalid package-manager cache cleanup request.' }
  }
  const candidate = request as Partial<WorkspacePackageManagerCacheCleanupRequest>
  const connectionId = normalizeConnectionId(candidate.connectionId)
  if (
    typeof candidate.targetId !== 'string' ||
    candidate.targetId.length === 0 ||
    typeof candidate.actionId !== 'string' ||
    candidate.actionId.length === 0 ||
    !isKnownPackageManager(candidate.packageManager) ||
    connectionId === undefined ||
    typeof candidate.cwd !== 'string' ||
    candidate.cwd.length === 0
  ) {
    return { ok: false, error: 'Invalid package-manager cache cleanup request.' }
  }
  return {
    ok: true,
    value: {
      targetId: candidate.targetId,
      actionId: candidate.actionId,
      packageManager: candidate.packageManager,
      connectionId,
      cwd: candidate.cwd
    }
  }
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const spawnError = (error as { spawnError?: unknown }).spawnError
    if (typeof spawnError === 'string' && spawnError.trim()) {
      return spawnError
    }
  }
  return error instanceof Error ? error.message : String(error)
}

function didExecSucceed(result: {
  exitCode?: number | null
  timedOut?: boolean
  spawnError?: string
}): boolean {
  return (
    !result.spawnError &&
    !result.timedOut &&
    (result.exitCode === undefined || result.exitCode === 0)
  )
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
  )
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void | Promise<void>
): Promise<T> {
  if (!signal) {
    return promise
  }
  if (signal.aborted) {
    await onAbort?.()
    throw createAbortError()
  }
  let abortHandler: (() => void) | null = null
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => {
      void onAbort?.()
      reject(createAbortError())
    }
    signal.addEventListener('abort', abortHandler, { once: true })
  })
  try {
    return await Promise.race([promise, abortPromise])
  } finally {
    if (abortHandler) {
      signal.removeEventListener('abort', abortHandler)
    }
  }
}

async function execPackageManagerCommand(args: {
  connectionId: string | null
  cwd: string
  binary: string
  commandArgs: string[]
  timeoutMs: number
  signal?: AbortSignal
}): Promise<ExecResult> {
  if (args.connectionId) {
    const provider = getSshGitProvider(args.connectionId)
    if (!provider) {
      throw new Error(`SSH connection "${args.connectionId}" is not connected.`)
    }
    if (args.signal?.aborted) {
      throw createAbortError()
    }
    const result = await awaitWithAbort(
      provider.execNonInteractive(
        args.binary,
        args.commandArgs,
        args.cwd,
        args.timeoutMs,
        args.signal
      ),
      args.signal
    )
    if (result.canceled) {
      throw createAbortError()
    }
    if (!didExecSucceed(result)) {
      throw new Error(
        result.timedOut
          ? `${args.binary} timed out.`
          : result.spawnError ||
              result.stderr.trim() ||
              `${args.binary} exited with ${result.exitCode}.`
      )
    }
    return { stdout: result.stdout, stderr: result.stderr }
  }

  return commandExecFileAsync(args.binary, args.commandArgs, {
    cwd: args.cwd,
    timeout: args.timeoutMs,
    maxBuffer: CLEANUP_MAX_BUFFER_BYTES,
    signal: args.signal
  })
}

function parseFirstOutputLine(stdout: string): string | null {
  return (
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  )
}

async function resolveCachePath(args: {
  packageManager: WorkspacePackageManager
  connectionId: string | null
  cwd: string
  signal?: AbortSignal
}): Promise<string | null> {
  const command =
    args.packageManager === 'pnpm'
      ? { binary: 'pnpm', commandArgs: ['store', 'path'] }
      : args.packageManager === 'npm'
        ? { binary: 'npm', commandArgs: ['config', 'get', 'cache'] }
        : null
  if (!command) {
    return null
  }
  try {
    const result = await execPackageManagerCommand({
      connectionId: args.connectionId,
      cwd: args.cwd,
      binary: command.binary,
      commandArgs: command.commandArgs,
      timeoutMs: CACHE_PATH_TIMEOUT_MS,
      signal: args.signal
    })
    return parseFirstOutputLine(result.stdout)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    return null
  }
}

async function measureLocalDirectorySize(targetPath: string): Promise<number | null> {
  const pendingPaths = [targetPath]
  let totalSize = 0
  while (pendingPaths.length > 0) {
    const currentPath = pendingPaths.pop()
    if (!currentPath) {
      continue
    }
    let stats: Awaited<ReturnType<typeof lstat>>
    try {
      stats = await lstat(currentPath)
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : ''
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        continue
      }
      return null
    }
    totalSize += stats.size
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      continue
    }
    try {
      const entries = await readdir(currentPath, { withFileTypes: true })
      for (const entry of entries) {
        pendingPaths.push(join(currentPath, entry.name))
      }
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : ''
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return null
      }
    }
  }
  return totalSize
}

function parseDuSizeBytes(stdout: string): number | null {
  const match = /^(\d+)\s+/.exec(stdout.trim())
  return match ? Number(match[1]) * 1024 : null
}

async function measureRemoteDirectorySize(args: {
  connectionId: string
  cwd: string
  path: string
}): Promise<number | null> {
  try {
    const result = await execPackageManagerCommand({
      connectionId: args.connectionId,
      cwd: args.cwd,
      binary: 'du',
      commandArgs: ['-sk', args.path],
      timeoutMs: CACHE_SIZE_TIMEOUT_MS
    })
    return parseDuSizeBytes(result.stdout)
  } catch {
    return null
  }
}

async function measurePackageManagerCache(args: {
  packageManager: WorkspacePackageManager
  connectionId: string | null
  cwd: string
  cachePath?: string | null
}): Promise<CacheSizeSnapshot | null> {
  const cachePath =
    args.cachePath ??
    (await resolveCachePath({
      packageManager: args.packageManager,
      connectionId: args.connectionId,
      cwd: args.cwd
    }))
  if (!cachePath) {
    return null
  }
  const sizeBytes = args.connectionId
    ? await measureRemoteDirectorySize({
        connectionId: args.connectionId,
        cwd: args.cwd,
        path: cachePath
      })
    : await measureLocalDirectorySize(cachePath)
  return { path: cachePath, sizeBytes }
}

async function isPackageManagerCliAvailable(args: {
  packageManager: WorkspacePackageManager
  connectionId: string | null
  cwd: string
  signal?: AbortSignal
}): Promise<boolean> {
  const action = getPackageManagerCacheCleanupActions(args.packageManager)[0]
  if (!action) {
    return false
  }
  try {
    await execPackageManagerCommand({
      ...args,
      binary: action.binary,
      commandArgs: ['--version'],
      timeoutMs: CLI_CHECK_TIMEOUT_MS,
      signal: args.signal
    })
    return true
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    return false
  }
}

export function detectPackageManagersForDirectoryEntries(args: {
  entryNames: readonly string[]
  connectionId: string | null
  isRemote: boolean
  repoDisplayName: string
  worktreeId: string
  worktreePath: string
}): WorkspacePackageManagerDetection[] {
  return [...detectPackageManagersFromFilenames(args.entryNames)].map(
    ([packageManager, lockfiles]) => ({
      packageManager,
      connectionId: args.connectionId,
      isRemote: args.isRemote,
      repoDisplayName: args.repoDisplayName,
      worktreeId: args.worktreeId,
      worktreePath: args.worktreePath,
      lockfiles
    })
  )
}

export async function detectRemotePackageManagers(args: {
  provider: IFilesystemProvider
  connectionId: string
  repoDisplayName: string
  worktreeId: string
  worktreePath: string
}): Promise<WorkspacePackageManagerDetection[]> {
  const entries = await args.provider.readDir(args.worktreePath)
  return detectPackageManagersForDirectoryEntries({
    entryNames: entries.map((entry) => entry.name),
    connectionId: args.connectionId,
    isRemote: true,
    repoDisplayName: args.repoDisplayName,
    worktreeId: args.worktreeId,
    worktreePath: args.worktreePath
  })
}

export async function buildPackageManagerCacheTargets(
  detections: readonly WorkspacePackageManagerDetection[],
  options: { signal?: AbortSignal } = {}
): Promise<WorkspacePackageManagerCacheTarget[]> {
  const perCwdSeeds = new Map<string, PackageManagerTargetSeed>()
  for (const detection of detections) {
    const id = createPackageManagerCacheTargetId(
      detection.connectionId,
      detection.packageManager,
      detection.worktreePath
    )
    const seed =
      perCwdSeeds.get(id) ??
      ({
        packageManager: detection.packageManager,
        connectionId: detection.connectionId,
        isRemote: detection.isRemote,
        repoDisplayNames: new Set<string>(),
        cwd: detection.worktreePath,
        cachePath: null,
        cliAvailable: false,
        lockfiles: new Set<string>(),
        detectedWorktrees: new Map<string, Set<string>>(),
        worktreePaths: new Set<string>()
      } satisfies PackageManagerTargetSeed)
    seed.repoDisplayNames.add(detection.repoDisplayName)
    seed.worktreePaths.add(detection.worktreePath)
    for (const lockfile of detection.lockfiles) {
      seed.lockfiles.add(lockfile)
    }
    const worktreeLockfiles = seed.detectedWorktrees.get(detection.worktreeId) ?? new Set<string>()
    for (const lockfile of detection.lockfiles) {
      worktreeLockfiles.add(lockfile)
    }
    seed.detectedWorktrees.set(detection.worktreeId, worktreeLockfiles)
    perCwdSeeds.set(id, seed)
  }

  const resolvedSeeds = await Promise.all(
    [...perCwdSeeds.values()].map(async (seed) => {
      seed.cliAvailable = await isPackageManagerCliAvailable({
        packageManager: seed.packageManager,
        connectionId: seed.connectionId,
        cwd: seed.cwd,
        signal: options.signal
      })
      seed.cachePath = seed.cliAvailable
        ? await resolveCachePath({
            packageManager: seed.packageManager,
            connectionId: seed.connectionId,
            cwd: seed.cwd,
            signal: options.signal
          })
        : null
      return seed
    })
  )

  const targetSeeds = new Map<string, PackageManagerTargetSeed>()
  for (const seed of resolvedSeeds) {
    const cacheScope = seed.cachePath ? `cache:${seed.cachePath}` : `cwd:${seed.cwd}`
    const key = `${seed.connectionId ?? 'local'}\0${seed.packageManager}\0${cacheScope}`
    const targetSeed =
      targetSeeds.get(key) ??
      ({
        packageManager: seed.packageManager,
        connectionId: seed.connectionId,
        isRemote: seed.isRemote,
        repoDisplayNames: new Set<string>(),
        cwd: seed.cwd,
        cachePath: seed.cachePath,
        cliAvailable: false,
        lockfiles: new Set<string>(),
        detectedWorktrees: new Map<string, Set<string>>(),
        worktreePaths: new Set<string>()
      } satisfies PackageManagerTargetSeed)
    targetSeed.cliAvailable ||= seed.cliAvailable
    for (const repoDisplayName of seed.repoDisplayNames) {
      targetSeed.repoDisplayNames.add(repoDisplayName)
    }
    for (const lockfile of seed.lockfiles) {
      targetSeed.lockfiles.add(lockfile)
    }
    for (const worktreePath of seed.worktreePaths) {
      targetSeed.worktreePaths.add(worktreePath)
    }
    for (const [worktreeId, lockfiles] of seed.detectedWorktrees) {
      const targetLockfiles = targetSeed.detectedWorktrees.get(worktreeId) ?? new Set<string>()
      for (const lockfile of lockfiles) {
        targetLockfiles.add(lockfile)
      }
      targetSeed.detectedWorktrees.set(worktreeId, targetLockfiles)
    }
    targetSeeds.set(key, targetSeed)
  }

  const targets = [...targetSeeds.values()].map((seed) => ({
    id: createPackageManagerCacheTargetId(seed.connectionId, seed.packageManager, seed.cwd),
    packageManager: seed.packageManager,
    connectionId: seed.connectionId,
    isRemote: seed.isRemote,
    targetLabel: createTargetLabel(seed),
    cwd: seed.cwd,
    cachePath: seed.cachePath,
    detectedWorktreeCount: seed.worktreePaths.size,
    detectedWorktrees: toDetectedWorktrees(seed.detectedWorktrees),
    detectedLockfiles: [...seed.lockfiles].sort((a, b) => a.localeCompare(b)),
    cliAvailable: seed.cliAvailable,
    unavailableReason: seed.cliAvailable
      ? null
      : `${getPackageManagerLabel(seed.packageManager)} was detected by lockfile, but its CLI was not available on this target.`,
    cleanupActions: getPackageManagerCacheCleanupActions(seed.packageManager)
  }))

  return targets.sort(
    (a, b) =>
      Number(a.isRemote) - Number(b.isRemote) ||
      a.targetLabel.localeCompare(b.targetLabel) ||
      a.packageManager.localeCompare(b.packageManager)
  )
}

function toDetectedWorktrees(
  detectedWorktrees: Map<string, Set<string>>
): WorkspacePackageManagerCacheTargetWorktree[] {
  return [...detectedWorktrees.entries()]
    .map(([worktreeId, lockfiles]) => ({
      worktreeId,
      lockfiles: [...lockfiles].sort((a, b) => a.localeCompare(b))
    }))
    .sort((a, b) => a.worktreeId.localeCompare(b.worktreeId))
}

export async function runPackageManagerCacheCleanup(
  request: WorkspacePackageManagerCacheCleanupRequest
): Promise<WorkspacePackageManagerCacheCleanupResult> {
  const validated = validateCleanupRequest(request)
  if (!validated.ok) {
    return { ok: false, error: validated.error }
  }
  const { value } = validated
  const action = getPackageManagerCacheCleanupAction(value.packageManager, value.actionId)
  if (!action) {
    return { ok: false, error: 'Unknown package-manager cache cleanup action.' }
  }
  if (
    value.targetId !==
    createPackageManagerCacheTargetId(value.connectionId, value.packageManager, value.cwd)
  ) {
    return { ok: false, error: 'Package-manager cache cleanup target did not match the request.' }
  }
  try {
    const before = await measurePackageManagerCache({
      packageManager: value.packageManager,
      connectionId: value.connectionId,
      cwd: value.cwd
    })
    const result = await execPackageManagerCommand({
      connectionId: value.connectionId,
      cwd: value.cwd,
      binary: action.binary,
      commandArgs: action.args,
      timeoutMs: CLEANUP_TIMEOUT_MS
    })
    const after = before
      ? await measurePackageManagerCache({
          packageManager: value.packageManager,
          connectionId: value.connectionId,
          cwd: value.cwd,
          cachePath: before.path
        })
      : null
    const cacheSizeBeforeBytes = before?.sizeBytes ?? null
    const cacheSizeAfterBytes = after?.sizeBytes ?? null
    const reclaimedBytes =
      cacheSizeBeforeBytes !== null && cacheSizeAfterBytes !== null
        ? Math.max(0, cacheSizeBeforeBytes - cacheSizeAfterBytes)
        : null
    return {
      ok: true,
      action,
      stdout: result.stdout,
      stderr: result.stderr,
      cachePath: before?.path ?? null,
      cacheSizeBeforeBytes,
      cacheSizeAfterBytes,
      reclaimedBytes
    }
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) }
  }
}
