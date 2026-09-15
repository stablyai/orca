import { isAbsolute } from 'node:path'
import { runProcess } from '../shared/child-process/run-process'
import { materializeRelayWorktreePaths } from './worktree-path-materialization'
import { resolveRelayRemovableSharedLinks } from './worktree-shared-link-removal'
import { removeWorktreeLinkedPaths } from '../main/ipc/worktree-symlinks'
import type { GitExec } from './git-handler-ops'

const git: GitExec = async (args, cwd) => {
  const result = await runProcess({
    program: 'git',
    args,
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: 8 * 1024 * 1024
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('Guest Git inspection failed; workspace paths were not removed')
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

export async function executeWslWorktreePathOperation(request: Record<string, unknown>) {
  if (request.operation === undefined) {
    return materializeRelayWorktreePaths(request)
  }
  if (
    (request.operation !== 'inspect-links' && request.operation !== 'remove-links') ||
    typeof request.target !== 'string' ||
    !isAbsolute(request.target)
  ) {
    throw new Error('Invalid WSL workspace path operation')
  }
  const paths = await resolveRelayRemovableSharedLinks(git, request.target, {
    source: request.source,
    paths: request.linkedPaths
  })
  if (request.operation === 'remove-links') {
    await removeWorktreeLinkedPaths(request.target, paths)
  }
  return { supported: true, paths }
}
