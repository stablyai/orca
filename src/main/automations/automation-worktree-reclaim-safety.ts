import { gitExecFileAsync } from '../git/runner'
import {
  resolveGitRouteForHost,
  type ExecutionHostGitRoute
} from '../providers/execution-host-provider-dispatch'
import type { WorktreeReclaimSafety } from '../../shared/automation-worktree-retention'

type GitExec = (
  argv: string[],
  cwd: string,
  localOptions?: { wslDistro?: string }
) => Promise<{ stdout: string }>

function oneCommit(stdout: string): string | null {
  const oid = stdout.trim()
  return /^[0-9a-f]{7,64}$/i.test(oid) ? oid : null
}

/**
 * Positive evidence only. A missing SSH provider, a runtime host this process
 * does not execute, or any git error is unverifiable — never "clean enough to delete".
 */
export async function inspectAutomationWorktreeGitSafety(args: {
  hostId: string | undefined
  cwd: string
  baseRef: string | null
  isMainWorktree: boolean
  localGitOptions?: { wslDistro?: string }
  resolveRoute?: (hostId: string | null | undefined) => ExecutionHostGitRoute
  execLocal?: GitExec
  execSsh?: GitExec
}): Promise<WorktreeReclaimSafety> {
  if (args.isMainWorktree) {
    return 'keep'
  }
  const baseRef = args.baseRef?.trim()
  if (!args.hostId || !args.cwd || !baseRef) {
    return 'unverifiable'
  }
  let route: ExecutionHostGitRoute
  try {
    route = (args.resolveRoute ?? resolveGitRouteForHost)(args.hostId)
  } catch {
    return 'unverifiable'
  }
  if (route.kind === 'runtime') {
    return 'unverifiable'
  }
  const sshProvider = route.kind === 'ssh' ? route.provider : null
  if (route.kind === 'ssh' && !sshProvider && !args.execSsh) {
    return 'unverifiable'
  }
  const exec = (argv: string[]): Promise<{ stdout: string }> => {
    if (route.kind === 'local') {
      if (args.execLocal) {
        return args.execLocal(argv, args.cwd, args.localGitOptions)
      }
      return gitExecFileAsync(argv, { cwd: args.cwd, ...args.localGitOptions })
    }
    if (args.execSsh) {
      return args.execSsh(argv, args.cwd)
    }
    if (!sshProvider) {
      return Promise.reject(new Error('ssh git provider unavailable'))
    }
    return sshProvider.exec(argv, args.cwd)
  }
  try {
    const status = await exec(['status', '--porcelain', '-z'])
    if (status.stdout.length > 0) {
      return 'keep'
    }
    const head = oneCommit((await exec(['rev-parse', '--verify', 'HEAD'])).stdout)
    const base = oneCommit((await exec(['rev-parse', '--verify', `${baseRef}^{commit}`])).stdout)
    if (!head || !base) {
      return 'unverifiable'
    }
    return head === base ? 'reclaimable' : 'keep'
  } catch {
    return 'unverifiable'
  }
}
