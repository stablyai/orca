import path from 'node:path'
import process from 'node:process'
import type { RelayRuntimeKind } from '../shared/relay-runtime-self-test-report'

const RUNTIME_DIR_PATTERN = /^node-[0-9a-f]{64}$/

/**
 * Which runtime is executing this relay: Orca's pinned Node lives at
 * `runtimes/node-<sha256>/bin/node`, or `runtimes\node-<sha256>\node.exe` on Windows
 * (design D5); any other path is a host Node.
 */
export function describeRelayRuntime(
  execPath: string = process.execPath,
  paths: Pick<typeof path, 'basename' | 'dirname'> = path
): {
  kind: RelayRuntimeKind
  version: string
} {
  const { basename, dirname } = paths
  const inStore = (runtimeDir: string): boolean =>
    RUNTIME_DIR_PATTERN.test(basename(runtimeDir)) && basename(dirname(runtimeDir)) === 'runtimes'
  const posix = basename(dirname(execPath)) === 'bin' && inStore(dirname(dirname(execPath)))
  const windows = basename(execPath).toLowerCase() === 'node.exe' && inStore(dirname(execPath))
  return {
    kind: posix || windows ? 'pinned-node' : 'host-node',
    version: process.versions.node
  }
}
