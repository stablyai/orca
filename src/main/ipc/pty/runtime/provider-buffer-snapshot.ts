import type { PtyProviderBufferSnapshotOptions } from '../../../providers/pty/provider-contract'
import { getProviderForPty } from '../provider/registry'

export async function serializeProviderBufferFromRuntimeController(
  ptyId: string,
  opts?: PtyProviderBufferSnapshotOptions
) {
  try {
    // Unmounted restored daemon PTYs still need provider snapshots for phone navigation.
    return (await getProviderForPty(ptyId).getBufferSnapshot?.(ptyId, opts)) ?? null
  } catch {
    return null
  }
}

export function supportsVisibleProjectionSnapshotFromRuntimeController(ptyId: string): boolean {
  try {
    return getProviderForPty(ptyId).supportsVisibleProjectionSnapshot?.(ptyId) === true
  } catch {
    return false
  }
}
