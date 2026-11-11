import type { ExecutionHostId } from '../../../src/shared/execution-host'

// `exec` is always set: workspace ids collide across servers, as in composeWorktreeHostIdentity.
export type HostQueryTarget = { exec: ExecutionHostId; worktree?: string; repo?: string }

export type HostQueryParams = Readonly<Record<string, string | number | boolean | null>>

export type HostQueryKey = readonly [
  'orca',
  hostId: string,
  family: string,
  target: HostQueryTarget,
  params: HostQueryParams
]

export function hostQueryKey(
  hostId: string,
  family: string,
  target: HostQueryTarget,
  params: HostQueryParams
): HostQueryKey {
  return ['orca', hostId, family, target, params]
}

// Prefix of every query one paired host owns; TanStack matches keys by prefix.
export function hostScopeKey(hostId: string): readonly ['orca', string] {
  return ['orca', hostId]
}
