import { GIT_REMOTE_OPERATION_RPC_TIMEOUT_MS } from '../../../src/shared/git-remote-operation-timeout'

const REMOTE_GIT_METHODS = new Set([
  'git.fetch',
  'git.forkSync',
  'git.push',
  'git.pull',
  'git.fastForward',
  'git.rebaseFromBase'
])

export function mobileGitRequestOptions(method: string): { timeoutMs: number } | undefined {
  return REMOTE_GIT_METHODS.has(method)
    ? { timeoutMs: GIT_REMOTE_OPERATION_RPC_TIMEOUT_MS }
    : undefined
}
