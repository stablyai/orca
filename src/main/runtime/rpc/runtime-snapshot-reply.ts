import {
  compressRuntimeSnapshotResponse,
  RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY
} from '../../../shared/remote-runtime-snapshot-compression'
import type { RuntimeCapability } from '../../../shared/protocol-version'

export function createRuntimeSnapshotReply(
  method: string,
  clientKind: 'runtime' | 'mobile',
  clientCapabilities: readonly RuntimeCapability[] | undefined,
  reply: (response: string) => void
): (response: string) => void {
  if (
    clientKind !== 'runtime' ||
    !clientCapabilities?.includes(RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY) ||
    (method !== 'session.tabs.subscribe' && method !== 'session.tabs.subscribeAll')
  ) {
    return reply
  }
  return (response) => reply(compressRuntimeSnapshotResponse(response))
}
