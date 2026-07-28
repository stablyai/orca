import {
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../shared/execution-host'
import { RuntimeClientError } from './runtime-client'

/**
 * Resolve `orca repo add --host` to an ExecutionHostId.
 * Accepts canonical ids (`local`, `ssh:…`, `runtime:…`) and bare SSH connectionIds
 * (as shown on existing repos) by prefixing `ssh:`.
 */
export function resolveRepoAddHostId(rawHost: string): ExecutionHostId {
  const trimmed = rawHost.trim()
  const normalized = normalizeExecutionHostId(trimmed)
  if (normalized) {
    return normalized
  }
  // Why: repo list / connectionId fields omit the ssh: prefix; agents often paste that bare id.
  if (trimmed.length > 0 && !trimmed.includes(':')) {
    const asSsh = toSshExecutionHostId(trimmed)
    if (normalizeExecutionHostId(asSsh)) {
      return asSsh
    }
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `Invalid --host ${trimmed}. Use local, ssh:<connectionId>, or runtime:<environmentId>. Note: --environment selects a paired Orca server, not an SSH connectionId.`
  )
}

export function isNonLocalRepoAddHost(hostId: ExecutionHostId): boolean {
  return hostId !== 'local'
}
