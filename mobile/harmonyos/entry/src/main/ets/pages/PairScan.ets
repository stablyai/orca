import { appendLog as recordConnection, LOG_LEVEL_INFO, LOG_LEVEL_ERROR } from '../diagnostics/ConnectionLogStore';
import { router } from '@kit.ArkUI';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { SpikeRpcClient, RpcResponse, RpcSuccess } from '../transport/SpikeRpcClient';
import { parsePairingOffer, PairingOffer } from '../transport/E2eeV2Session';
import { hostIdFor, saveHost, HostMeta } from '../storage/HostStore';
import { randomBytes, toHex } from '../transport/crypto/Bytes';

/**
 * Pairing flow (Phase 1): scan the desktop QR (Scan Kit default UI) or paste the
 * `orca://pair?code=…` offer, connect over E2EE v2, read the desktop status for
 * its machine name and capabilities, exchange the pairing ticket when the host
 * advertises the capability, then persist the host (token into the Asset Store).
 */

const TICKET_EXCHANGE_CAPABILITY = 'pairing.ticket-exchange.v1';

@Entry
@Component
struct PairScan {
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#1c1c1c';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeSecondary') themeSecondary: string = '#b5bec9';
  @StorageProp('themeAccent') themeAccent: string = '#7ddf7d';
  @StorageProp('themeLink') themeLink: string = '#96b8e5';
  @StorageProp('themeWarning') themeWarning: string = '#e0c070';
  @State endpointOverride: string = '';
  @State pairingCode: string = '';
  @State logs: string[] = [];
  @State busy: boolean = false;
  private client: SpikeRpcClient | null = null;
  private disposed: boolean = false;
  aboutToDisappear(): void { this.disposed = true; if (this.client) { this.client.close(); } }

  aboutToAppear(): void {
    let params = router.getParams() as Record<string, string>;
    if (params && typeof params['pairingCode'] === 'string') { this.pairingCode = params['pairingCode']; }
  }

  appendLog(line: string): void {
    let stamped = `${new Date().toLocaleTimeString()}  ${line}`;
    let next = this.logs.slice();
    next.push(stamped);
    if (next.length > 200) {
      next.splice(0, next.length - 200);
    }
    this.logs = next;
  }

  async doScan(): Promise<void> {
    try {
      let options: scanBarcode.ScanOptions = { scanTypes: [scanCore.ScanType.QR_CODE] };
      // API 26 Scan Kit exposes callback-only startScan; wrap it in a promise.
      let result: scanBarcode.ScanResult = await new Promise<scanBarcode.ScanResult>((resolve, reject) => {
        scanBarcode.startScan(options, (err: BusinessError, value: scanBarcode.ScanResult) => {
          if (err) {
            reject(err as Error);
          } else {
            resolve(value);
          }
        });
      });
      this.pairingCode = result.originalValue;
      this.appendLog('扫码成功');
    } catch (e) {
      this.appendLog(`扫码不可用（${(e as Error).message}），请手动粘贴配对码`);
    }
  }

