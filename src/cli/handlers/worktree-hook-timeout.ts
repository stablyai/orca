import { getOptionalPositiveIntegerFlag } from '../flags'

// Why: --timeout is authored in seconds (ergonomic) but the RPC/runtime speak
// milliseconds, so convert at the CLI boundary. The runtime emits keepalives for
// worktree.rm, so the client socket does not need its own widened timeout.
export function getHookTimeoutMs(flags: Map<string, string | boolean>): number | undefined {
  const seconds = getOptionalPositiveIntegerFlag(flags, 'timeout')
  return seconds !== undefined ? seconds * 1000 : undefined
}
