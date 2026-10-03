import {
  BrowserNetworkTunnelClient as PortableBrowserNetworkTunnelClient,
  type BrowserNetworkTunnelClientOptions
} from '../../shared/browser-network-tunnel-client'
import { BrowserNetworkTunnelDuplex } from './browser-network-tunnel-duplex'

export class BrowserNetworkTunnelClient extends PortableBrowserNetworkTunnelClient<BrowserNetworkTunnelDuplex> {
  constructor(options: BrowserNetworkTunnelClientOptions) {
    super(options, (callbacks) => new BrowserNetworkTunnelDuplex(callbacks))
  }
}
