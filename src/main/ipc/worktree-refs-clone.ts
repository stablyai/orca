import { existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  runProcess,
  type ProcessResult,
  type ProcessSpec
} from '../../shared/child-process/run-process'
import { WorktreeLinkedPathTargetExistsError } from './worktree-apfs-clone'

const REFS_CLONE_TIMEOUT_MS = 5 * 60_000
const REFS_PROBE_TIMEOUT_MS = 5_000
const REFS_HELPER_UNAVAILABLE_EXIT_CODE = 2
const REFS_HELPER_TARGET_EXISTS_EXIT_CODE = 3

export type RefsCloneDeps = {
  runProcess: (spec: ProcessSpec) => Promise<ProcessResult>
  resolveHelperPath: () => string | null
}

export type RefsFilesystemCache = Map<string, Promise<boolean>>

export class RefsCloneUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefsCloneUnavailableError'
  }
}

export function resolveRefsCloneHelperPath(): string | null {
  const override = process.env.ORCA_REFS_CLONE_HELPER_PATH
  if (override && existsSync(override)) {
    return override
  }
  const packaged = join(process.resourcesPath ?? '', 'block-clone', 'orca-block-clone.exe')
  const dev = [
    join(process.cwd(), 'native', 'windows-block-clone', '.build', 'orca-block-clone.exe'),
    resolve(__dirname, '../../native/windows-block-clone/.build/orca-block-clone.exe')
  ]
  const candidates = process.resourcesPath ? [packaged, ...dev] : dev
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}

export const defaultRefsCloneDeps: RefsCloneDeps = {
  runProcess,
  resolveHelperPath: resolveRefsCloneHelperPath
}

async function cacheKey(source: string, targetDirectory: string): Promise<string> {
  const [sourceStats, targetStats] = await Promise.all([stat(source), stat(targetDirectory)])
  return `${String(sourceStats.dev)}\0${String(targetStats.dev)}`
}

async function runRefsHelper(
  command: 'probe' | 'clone',
  source: string,
  target: string,
  deps: RefsCloneDeps
): Promise<ProcessResult> {
  const helperPath = deps.resolveHelperPath()
  if (!helperPath) {
    throw new RefsCloneUnavailableError('The packaged ReFS block-clone helper is unavailable')
  }
  return await deps.runProcess({
    program: helperPath,
    args: [command, source, target],
    timeoutMs: command === 'probe' ? REFS_PROBE_TIMEOUT_MS : REFS_CLONE_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024
  })
}

function helperFailure(result: ProcessResult): string {
  if (result.timedOut) {
    return 'ReFS block-clone helper timed out'
  }
  return result.stderr.trim() || `ReFS block-clone helper exited ${String(result.code)}`
}

export async function canCloneWithRefs(
  source: string,
  targetDirectory: string,
  deps: RefsCloneDeps = defaultRefsCloneDeps,
  filesystemCache: RefsFilesystemCache = new Map()
): Promise<boolean> {
  let key: string
  try {
    key = await cacheKey(source, targetDirectory)
  } catch {
    return false
  }
  const cached = filesystemCache.get(key)
  if (cached) {
    return await cached
  }
  const pending = runRefsHelper('probe', source, targetDirectory, deps)
    .then((result) => result.code === 0 && !result.timedOut)
    .catch(() => false)
  filesystemCache.set(key, pending)
  return await pending
}

export async function cloneWorktreePathWithRefs(
  source: string,
  target: string,
  _sourceIsDirectory: boolean,
  deps: RefsCloneDeps = defaultRefsCloneDeps
): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const result = await runRefsHelper('clone', source, target, deps)
  if (result.code === 0 && !result.timedOut) {
    return
  }
  if (result.code === REFS_HELPER_TARGET_EXISTS_EXIT_CODE) {
    throw new WorktreeLinkedPathTargetExistsError(target)
  }
  if (result.code === REFS_HELPER_UNAVAILABLE_EXIT_CODE) {
    throw new RefsCloneUnavailableError(helperFailure(result))
  }
  throw new Error(helperFailure(result))
}
