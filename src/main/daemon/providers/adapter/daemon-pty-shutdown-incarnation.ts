import type { IPtyProvider } from '../../../providers/pty-provider-contract'

export function assertDaemonShutdownIncarnation(
  current: string | undefined,
  opts: Parameters<IPtyProvider['shutdown']>[1],
  allowAbsent = false
): void {
  opts.assertCurrent?.(allowAbsent)
  if (opts.expectedIncarnationId && current && current !== opts.expectedIncarnationId) {
    throw new Error('Terminal was replaced before shutdown')
  }
}
