import { connection } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';

const NETWORK_SETTLE_MS = 250;

function currentNetworkPath(): string | null {
  let network = connection.getDefaultNetSync();
  if (network.netId === 0) { return null; }
  let properties = connection.getConnectionPropertiesSync(network);
  let addresses = properties.linkAddresses.map((link: connection.LinkAddress): string =>
    `${link.address.address}/${link.prefixLength}`).sort();
  let routes = properties.routes.filter((route: connection.RouteInfo): boolean =>
    route.isDefaultRoute || route.destination.prefixLength === 0)
    .map((route: connection.RouteInfo): string => `${route.interface}/${route.gateway.address}`).sort();
  return JSON.stringify([String(network.netId), properties.interfaceName, addresses.join(','), routes.join(',')]);
}

export class DefaultNetworkObserver {
  private observer: connection.NetConnection | null = null;
  private registered: boolean = false;
  private timer: number = -1;
  private path: string | null | undefined;
  private lost: boolean = false;
  private onChange: () => void;

  constructor(onChange: () => void) { this.onChange = onChange; }

  start(): void {
    if (this.observer) { return; }
    this.path = undefined; this.lost = false;
    let observer: connection.NetConnection;
    try { observer = connection.createNetConnection(); } catch (e) { return; }
    this.observer = observer;
    let schedule = (): void => {
      if (this.observer !== observer || this.timer >= 0) { return; }
      this.timer = setTimeout((): void => {
        this.timer = -1;
        if (this.observer === observer) { this.readPath(); }
      }, NETWORK_SETTLE_MS);
    };
    try {
      this.readPath();
      observer.on('netAvailable', schedule);
      observer.on('netLost', (): void => {
        if (this.observer !== observer) { return; }
        this.lost = true; schedule();
      });
      observer.on('netConnectionPropertiesChange', schedule);
      observer.register((error: BusinessError): void => {
        if (this.observer !== observer) {
          if (!error) { this.unregister(observer); }
          return;
        }
        if (error) { this.stop(); return; }
        this.registered = true;
        schedule();
      });
    } catch (e) { this.stop(); }
  }

  stop(): void {
    let observer = this.observer;
    this.observer = null;
    if (this.timer >= 0) { clearTimeout(this.timer); this.timer = -1; }
    if (observer && this.registered) { this.unregister(observer); }
    this.registered = false;
  }

  private readPath(): void {
    let next: string | null;
    try { next = currentNetworkPath(); } catch (e) { return; }
    let previous = this.path;
    this.path = next;
    let lost = this.lost; this.lost = false;
    if (previous !== undefined && next !== null && (lost || previous !== next)) { this.onChange(); }
  }

  private unregister(observer: connection.NetConnection): void {
    try { observer.unregister((): void => {}); } catch (e) {}
  }
}
