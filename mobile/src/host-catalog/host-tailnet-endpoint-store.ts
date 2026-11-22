import { MobileTailnetEndpointSchema } from '../../../src/shared/remote-runtime/pairing/mobile-tailnet-endpoint'
import { MobileLanEndpointSchema } from '../../../src/shared/remote-runtime/pairing/mobile-lan-endpoint'
import { mutateStoredHosts } from './host-list-mutation-queue'

// Keep the manual endpoint authoritative; old in-flight replies cannot replace a later user edit.
export async function recordHostTailnetEndpoint(
  hostId: string,
  primaryEndpoint: string,
  tailnetEndpoint: string
): Promise<void> {
  const validated = MobileTailnetEndpointSchema.parse(tailnetEndpoint)
  await mutateStoredHosts((hosts) => {
    const index = hosts.findIndex(
      (host) =>
        host.id === hostId &&
        host.endpoint === primaryEndpoint &&
        host.tailnetEndpoint !== validated
    )
    if (index === -1) {
      return hosts
    }
    const next = [...hosts]
    next[index] = { ...hosts[index]!, tailnetEndpoint: validated }
    return next
  })
}

export async function recordHostLanEndpoint(
  hostId: string,
  primaryEndpoint: string,
  lanEndpoint: string
): Promise<void> {
  const validated = MobileLanEndpointSchema.parse(lanEndpoint)
  await mutateStoredHosts((hosts) => {
    const index = hosts.findIndex(
      (host) =>
        host.id === hostId && host.endpoint === primaryEndpoint && host.lanEndpoint !== validated
    )
    if (index === -1) {
      return hosts
    }
    const next = [...hosts]
    next[index] = { ...hosts[index]!, lanEndpoint: validated }
    return next
  })
}
