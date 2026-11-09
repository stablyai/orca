import { http, webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { isDirectEndpoint } from '../transport/RelayProtocol';

export type ProbeStatus = 'pass' | 'warn' | 'fail';

export class TroubleshootProbes {
  private pending: (() => void) | null = null;

  cancel(): void { this.pending?.(); }

  internet(): Promise<ProbeStatus> {
    this.cancel();
    return new Promise<ProbeStatus>((resolve: (status: ProbeStatus) => void): void => {
      let request = http.createHttp();
      let settled = false;
      let finish = (status: ProbeStatus): void => {
        if (settled) { return; }
        settled = true;
        this.pending = null;
        clearTimeout(timer);
        try { request.destroy(); } catch (e) {}
        resolve(status);
      };
      let timer = setTimeout((): void => finish('fail'), 5000);
      this.pending = (): void => finish('fail');
      try {
        request.request('https://dns.google/resolve?name=example.com&type=A', {
          method: http.RequestMethod.GET, connectTimeout: 5000, readTimeout: 5000, usingCache: false
        }).then((response: http.HttpResponse): void => {
          finish(response.responseCode >= 200 && response.responseCode < 300 ? 'pass' : 'warn');
        }).catch((): void => finish('fail'));
      } catch (e) { finish('fail'); }
    });
  }

  desktop(endpoint: string): Promise<boolean> {
    this.cancel();
    if (!isDirectEndpoint(endpoint)) { return Promise.resolve(false); }
    return new Promise<boolean>((resolve: (reachable: boolean) => void): void => {
      let socket = webSocket.createWebSocket();
      let settled = false;
      let close = (): void => { try { socket.close().catch(() => {}); } catch (e) {} };
      let finish = (reachable: boolean): void => {
        if (settled) { return; }
        settled = true;
        this.pending = null;
        clearTimeout(timer);
        close();
        resolve(reachable);
      };
      let timer = setTimeout((): void => finish(false), 4000);
      this.pending = (): void => finish(false);
      try {
        socket.on('open', (error: BusinessError): void => {
          if (settled) { close(); return; }
          finish(!error || error.code === 0);
        });
        socket.on('error', (): void => finish(false));
        socket.on('close', (): void => finish(false));
        socket.connect(endpoint).then((started: boolean): void => {
          if (!started) { finish(false); }
        }).catch((): void => finish(false));
      } catch (e) { finish(false); }
    });
  }
}
