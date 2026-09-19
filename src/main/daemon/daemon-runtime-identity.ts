import { canUseBunPty } from './pty-subprocess/bun-pty-process-capabilities'
import type { BunRuntime } from './pty-subprocess/bun-pty-process-contract'

export type DaemonRuntimeKind = 'node' | 'bun'
export type DaemonPtyBackend = 'node-pty' | 'bun-terminal'

export type DaemonRuntimeIdentity = {
  runtimeKind: DaemonRuntimeKind
  runtimeVersion?: string
  ptyBackend: DaemonPtyBackend
}

type RuntimeVersions = typeof process.versions & { bun?: string }

/** Reports the runtime and PTY backend from inside the daemon process itself. */
export function readDaemonRuntimeIdentity(
  runtime: BunRuntime | undefined = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun,
  versions: RuntimeVersions = process.versions
): DaemonRuntimeIdentity {
  const bunVersion =
    typeof versions.bun === 'string' && versions.bun.length > 0 ? versions.bun : undefined
  return {
    runtimeKind: bunVersion ? 'bun' : 'node',
    ...(bunVersion ? { runtimeVersion: bunVersion } : {}),
    ptyBackend: canUseBunPty(runtime) ? 'bun-terminal' : 'node-pty'
  }
}
