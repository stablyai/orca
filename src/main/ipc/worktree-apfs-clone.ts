import { randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { access, chmod, lstat, mkdir, mkdtemp, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { runWorktreeCloneProcess } from './worktree-clone-process'
import { removeWorktreeCloneStaging } from './worktree-clone-staging'
import {
  WorktreeCloneUnavailableError,
  WorktreeCloneInterruptedError,
  WorktreeLinkedPathTargetExistsError
} from './worktree-clone-copy-errors'

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number }
) => Promise<{ stdout: string; stderr: string }>

export type ApfsCloneDeps = {
  execFileAsync: ExecFileAsync
  randomUUID: () => string
}

async function resolveHelper(): Promise<string> {
  const relative = 'native/workspace-cow-macos/.build/release/orca-workspace-cow'
  const candidates = [join(dirname(process.execPath), 'orca-workspace-cow')]
  const relayHelper = join(__dirname, 'orca-workspace-cow')
  candidates.push(relayHelper)
  if (!process.resourcesPath) {
    candidates.push(
      resolve(__dirname, '../../', relative),
      resolve(__dirname, '../../../', relative)
    )
  }
  const helper = candidates.find((candidate) => existsSync(candidate))
  if (!helper) {
    throw new WorktreeCloneUnavailableError('Native APFS clone helper is unavailable')
  }
  if (helper === relayHelper) {
    // Raw relay uploads may create artifacts without their executable permission.
    await access(helper, constants.X_OK).catch(() => chmod(helper, 0o755))
  }
  return helper
}

export const defaultApfsCloneDeps: ApfsCloneDeps = {
  randomUUID,
  execFileAsync: async (_file, args, options) => {
    const result = await runWorktreeCloneProcess({
      program: await resolveHelper(),
      args,
      timeoutMs: options?.timeout ?? null
    })
    if (result.code !== 0) {
      if (result.stderr.trim() === '{"errno":17}') {
        throw new WorktreeLinkedPathTargetExistsError(args[2] ?? '')
      }
      throw new Error(`Native APFS ${args[0]} failed: ${result.stderr.trim()}`)
    }
    return { stdout: result.stdout, stderr: result.stderr }
  }
}

export type DarwinFilesystemCache = Map<string, Promise<boolean>>
export class ApfsCloneUnavailableError extends WorktreeCloneUnavailableError {}

export async function canCloneWithApfs(
  source: string,
  targetDirectory: string,
  deps: ApfsCloneDeps = defaultApfsCloneDeps,
  filesystemCache: DarwinFilesystemCache = new Map()
): Promise<boolean> {
  try {
    const [from, to] = await Promise.all([stat(source), stat(targetDirectory)])
    const key = `${from.dev}:${to.dev}`
    let pending = filesystemCache.get(key)
    if (!pending) {
      pending = deps
        .execFileAsync('orca-workspace-cow', ['probe', source, targetDirectory], {
          timeout: 5000
        })
        .then(
          () => true,
          () => false
        )
      filesystemCache.set(key, pending)
    }
    return await pending
  } catch {
    return false
  }
}

export async function cloneWorktreePathWithApfs(
  source: string,
  target: string,
  _sourceIsDirectory: boolean,
  deps: ApfsCloneDeps = defaultApfsCloneDeps,
  filesystemCache: DarwinFilesystemCache = new Map()
): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  if (!(await canCloneWithApfs(source, dirname(target), deps, filesystemCache))) {
    throw new ApfsCloneUnavailableError(
      'Native APFS cloning is unavailable for this filesystem pair'
    )
  }
  try {
    await lstat(target)
    throw new WorktreeLinkedPathTargetExistsError(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  const staging = await mkdtemp(join(dirname(target), '.orca-apfs-stage-'))
  let cleanupAllowed = true
  try {
    const content = join(staging, 'content')
    await deps.execFileAsync('orca-workspace-cow', ['clone', source, content])
    await deps.execFileAsync('orca-workspace-cow', ['publish', content, target])
  } catch (error) {
    cleanupAllowed = !(
      error instanceof WorktreeCloneInterruptedError && error.termination === 'unverifiable'
    )
    throw error
  } finally {
    if (cleanupAllowed) {
      await removeWorktreeCloneStaging(staging)
    }
  }
}
