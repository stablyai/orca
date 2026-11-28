import { lstatSync, readlinkSync, realpath as realpathCallback, realpathSync } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'
import { promisify } from 'node:util'
import { basename, dirname, join, resolve } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import {
  observeResolvedFilePath,
  observeResolvedFilePathError
} from '../../../filesystem/file-content-observation'

type FsStep = { op: 'realpath' | 'lstat' | 'readlink'; path: string }
type FsStepResult = string | { isSymbolicLink(): boolean }
type ResolutionSteps = Generator<FsStep, { path: string }, FsStepResult>

/** Follow dotfile-manager symlinks, including dangling links realpath cannot resolve. */
export function resolvePromotionWriteTarget(systemTomlPath: string): { path: string } {
  const steps = resolveWriteTargetSteps(systemTomlPath)
  let step = steps.next()
  while (!step.done) {
    let result: FsStepResult
    try {
      const { op, path } = step.value
      result =
        op === 'realpath'
          ? realpathSync(path)
          : op === 'lstat'
            ? lstatSync(path)
            : readlinkSync(path)
    } catch (error) {
      step = steps.throw(error)
      continue
    }
    step = steps.next(result)
  }
  return step.value
}

// The JS realpath, like realpathSync: the native one fails on some Windows volumes the sync path resolves.
const realpath = promisify(realpathCallback)

/** The same resolution off the main thread's critical path, for checks that need not block a pass. */
export async function resolvePromotionWriteTargetAsync(
  systemTomlPath: string
): Promise<{ path: string }> {
  const steps = resolveWriteTargetSteps(systemTomlPath)
  let step = steps.next()
  while (!step.done) {
    let result: FsStepResult
    try {
      const { op, path } = step.value
      result =
        op === 'realpath'
          ? await realpath(path)
          : op === 'lstat'
            ? await lstat(path)
            : await readlink(path)
    } catch (error) {
      step = steps.throw(error)
      continue
    }
    step = steps.next(result)
  }
  return step.value
}

function* resolveWriteTargetSteps(systemTomlPath: string): ResolutionSteps {
  try {
    const realPath = yield* fsString({ op: 'realpath', path: systemTomlPath })
    return { path: observeResolvedFilePath('promotion-write', systemTomlPath, realPath) }
  } catch (error) {
    observeResolvedFilePathError('promotion-write', systemTomlPath, error)
    // Continue below: realpath also fails for a valid dangling dotfile link.
  }
  let targetPath = systemTomlPath
  try {
    if (yield* isSymbolicLink(systemTomlPath)) {
      targetPath = yield* resolveDanglingSymlinkTarget(systemTomlPath)
    }
  } catch (error) {
    observeResolvedFilePathError('promotion-write', systemTomlPath, error)
    // Missing non-link targets are created owner-only where the requested path resolves.
  }
  return {
    path: observeResolvedFilePath(
      'promotion-write',
      systemTomlPath,
      yield* resolveThroughLinkedAncestor(targetPath)
    )
  }
}

function* fsString(step: FsStep): Generator<FsStep, string, FsStepResult> {
  const result = yield step
  if (typeof result !== 'string') {
    throw new Error(`Unexpected ${step.op} result for ${step.path}`)
  }
  return result
}

function* isSymbolicLink(path: string): Generator<FsStep, boolean, FsStepResult> {
  const result = yield { op: 'lstat', path }
  return typeof result !== 'string' && result.isSymbolicLink()
}

/** The nearest existing folder decides where a new file lands, e.g. a host ~/.codex linked into WSL. */
function* resolveThroughLinkedAncestor(path: string): Generator<FsStep, string, FsStepResult> {
  const missing = [basename(path)]
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      return join(yield* fsString({ op: 'realpath', path: dir }), ...missing)
    } catch (error) {
      observeResolvedFilePathError('promotion-write', path, error)
      // An unresolvable folder could still link into a distro; stall rather than write through it.
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
      if (dirname(dir) === dir) {
        return path
      }
      missing.unshift(basename(dir))
    }
  }
}

function* resolveDanglingSymlinkTarget(linkPath: string): Generator<FsStep, string, FsStepResult> {
  let currentPath = linkPath
  const visited = new Set<string>()
  while (!visited.has(currentPath)) {
    visited.add(currentPath)
    try {
      if (!(yield* isSymbolicLink(currentPath))) {
        return currentPath
      }
      currentPath = resolve(
        dirname(currentPath),
        yield* fsString({ op: 'readlink', path: currentPath })
      )
    } catch (error) {
      observeResolvedFilePathError('promotion-write', linkPath, error)
      return currentPath
    }
  }
  // Abort rather than overwrite a link in the dotfile-manager cycle.
  throw new Error(`Codex config symlink cycle at ${linkPath}`)
}
