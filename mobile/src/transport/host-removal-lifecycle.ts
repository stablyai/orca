import { removeHost } from './host-store'

export async function removeHostAndCloseClient(
  hostId: string,
  closeHostClient: (hostId: string) => void
): Promise<void> {
  // Why: closing before the metadata commit can strand a still-paired host on
  // storage failure; closing immediately after success prevents socket leaks.
  await removeHost(hostId)
  closeHostClient(hostId)
}
