import { parseWorktreeList } from '../../../shared/git-worktree-porcelain-parser'
import { areWorktreePathsEqual } from '../../git/worktree-path-comparison'
import { mkdir, open, rename, lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { tryAcquireConditionalWorktreeRemoval } from '../../ipc/conditional-worktree-removal-lease'
import { tryAcquireIdleWatcherRemovalGate } from '../../ipc/watcher-removal-gate'
import type {
  ConditionalWorktreeRemovalRequest,
  ConditionalWorktreeRemovalResult,
  ConditionalRemovalRefusal
} from '../../../shared/rpc-contract/conditional-worktree-removal'
import {
  conditionalGit,
  verifyConditionalGitIdentity,
  verifyConditionalGitClean,
  removeConditionalGitCheckout
} from './conditional-worktree-removal-git'

export type ConditionalWorktreeRemovalDependencies = {
  profileDirectory: string
  repoPath: string
  /** The adapter must prove every ingress participates before advertising support. */
  supported: boolean
  verifyOccupant: () => Promise<'same' | 'absent' | 'changed'>
  verifyIdle: (signal: AbortSignal) => Promise<'idle' | 'live' | 'unknown'>
  finishMetadata: () => Promise<void>
}

function refused(
  reason: ConditionalRemovalRefusal,
  detail = reason
): ConditionalWorktreeRemovalResult {
  return { status: 'refused', reason, detail }
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined
}

async function readBoundedReceipt(path: string): Promise<unknown> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) {
    throw new Error('receipt_unreadable')
  }
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(65537)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 65536) {
      throw new Error('receipt_unreadable')
    }
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await file.close()
  }
}

async function writeReceiptExclusive(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value))
    await file.sync()
  } finally {
    await file.close()
  }
}

async function syncReceiptDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function writeRemovedReceipt(
  receiptPath: string,
  directory: string,
  fingerprint: string,
  request: ConditionalWorktreeRemovalRequest,
  retainedRef: string
): Promise<void> {
  const temporaryPath = `${receiptPath}.${randomUUID()}.complete`
  try {
    await writeReceiptExclusive(temporaryPath, {
      phase: 'removed',
      fingerprint,
      request,
      retainedRef
    })
    await rename(temporaryPath, receiptPath)
    await syncReceiptDirectory(directory)
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

async function boundedIdle(
  deps: ConditionalWorktreeRemovalDependencies
): Promise<'idle' | 'live' | 'unknown'> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      deps.verifyIdle(controller.signal).catch(() => 'unknown' as const),
      new Promise<'unknown'>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve('unknown')
        }, 5000)
      })
    ])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