  async doPair(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    let client: SpikeRpcClient | null = null;
    try {
      this.appendLog('正在验证配对信息…');
      let offer: PairingOffer = parsePairingOffer(this.pairingCode);
      let endpoint = this.endpointOverride.trim().length > 0 ? this.endpointOverride.trim() : offer.endpoint;
      this.appendLog(`offer ok endpoint=${endpoint} scope=${offer.scope} relay=${offer.hasRelay}`);

      client = new SpikeRpcClient();
      this.client = client;
      client.setLogSink((line: string): void => this.appendLog(line));
      await client.connect(endpoint, offer.deviceToken, offer.publicKeyB64, 'v2');
      this.appendLog('CONNECTED');

      // Read desktop identity + capabilities, then exchange the pairing ticket
      // when the host advertises it (upstream pairing-ticket-exchange semantics).
      let hostName = endpoint;
      let capabilities: string[] = [];
      let status: RpcResponse = await client.request('status.get', null);
      if (status instanceof RpcSuccess) {
        let parsed: Object | null = JSON.parse(status.result) as Object | null;
        if (parsed !== null && typeof parsed === 'object') {
          let rec = parsed as Record<string, Object>;
          let machineName: Object = rec['machineName'];
          if (typeof machineName === 'string' && machineName.length > 0) {
            hostName = machineName;
          }
          let capsValue: Object = rec['capabilities'];
          if (Array.isArray(capsValue)) {
            let caps = capsValue as Array<string>;
            for (let i = 0; i < caps.length; i++) {
              if (typeof caps[i] === 'string') {
                capabilities.push(caps[i]);
              }
            }
          }
        }
        this.appendLog(`host: ${hostName}`);
      } else {
        this.appendLog('status.get failed — pairing anyway');
      }

      let token = offer.deviceToken;
      let hasExchange = false;
      for (let i = 0; i < capabilities.length; i++) {
        if (capabilities[i] === TICKET_EXCHANGE_CAPABILITY) {
          hasExchange = true;
          break;
        }
      }
      if (hasExchange) {
        let newToken = toHex(randomBytes(24));
        let params: Record<string, Object> = { 'deviceToken': newToken };
        let reply: RpcResponse = await client.request('pairing.exchangeTicket', JSON.stringify(params));
        if (reply instanceof RpcSuccess) {
          token = newToken;
          this.appendLog('配对码已换成本机独有 token');
        } else {
          this.appendLog('换票被拒，保留扫码 token（上游同款回退行为）');
        }
      } else {
        this.appendLog('桌面未广播换票 capability，保留扫码 token');
      }

      let meta: HostMeta = {
        id: hostIdFor(offer.publicKeyB64),
        name: hostName,
        endpoint: endpoint,
        publicKeyB64: offer.publicKeyB64,
        lastConnected: Date.now()
      };
      if (this.disposed) { return; }
      await saveHost(getContext(this), meta, token);
      this.appendLog('配对成功');
      recordConnection(getContext(this), LOG_LEVEL_INFO, '桌面配对成功', '').catch(() => {});
      client.close();
      router.back();
    } catch (e) {
      this.appendLog('配对失败，请检查配对码是否有效及网络连接');
      recordConnection(getContext(this), LOG_LEVEL_ERROR, '桌面配对失败', '').catch(() => {});
      if (client) {
        client.close();
      }
    } finally {
      if (client) { client.close(); }
      this.client = null;
      this.busy = false;
    }
  }

  build() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Text('配对桌面')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
        Button('扫码')
          .fontSize(13)
          .height(36)
          .onClick(() => {
            this.doScan();
          })
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 10 })

      TextInput({ placeholder: 'endpoint 覆盖（可选，模拟器用 ws://10.0.2.2:port）', text: this.endpointOverride })
        .fontSize(12)
        .height(40)
        .onChange((value: string) => {
          this.endpointOverride = value;
        })

      TextArea({ placeholder: '粘贴 orca://pair?code=… / base64url / JSON offer', text: this.pairingCode })
        .fontSize(11)
        .height(110)
        .onChange((value: string) => {
          this.pairingCode = value;
        })

      Button(this.busy ? '配对中…' : '连接并保存')
        .fontSize(14)
        .width('100%')
        .enabled(!this.busy && this.pairingCode.length > 0)
        .onClick(() => {
          this.doPair();
        })

      List({ space: 2 }) {
        ForEach(this.logs, (line: string) => {
          ListItem() {
            Text(line)
              .fontSize(10)
              .fontColor('#a0c8a0')
              .maxLines(3)
          }
        }, (line: string, index: number) => `${index}-${line}`)
      }
      .layoutWeight(1)
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .padding(12)
    .backgroundColor(this.themeBg)
  }
}
