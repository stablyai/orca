import { GIT_REMOTE_OPERATION_RPC_TIMEOUT_MS } from '../../../src/shared/git-remote-operation-timeout'

const REMOTE_GIT_METHODS = new Set([
  'git.fetch',
  'git.forkSync',
  'git.push',
  'git.pull',
  'git.fastForward',
  'git.rebaseFromBase'
])

export function isMobileRemoteGitMethod(method: string): boolean {
  return REMOTE_GIT_METHODS.has(method)
}

export function mobileGitRequestOptions(
  method: string,
  timeoutMs = GIT_REMOTE_OPERATION_RPC_TIMEOUT_MS
): { timeoutMs: number } | undefined {
  return isMobileRemoteGitMethod(method) ? { timeoutMs } : undefined
}