async function conditionalGitRemovalReadback(
  request: ConditionalWorktreeRemovalRequest,
  deps: ConditionalWorktreeRemovalDependencies,
  retainedRef: string
): Promise<boolean> {
  const expected = request.expected
  try {
    try {
      await lstat(expected.checkout.path)
      return false
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        return false
      }
    }
    if (
      (await conditionalGit(deps.repoPath, ['rev-parse', '--verify', retainedRef])) !==
        expected.head ||
      (await conditionalGit(deps.repoPath, ['rev-parse', '--verify', expected.branch])) !==
        expected.head
    ) {
      return false
    }
    const listed = await conditionalGit(deps.repoPath, ['worktree', 'list', '--porcelain'])
    if (
      parseWorktreeList(listed).some((worktree) =>
        areWorktreePathsEqual(worktree.path, expected.checkout.path)
      )
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
}

async function conditionalRemovalReadback(
  request: ConditionalWorktreeRemovalRequest,
  deps: ConditionalWorktreeRemovalDependencies,
  retainedRef: string
): Promise<boolean> {
  return (await conditionalGitRemovalReadback(request, deps, retainedRef)) &&
    (await deps.verifyOccupant()) === 'absent'
}

export async function removeConditionalWorktree(
  request: ConditionalWorktreeRemovalRequest,
  deps: ConditionalWorktreeRemovalDependencies
): Promise<ConditionalWorktreeRemovalResult> {
  if (!deps.supported || request.expected.executionHostId !== 'local') {
    return refused('unsupported')
  }
  const lease = tryAcquireConditionalWorktreeRemoval(request.expected.checkout.path)
  if (lease.kind !== 'acquired') {
    return refused('busy')
  }
  const watcher = tryAcquireIdleWatcherRemovalGate(request.expected.checkout.path)
  if (watcher.kind !== 'acquired') {
    lease.release()
    return refused('busy')
  }
  const expected = request.expected
  const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
  const retainedRef = `refs/orca-retained-worktrees/${request.requestId}`
  const result: ConditionalWorktreeRemovalResult = {
    status: 'removed',
    requestId: request.requestId,
    expected,
    retainedRef
  }
  const directory = join(deps.profileDirectory, 'conditional-worktree-removals')
  const receiptPath = join(directory, `${request.requestId}.json`)
  let prepared = false
  try {
    let prior: unknown
    try {
      prior = await readBoundedReceipt(receiptPath)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        return refused('outcome_unknown')
      }
    }
    if (prior !== undefined) {
      if (
        !prior ||
        typeof prior !== 'object' ||
        !('fingerprint' in prior) ||
        prior.fingerprint !== fingerprint ||
        !('phase' in prior) ||
        !['prepared', 'removed'].includes(String(prior.phase)) ||
        !('request' in prior) ||
        JSON.stringify(prior.request) !== JSON.stringify(request) ||
        !('retainedRef' in prior) ||
        prior.retainedRef !== retainedRef
      ) {
        return refused('identity_changed')
      }
      // A retry must never delete a surviving or replacement checkout.
      if (prior.phase === 'prepared') {
        if (!(await conditionalGitRemovalReadback(request, deps, retainedRef))) {
          return refused('outcome_unknown')
        }
        const occupant = await deps.verifyOccupant()
        if (occupant === 'changed') {
          return refused('identity_changed')
        }
        if (occupant === 'same') {
          await deps.finishMetadata()
        }
        if (!(await conditionalRemovalReadback(request, deps, retainedRef))) {
          return refused('outcome_unknown')
        }
        await writeRemovedReceipt(receiptPath, directory, fingerprint, request, retainedRef)
      } else if (!(await conditionalRemovalReadback(request, deps, retainedRef))) {
        return refused('outcome_unknown')
      }
      return result
    }
    if ((await deps.verifyOccupant()) !== 'same') {
      return refused('identity_changed')
    }
    const idle = await boundedIdle(deps)
    if (idle !== 'idle') {
      return refused(idle === 'live' ? 'session_live' : 'session_unknown')
    }
    await verifyConditionalGitIdentity(deps.repoPath, expected)
    await verifyConditionalGitClean(expected)
    if ((await deps.verifyOccupant()) !== 'same') {
      return refused('identity_changed')
    }
    const worktree = await verifyConditionalGitIdentity(deps.repoPath, expected)
    if ((await boundedIdle(deps)) !== 'idle') {
      return refused('session_unknown')
    }
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeReceiptExclusive(receiptPath, {
      phase: 'prepared',
      fingerprint,
      request,
      retainedRef
    })
    prepared = true
    await syncReceiptDirectory(directory)
    await syncReceiptDirectory(deps.profileDirectory)
    await conditionalGit(
      deps.repoPath,
      ['update-ref', retainedRef, expected.head, '0'.repeat(expected.head.length)],
      lease.token
    )
    await removeConditionalGitCheckout(deps.repoPath, expected, worktree, lease.token)
    await deps.finishMetadata()
    if (!(await conditionalRemovalReadback(request, deps, retainedRef))) {
      return refused('outcome_unknown')
    }
    await writeRemovedReceipt(receiptPath, directory, fingerprint, request, retainedRef)
    return result
  } catch (error) {
    if (prepared) {
      return refused('outcome_unknown')
    }
    const reason = error instanceof Error ? error.message : ''
    if (
      reason === 'identity_changed' ||
      reason === 'git_not_clean' ||
      reason === 'git_operation_pending'
    ) {
      return refused(reason)
    }
    return refused('session_unknown')
  } finally {
    watcher.gate.release()
    lease.release()
  }
}
