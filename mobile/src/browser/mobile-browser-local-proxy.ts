import { sha256 } from '@noble/hashes/sha256'
import type { OrcaProxiedBrowserModule } from '../../modules/orca-proxied-browser/src'
import { decodeBase64Bytes } from '../transport/base64-byte-codec'
import type {
  MobileBrowserTunnelClient,
  MobileBrowserTunnelStream
} from './mobile-browser-tunnel-client'

type Connection = {
  // Null only while tunnel.open runs, which can already close the stream.
  stream: MobileBrowserTunnelStream | null
  accepted: boolean
}

/** Answers each web view connection on this host's proxy with a tunnel stream to the host. */
export function bridgeProxiedBrowserToTunnel(
  native: OrcaProxiedBrowserModule,
  proxyKey: string,
  tunnel: Pick<MobileBrowserTunnelClient, 'open'>
): { stop: () => void } {
  const connections = new Map<number, Connection>()
  const subscriptions = [
    native.addListener('onProxyOpen', (event) => {
      if (event.proxy !== proxyKey) {
        return
      }
      const id = event.connection
      const connection: Connection = { accepted: false, stream: null }
      connections.set(id, connection)
      connection.stream = tunnel.open(
        { host: event.host, port: event.port },
        {
          opened: () => {
            connection.accepted = true
            native.proxyAccept(id)
          },
          data: (bytes) => native.proxyWrite(id, bytes),
          end: () => native.proxyEnd(id),
          closed: () => {
            if (!connections.delete(id)) {
              return
            }
            if (connection.accepted) {
              native.proxyClose(id)
            } else {
              native.proxyReject(id)
            }
          }
        }
      )
    }),
    native.addListener('onProxyData', (event) => {
      connections.get(event.connection)?.stream?.write(decodeBase64Bytes(event.data))
    }),
    native.addListener('onProxyEnd', (event) => {
      connections.get(event.connection)?.stream?.end()
    }),
    native.addListener('onProxyClosed', (event) => {
      const connection = connections.get(event.connection)
      connections.delete(event.connection)
      connection?.stream?.close()
    })
  ]
  return {
    stop: () => {
      for (const subscription of subscriptions) {
        subscription.remove()
      }
      for (const [id, connection] of connections) {
        connections.delete(id)
        connection.stream?.close()
        native.proxyClose(id)
      }
    }
  }
}

/** A stable UUID v4-shaped id per host, so each host keeps its own cookies and sign-ins on the phone. */
export function proxiedBrowserStoreId(hostId: string): string {
  return storeIdFromSeed(`orca-proxied-browser:${hostId}`)
}

// One jar for pages on the phone's own network, kept apart from every host's jar.
export const PHONE_NETWORK_BROWSER_STORE_ID = storeIdFromSeed('orca-phone-network-browser')

function storeIdFromSeed(seed: string): string {
  const bytes = sha256(new TextEncoder().encode(seed)).slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
