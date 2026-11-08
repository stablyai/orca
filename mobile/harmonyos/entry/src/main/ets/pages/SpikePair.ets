import { SpikeRpcClient, RpcResponse, RpcSuccess, RpcFailure } from '../transport/SpikeRpcClient';
import { parsePairingOffer, PairingOffer } from '../transport/E2eeV2Session';
import { randomBytes, toHex } from '../transport/crypto/Bytes';

/**
 * Spike B UI: manually paste the desktop pairing offer (orca://pair?code=…, raw
 * base64url, or raw JSON — the QR payload), connect over E2EE v2 and run probe /
 * ticket-exchange RPC calls against the paired Orca desktop.
 */
@Entry
@Component
struct SpikePair {
  @State endpoint: string = '';
  @State pairingCode: string = '';
  @State logs: string[] = [];
  @State connected: boolean = false;
  @State legacyMode: boolean = false;
  private client: SpikeRpcClient = new SpikeRpcClient();

  aboutToAppear(): void {
    this.client.setLogSink((line: string) => this.appendLog(line));
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

  async doConnect(): Promise<void> {
    try {
      this.appendLog('正在验证配对信息');
      let offer: PairingOffer = parsePairingOffer(this.pairingCode);
      if (this.endpoint.trim().length > 0) {
        offer.endpoint = this.endpoint.trim();
      }
      this.appendLog(`offer ok endpoint=${offer.endpoint} scope=${offer.scope} relay=${offer.hasRelay}`);
      let framing = this.legacyMode ? 'legacy' : 'v2';
      await this.client.connect(offer.endpoint, offer.deviceToken, offer.publicKeyB64, framing);
      this.connected = true;
      this.appendLog('CONNECTED');
    } catch (e) {
      this.appendLog(`connect failed: ${(e as Error).message}`);
    }
  }

  async doStatusGet(): Promise<void> {
    try {
      let response: RpcResponse = await this.client.request('status.get', null);
      if (response instanceof RpcSuccess) {
        let text = response.result;
        if (text.length > 400) {
          text = `${text.slice(0, 400)}…`;
        }
        this.appendLog(`status.get ok: ${text}`);
      } else {
        let failure = response as RpcFailure;
        this.appendLog(`status.get failed: ${failure.errorCode} ${failure.errorMessage}`);
      }
    } catch (e) {
      this.appendLog(`status.get error: ${(e as Error).message}`);
    }
  }

  async doExchangeTicket(): Promise<void> {
    try {
      let newToken = toHex(randomBytes(24));
      let response: RpcResponse = await this.client.request('pairing.exchangeTicket',
        JSON.stringify({ deviceToken: newToken }));
      if (response instanceof RpcSuccess) {
        this.appendLog(`exchangeTicket ok: ${response.result}`);
        this.appendLog('→ new device token kept in memory for this spike run');
      } else {
        let failure = response as RpcFailure;
        this.appendLog(`exchangeTicket failed: ${failure.errorCode} ${failure.errorMessage}`);
      }
    } catch (e) {
      this.appendLog(`exchangeTicket error: ${(e as Error).message}`);
    }
  }

  build() {
    Column({ space: 10 }) {
      Text('Spike B · 配对 + E2EE 连接桌面')
        .fontFamily('Geist').fontSize(18)
        .fontWeight(FontWeight.Bold)
        .fontColor('#e8e8e8')

      TextInput({ placeholder: 'ws://192.168.x.x:6768（留空则用 offer 内 endpoint）', text: this.endpoint })
        .fontFamily('Geist').fontSize(12)
        .height(40)
        .onChange((value: string) => {
          this.endpoint = value;
        })

      TextArea({ placeholder: '粘贴 orca://pair?code=… / base64url / JSON offer', text: this.pairingCode })
        .fontFamily('Geist').fontSize(11)
        .height(90)
        .onChange((value: string) => {
          this.pairingCode = value;
        })

      Row({ space: 10 }) {
        Toggle({ type: ToggleType.Checkbox, isOn: this.legacyMode })
          .onChange((isOn: boolean) => {
            this.legacyMode = isOn;
          })
        Text('legacy v1（mock server）')
          .fontFamily('Geist').fontSize(12)
          .fontColor('#9a9a9a')
        Blank()
      }
      .width('100%')

      Row({ space: 8 }) {
        Button(this.connected ? '已连接 ✓' : '连接')
          .fontFamily('Geist').fontSize(14)
          .layoutWeight(1)
          .enabled(!this.connected && this.pairingCode.length > 0)
          .onClick(() => {
            this.doConnect();
          })
        Button('status.get')
          .fontFamily('Geist').fontSize(12)
          .layoutWeight(1)
          .enabled(this.connected)
          .onClick(() => {
            this.doStatusGet();
          })
        Button('exchangeTicket')
          .fontFamily('Geist').fontSize(12)
          .layoutWeight(1)
          .enabled(this.connected)
          .onClick(() => {
            this.doExchangeTicket();
          })
      }
      .width('100%')

      List({ space: 2 }) {
        ForEach(this.logs, (line: string) => {
          ListItem() {
            Text(line)
              .fontFamily('Geist').fontSize(10)
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
    .backgroundColor('#111111')
  }
}
