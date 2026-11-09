import { uiText } from '../settings/NativeUi';
import { appendLog as recordConnection, LOG_LEVEL_INFO, LOG_LEVEL_ERROR } from '../diagnostics/ConnectionLogStore';
import { router } from '@kit.ArkUI';
import { url } from '@kit.ArkTS';
import { loadMobileOnboardingSteps } from '../onboarding/MobileOnboardingPlan';
import { RelayConnectionOptions, relayConnectUrl } from '../transport/RelayProtocol';
import { prepareRelayPairing, commitRelayPairing } from '../transport/RelayPairing';
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
  @StorageProp('uiLocale') uiLocale: string = 'en';
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
  @State scanning: boolean = false;
  @State advanced: boolean = false;
  @State showPaste: boolean = false;
  @State stage: string = '';
  @State confirming: boolean = false;
  @State desktopEndpoint: string = '';
  @State desktopIdentity: string = '';
  @State pairedHostId: string = '';
  @State navigationBusy: boolean = false;
  private confirmedOffer: PairingOffer | null = null;
  private deadline: number = -1;
  private timedOut: boolean = false;
  private client: SpikeRpcClient | null = null;
  private disposed: boolean = false;
  private visible: boolean = false;
  private navigationEpoch: number = 0;
  aboutToDisappear(): void {
    this.disposed = true; this.visible = false; this.navigationEpoch++;
    if (this.deadline >= 0) { clearTimeout(this.deadline); this.deadline = -1; }
    if (this.client) { this.client.close(); this.client = null; }
  }

  aboutToAppear(): void {
    let params = (router.getParams() ?? {}) as Record<string, string>;
    if (params && typeof params['pairingCode'] === 'string') {
      this.pairingCode = params['pairingCode']; this.previewOffer(true);
    }
  }

  onPageShow(): void {
    this.visible = true; this.navigationEpoch++;
    if (this.pairedHostId.length > 0 && !this.busy && !this.navigationBusy) {
      this.continueAfterPair(this.pairedHostId).catch(() => {});
    } else if (this.confirmedOffer && !this.confirming) {
      this.doPair().catch(() => {});
    }
  }
  onPageHide(): void { this.visible = false; this.navigationEpoch++; }

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
    if (this.busy || this.scanning || this.disposed) { return; }
    this.scanning = true;
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
      if (this.disposed) { return; }
      this.pairingCode = result.originalValue;
      this.scanning = false;
      this.previewOffer(false);
    } catch (e) {
      if (!this.disposed) { this.appendLog('未读取到有效配对码，可重试扫码或手动粘贴'); }
    } finally {
      this.scanning = false;
    }
  }

  onBackPress(): boolean {
    if (this.confirming && !this.busy) { this.confirming = false; this.confirmedOffer = null; return true; }
    if (this.showPaste && !this.busy) { this.showPaste = false; this.pairingCode = ''; return true; }
    return false;
  }

  previewOffer(requireConfirmation: boolean): void {
    if (this.busy || this.disposed || this.pairedHostId.length > 0) { return; }
    try {
      let offer = parsePairingOffer(this.pairingCode);
      let endpoint = this.endpointOverride.trim() || offer.endpoint;
      let parsed = new url.URL(endpoint);
      if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('Invalid desktop endpoint');
      }
      this.confirmedOffer = offer;
      this.desktopEndpoint = endpoint;
      let id = hostIdFor(offer.publicKeyB64);
      this.desktopIdentity = `${id.substring(0, 8)} ${id.substring(8, 16)} ${id.substring(16, 24)} ${id.substring(24, 32)}`;
      this.pairingCode = '';
      this.stage = ''; this.confirming = requireConfirmation;
      if (!requireConfirmation) { this.doPair().catch(() => {}); }
    } catch (e) {
      this.pairingCode = '';
      this.confirmedOffer = null; this.confirming = false;
      this.stage = '配对信息无效或已过期，请重新获取';
    }
  }

  private async continueAfterPair(hostId: string): Promise<void> {
    this.pairedHostId = hostId;
    if (this.disposed || !this.visible || this.navigationBusy) { return; }
    this.navigationBusy = true;
    try {
      let steps = loadMobileOnboardingSteps(getContext(this));
      let params: Record<string, string> = { 'hostId': hostId };
      await router.replaceUrl({ url: steps.length > 0 ? 'pages/MobileOnboarding' : 'pages/ShellScreen', params: params });
    } catch (e) {
      if (!this.disposed) { this.stage = '配对已保存，无法继续首次设置，请重试'; }
    } finally { this.navigationBusy = false; }
  }

  private async connectOffer(offer: PairingOffer, endpoint: string): Promise<SpikeRpcClient> {
    let direct = new SpikeRpcClient(8000);
    this.client = direct;
    direct.setLogSink((line: string): void => this.appendLog(line));
    try {
      await direct.connect(endpoint, offer.deviceToken, offer.publicKeyB64, 'v2');
      return direct;
    } catch (e) {
      direct.close();
      if (!offer.relay || this.disposed || this.timedOut) { throw e as Error; }
    }
    let relay = offer.relay;
    if (!relay) { throw new Error('Relay offer unavailable'); }
    let origin = relay.cellUrl;
    let assignmentEpoch = relay.assignmentEpoch;
    let assignedCell = relay.cellUrl;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.disposed || this.timedOut) { throw new Error('Pairing cancelled'); }
      let candidate = new SpikeRpcClient(12000);
      this.client = candidate;
      let options: RelayConnectionOptions = { relayHostId: relay.relayHostId,
        credential: relay.inviteToken, credentialKind: 'invite' };
      candidate.configureRelay(options);
      candidate.setLogSink((line: string): void => this.appendLog(line));
      try {
        await candidate.connect(relayConnectUrl(origin, relay.relayHostId), offer.deviceToken, offer.publicKeyB64, 'v2');
        return candidate;
      } catch (e) {
        let move = candidate.getRelayMove();
        let closeCode = candidate.getRelayCloseCode();
        candidate.close();
        if (move) {
          if (move.assignmentEpoch < assignmentEpoch
            || (move.assignmentEpoch === assignmentEpoch && move.cellUrl !== assignedCell)) { throw e as Error; }
          origin = move.cellUrl; assignedCell = move.cellUrl; assignmentEpoch = move.assignmentEpoch;
        } else if ([0, 1006, 4409, 4503].includes(closeCode) && origin !== relay.directorUrl) { origin = relay.directorUrl; }
        else { throw e as Error; }
        await new Promise<void>((resolve): void => { setTimeout(resolve, 1000); });
      }
    }
    throw new Error('Relay pairing unavailable');
  }

  async doPair(): Promise<void> {
    let offer = this.confirmedOffer;
    if (this.busy || this.scanning || this.disposed || !this.visible || !offer || this.pairedHostId.length > 0) {
      return;
    }
    let pairingStartedAt = Date.now();
    let navigationEpoch = this.navigationEpoch;
    this.busy = true;
    this.logs = [];
    this.timedOut = false;
    this.deadline = setTimeout((): void => {
      this.timedOut = true; if (this.client) { this.client.close(); }
    }, 25000);
    this.stage = '正在验证配对信息…';
    let client: SpikeRpcClient | null = null;
    try {
      this.appendLog('正在验证配对信息…');
      let endpoint = this.desktopEndpoint;
      this.stage = '正在连接桌面…';

      client = await this.connectOffer(offer, endpoint);
      if (this.disposed) { return; }
      if (this.timedOut) { throw new Error('Pairing timed out'); }
      this.stage = '正在确认桌面身份…';

      // Read desktop identity + capabilities, then exchange the pairing ticket
      // when the host advertises it (upstream pairing-ticket-exchange semantics).
      let hostName = endpoint;
      let capabilities: string[] = [];
      let status: RpcResponse = await client.request('status.get', null);
      if (this.disposed) { return; }
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
        this.appendLog('桌面状态暂不可用，使用已验证的加密身份继续配对');
      }

      if (this.disposed) { return; }
      if (this.timedOut) { throw new Error('Pairing timed out'); }
      this.stage = '正在建立安全配对…';
      let prepared = await prepareRelayPairing(getContext(this), offer, client, pairingStartedAt, (): boolean => !this.disposed && !this.timedOut);
      if (this.disposed) { return; }
      if (this.timedOut) { throw new Error('Pairing timed out'); }
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
        if (this.disposed) { return; }
        if (this.timedOut) { throw new Error('Pairing timed out'); }
        let exchanged = false;
        if (reply instanceof RpcSuccess) {
          let result = JSON.parse(reply.result) as Record<string, Object>;
          exchanged = result !== null && typeof result['deviceId'] === 'string' && (result['deviceId'] as string).length > 0;
        }
        if (exchanged) {
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
      if (this.timedOut) { throw new Error('Pairing timed out'); }
      this.stage = '正在保存配对…';
      if (prepared) { await commitRelayPairing(getContext(this), meta, token, prepared, (): boolean => !this.disposed && !this.timedOut); }
      else { await saveHost(getContext(this), meta, token, undefined, pairingStartedAt); }
      if (this.disposed) { return; }
      this.pairingCode = '';
      this.stage = '配对成功';
      this.appendLog('配对成功');
      recordConnection(getContext(this), LOG_LEVEL_INFO, '桌面配对成功', '').catch(() => {});
      client.close();
      this.confirming = false; this.confirmedOffer = null;
      await this.continueAfterPair(meta.id);
    } catch (e) {
      if (this.disposed) { return; }
      if (!this.confirming) { this.confirmedOffer = null; }
      this.stage = '配对失败，请检查配对码和网络连接后重试';
      this.appendLog(this.stage);
      recordConnection(getContext(this), LOG_LEVEL_ERROR, '桌面配对失败', '').catch(() => {});
      if (client) {
        client.close();
      }
    } finally {
      if (this.deadline >= 0) { clearTimeout(this.deadline); this.deadline = -1; }
      if (client) { client.close(); }
      this.client = null;
      this.busy = false;
      if (!this.disposed && this.visible && navigationEpoch !== this.navigationEpoch
        && this.pairedHostId.length > 0 && !this.navigationBusy) {
        this.continueAfterPair(this.pairedHostId).catch(() => {});
      }
    }
  }

  build() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Button(uiText('返回', this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeText).backgroundColor(Color.Transparent)
          .onClick(() => {
            if (!this.onBackPress()) { router.back(); }
          })
        Text(uiText('配对桌面', this.uiLocale))
          .fontFamily('Geist').fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 10 })

      if (this.pairedHostId.length > 0) {
        Text(uiText('配对已保存', this.uiLocale)).fontFamily('Geist').fontSize(20).fontColor(this.themeText)
        if (this.stage.length > 0) { Text(uiText(this.stage, this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeSecondary) }
        Button(uiText('继续首次设置', this.uiLocale)).fontFamily('Geist').fontSize(16).width('100%').height(48)
          .enabled(!this.navigationBusy).onClick(() => { this.continueAfterPair(this.pairedHostId).catch(() => {}); })
      } else if (this.busy) {
        Column({ space: 14 }) {
          LoadingProgress().width(32).height(32).color(this.themeText)
          Text(uiText(this.stage, this.uiLocale)).fontFamily('Geist').fontSize(17).fontColor(this.themeText)
        }.width('100%').padding({ top: 36, bottom: 20 })
      } else if (this.confirming) {
        Text(uiText('信任并配对此桌面？', this.uiLocale)).fontFamily('Geist').fontSize(24).fontWeight(FontWeight.Bold).fontColor(this.themeText)
        Text(uiText('此身份来自你扫描或粘贴的配对信息。确认你信任这台桌面后继续。', this.uiLocale))
          .fontFamily('Geist').fontSize(15).fontColor(this.themeSecondary)
        Text(this.desktopEndpoint).fontFamily('Geist').fontSize(16).fontColor(this.themeText).width('100%')
        Text(uiText('桌面身份指纹', this.uiLocale)).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary).width('100%')
        Text(this.desktopIdentity).fontFamily('monospace').fontSize(15).fontColor(this.themeText).width('100%')
        Text(uiText('配对后，此手机可访问该桌面提供的工作区、终端、文件和智能体功能。确认后才会建立加密连接并保存凭证。', this.uiLocale))
          .fontFamily('Geist').fontSize(15).fontColor(this.themeSecondary)
        if (this.stage.length > 0) { Text(uiText(this.stage, this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeSecondary).width('100%') }
        Button(uiText(this.busy ? '配对中…' : '信任并配对', this.uiLocale))
          .fontFamily('Geist').fontSize(16).width('100%').height(48).enabled(!this.busy)
          .onClick(() => { this.doPair().catch(() => {}); })
        Button(uiText('取消', this.uiLocale)).fontFamily('Geist').fontSize(16).width('100%').height(44)
          .fontColor(this.themeSecondary).backgroundColor(Color.Transparent).enabled(!this.busy)
          .onClick(() => { this.confirming = false; this.confirmedOffer = null; })
      } else {
        Column({ space: 12 }) {
          Text(uiText('在桌面 Orca 的设置 → 移动端生成二维码，然后扫码或粘贴配对链接。', this.uiLocale))
            .fontFamily('Geist').fontSize(15).fontColor(this.themeSecondary).textAlign(TextAlign.Center)
          if (!this.showPaste) {
            Button(uiText('扫码', this.uiLocale)).fontFamily('Geist').fontSize(16).width('100%').height(48)
              .fontColor(this.themeBg).backgroundColor(this.themeText)
              .enabled(!this.scanning).onClick(() => { this.doScan().catch(() => {}); })
            Button(uiText('粘贴配对链接或配对码', this.uiLocale)).fontFamily('Geist').fontSize(14)
              .fontColor(this.themeSecondary).backgroundColor(Color.Transparent)
              .enabled(!this.scanning).onClick(() => { this.showPaste = true; })
          } else {
            TextArea({ placeholder: uiText('粘贴配对链接或配对码', this.uiLocale), text: this.pairingCode })
              .fontFamily('Geist').fontSize(14).height(110)
              .onChange((value: string) => { this.pairingCode = value; })
            Button(uiText('继续', this.uiLocale)).fontFamily('Geist').fontSize(16).width('100%').height(48)
              .fontColor(this.themeBg).backgroundColor(this.themeText)
              .enabled(this.pairingCode.trim().length > 0).onClick(() => this.previewOffer(false))
            Button(uiText(this.advanced ? '收起连接选项' : '连接选项', this.uiLocale))
              .fontFamily('Geist').fontSize(13).fontColor(this.themeMuted).backgroundColor(Color.Transparent)
              .onClick(() => { this.advanced = !this.advanced; })
            if (this.advanced) {
              TextInput({ placeholder: uiText('桌面 WebSocket 地址（可选）', this.uiLocale), text: this.endpointOverride })
                .fontFamily('Geist').fontSize(14).height(44)
                .onChange((value: string) => { this.endpointOverride = value; })
            }
          }
          if (this.stage.length > 0) {
            Text(uiText(this.stage, this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeSecondary)
          }
        }
        .width('100%').constraintSize({ maxWidth: 420 }).padding({ top: 24, left: 12, right: 12 })
      }

      List({ space: 2 }) {
        ForEach(this.logs, (line: string) => {
          ListItem() {
            Text(line)
              .fontFamily('Geist').fontSize(10)
              .fontColor(this.themeSecondary)
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
