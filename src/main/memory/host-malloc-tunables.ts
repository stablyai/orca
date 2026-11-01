/**
 * glibc keeps the ~70 MB V8 frees after compiling orcad's bundle stranded in its main arena; serving
 * allocations of 16 KB and up from mmap returns them (WSL host orcad 232 -> 192 MB, daemon 79 -> 71 MB
 * at idle, flood throughput unchanged). glibc reads GLIBC_TUNABLES only at exec, so the launch sets it
 * and each host process removes it at once: shells, agents and git must keep the user's malloc.
 */
import type { OrcadLaunchEnvEntry } from '../ssh/orcad-host-transport'

export const HOST_MALLOC_TUNABLES = 'glibc.malloc.mmap_threshold=16384'
const GLIBC_TUNABLES = 'GLIBC_TUNABLES'
/** Says the launch, not the user, set GLIBC_TUNABLES; nothing else may be removed. */
const HOST_MALLOC_TUNABLES_ENV = 'ORCA_HOST_MALLOC_TUNABLES'

let claimed: string | null = null

/** A GLIBC_TUNABLES the user already set (e.g. via WSLENV) wins; the claim then leaves it alone. */
export function hostMallocTunablesLaunchEnv(): OrcadLaunchEnvEntry[] {
  return [
    [GLIBC_TUNABLES, HOST_MALLOC_TUNABLES, 'keep-existing'],
    [HOST_MALLOC_TUNABLES_ENV, HOST_MALLOC_TUNABLES]
  ]
}

/** Run before this process starts any child. */
export function claimHostMallocTunables(env: NodeJS.ProcessEnv = process.env): void {
  const value = env[HOST_MALLOC_TUNABLES_ENV]
  if (value === undefined) {
    return
  }
  delete env[HOST_MALLOC_TUNABLES_ENV]
  if (env[GLIBC_TUNABLES] === value) {
    delete env[GLIBC_TUNABLES]
    claimed = value
  }
}

/** Only the daemon, another host process, inherits what this one claimed. */
export function hostMallocTunablesDaemonEnv(): Record<string, string> {
  return claimed === null ? {} : { [GLIBC_TUNABLES]: claimed, [HOST_MALLOC_TUNABLES_ENV]: claimed }
}

export function resetHostMallocTunablesForTests(): void {
  claimed = null
}
