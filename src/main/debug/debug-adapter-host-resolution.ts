import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'
import type { Store } from '../persistence'
import {
  LocalDebugAdapterProcessHost,
  type DebugAdapterProcessHost
} from './debug-adapter-process-host'
import { SshDebugAdapterProcessHost, type GetSshConnection } from './ssh-debug-adapter-process-host'

export type { GetSshConnection } from './ssh-debug-adapter-process-host'

/**
 * Picks which `DebugAdapterProcessHost` spawns the adapter for a given
 * worktree — SSH when the worktree's repo is on a remote connection,
 * otherwise local, with a `wsl.exe` wrap when
 * `resolveLocalProjectRuntimeForWorktreeId` resolves the worktree's project
 * runtime to `kind: 'wsl'`. Mirrors the connectionId branch PTY spawn uses
 * (`getProvider` in `src/main/ipc/pty.ts`).
 */
export function resolveDebugAdapterProcessHost(args: {
  worktreeId: string
  connectionId?: string | null
  store?: Store
  getSshConnection: GetSshConnection
}): { host: DebugAdapterProcessHost; hostId: ExecutionHostId } {
  if (args.connectionId) {
    return {
      host: new SshDebugAdapterProcessHost(args.connectionId, args.getSshConnection),
      hostId: toSshExecutionHostId(args.connectionId)
    }
  }
  const resolution = resolveLocalProjectRuntimeForWorktreeId(args.store, args.worktreeId)
  const wslDistro =
    resolution?.status === 'resolved' && resolution.runtime.kind === 'wsl'
      ? resolution.runtime.distro
      : undefined
  return {
    host: new LocalDebugAdapterProcessHost(wslDistro),
    hostId: LOCAL_EXECUTION_HOST_ID
  }
}
