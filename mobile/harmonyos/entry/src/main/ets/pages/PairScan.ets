import { uiText } from '../settings/NativeUi';
import { appendLog as recordConnection, LOG_LEVEL_INFO, LOG_LEVEL_ERROR } from '../diagnostics/ConnectionLogStore';
import { KeyboardAvoidMode as PageKeyboardAvoidMode, router } from '@kit.ArkUI';
import { url } from '@kit.ArkTS';
import { abilityAccessCtrl, common } from '@kit.AbilityKit';
import { PairingCamera } from '../pairing/PairingCamera';
import { lucideColorFilter } from '../settings/LucideColor';
import { loadMobileOnboardingSteps } from '../onboarding/MobileOnboardingPlan';
import { refreshDesktopConnection } from '../transport/DesktopConnections';
import { PairingConnection, PAIRING_CODE_REFUSED } from '../pairing/PairingConnection';
import { prepareRelayPairing, commitRelayPairing } from '../transport/RelayPairing';
import { RpcResponse, RpcSuccess } from '../transport/SpikeRpcClient';
import { parsePairingOffer, PairingOffer } from '../transport/E2eeV2Session';
import { hostIdFor, saveHost, HostMeta } from '../storage/HostStore';
import { randomBytes, toHex } from '../transport/crypto/Bytes';

const TICKET_EXCHANGE_CAPABILITY = 'pairing.ticket-exchange.v1';
const CAMERA_PERMISSION = 'ohos.permission.CAMERA';
const PAIR_TIMEOUT_MS = 25000;
const PAIRED_HOLD_MS = 450;
const PAIRING_CODE_FIELD = 'orca-pairing-code';
const REJECTED_CODE = '配对码已过期、已使用或已被替换。请在桌面显示新配对码后重新扫描。';

function scanErrorLabel(raw: string): string {
  try {
    let target = new url.URL(raw.trim());
    let path = target.pathname.replace(/\/$/, '');
    let download = (target.origin === 'https://apps.apple.com' && /^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id6766130217$/.test(path)) ||
      (['https://www.onorca.dev', 'https://onorca.dev'].includes(target.origin) && path === '/download/android') ||
      (target.origin === 'https://testflight.apple.com' && path === '/join/YjeGMQBA') ||
      (target.origin === 'https://github.com' && /^\/stablyai\/orca\/releases\/download\/mobile-android-v[^/]+\/app-release\.apk$/.test(path));
    if (download) { return '这是下载二维码，请扫描电脑上第 2 步中的配对二维码。'; }
  } catch (e) {}
  return '这不是有效的 Orca 二维码';
}

@Entry
@Component
struct PairScan {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeScheme') themeScheme: string = 'dark';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeSheet') themeSheet: string = '#171717';
  @StorageProp('themeBorder') themeBorder: string = '#2c2c2c';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @State pairingCode: string = '';
  @State logs: string[] = [];
  @State busy: boolean = false;
  @State openedFromLink: boolean = false;
  @State showPaste: boolean = false;
  @State error: string = '';
  @State confirming: boolean = false;
  @State pairedHostId: string = '';
  @State navigationBusy: boolean = false;
  @State permission: number = abilityAccessCtrl.PermissionStatus.NOT_DETERMINED;
  @State permissionBusy: boolean = false;
  @State cameraFailed: boolean = false;
  @State decoded: boolean = false;
  @State showCamera: boolean = false;
  private confirmedOffer: PairingOffer | null = null;
  private repairHostId: string = '';
  private deadline: number = -1;
  private timedOut: boolean = false;
  private pairingStartedAt: number = 0;
  private attempt: PairingConnection | null = null;
  private disposed: boolean = false;
  private visible: boolean = false;
  private navigationEpoch: number = 0;
  private context?: common.UIAbilityContext;
  private pasteInput: TextInputController = new TextInputController();
  private logScroll: Scroller = new Scroller();
  private priorKeyboardMode?: PageKeyboardAvoidMode;
  private foreground: boolean = true;
  private onForeground = (): void => { this.foreground = true; this.refreshCameraPermission(); };
  private onBackground = (): void => { this.foreground = false; this.cancelCameraDecode(); this.updateCamera(); };

  aboutToAppear(): void {
    let context = getContext(this) as common.UIAbilityContext;
    this.context = context;
    context.eventHub.on('orcaForeground', this.onForeground);
    context.eventHub.on('orcaBackground', this.onBackground);
    let params = (router.getParams() ?? {}) as Record<string, string>;
    this.repairHostId = params['repairHostId'] ?? '';
    if (typeof params['pairingCode'] === 'string') {
      this.openedFromLink = true;
      this.acceptOffer(params['pairingCode'], true);
    }
  }

  aboutToDisappear(): void {
    this.disposed = true; this.visible = false; this.navigationEpoch++; this.restoreKeyboardMode();
    this.context?.eventHub.off('orcaForeground', this.onForeground);
    this.context?.eventHub.off('orcaBackground', this.onBackground);
    if (this.deadline >= 0) { clearTimeout(this.deadline); this.deadline = -1; }
    this.attempt?.close(); this.attempt = null;
  }

  onPageShow(): void {
    this.visible = true; this.navigationEpoch++;
    if (this.showPaste) { this.resizeForKeyboard(); }
    this.refreshCameraPermission();
    if (this.pairedHostId.length > 0 && !this.busy && !this.navigationBusy) {
      this.continueAfterPair(this.pairedHostId).catch(() => {});
    }
  }

  onPageHide(): void { this.visible = false; this.navigationEpoch++; this.cancelCameraDecode(); this.restoreKeyboardMode(); this.updateCamera(); }

  private cancelCameraDecode(): void {
    if (this.decoded && !this.busy) { this.confirmedOffer = null; this.decoded = false; }
  }

  private t(text: string): string { return uiText(text, this.uiLocale); }

  private refreshCameraPermission(): void {
    if (this.openedFromLink || this.disposed) { return; }
    try {
      this.permission = abilityAccessCtrl.createAtManager().getSelfPermissionStatus(CAMERA_PERMISSION);
    } catch (e) { this.permission = abilityAccessCtrl.PermissionStatus.DENIED; }
    this.updateCamera();
  }

  private updateCamera(): void {
    this.showCamera = this.visible && this.foreground && !this.disposed && !this.openedFromLink &&
      !this.busy && !this.error && !this.showPaste && !this.cameraFailed && !this.pairedHostId &&
      this.permission === abilityAccessCtrl.PermissionStatus.GRANTED;
  }

  private async requestCamera(): Promise<void> {
    let context = this.context;
    if (!context || this.permissionBusy) { return; }
    this.permissionBusy = true;
    let manager = abilityAccessCtrl.createAtManager();
    try {
      if (this.permission === abilityAccessCtrl.PermissionStatus.NOT_DETERMINED) {
        await manager.requestPermissionsFromUser(context, [CAMERA_PERMISSION]);
      } else {
        await manager.requestPermissionOnSetting(context, [CAMERA_PERMISSION]);
      }
    } catch (e) {}
    finally { this.permissionBusy = false; this.refreshCameraPermission(); }
  }

  private openPaste(): void {
    this.cancelCameraDecode();
    this.error = ''; this.logs = []; this.pairingCode = ''; this.showPaste = true;
    this.resizeForKeyboard(); this.updateCamera();
  }

  private resizeForKeyboard(): void {
    if (this.priorKeyboardMode !== undefined) { return; }
    let context = this.getUIContext();
    this.priorKeyboardMode = context.getKeyboardAvoidMode();
    context.setKeyboardAvoidMode(PageKeyboardAvoidMode.RESIZE);
  }

  private restoreKeyboardMode(): void {
    if (this.priorKeyboardMode === undefined) { return; }
    this.getUIContext().setKeyboardAvoidMode(this.priorKeyboardMode);
    this.priorKeyboardMode = undefined;
  }

  private dismissPaste(): void {
    this.pasteInput.stopEditing(); this.showPaste = false; this.pairingCode = '';
    this.restoreKeyboardMode();
  }

  private closePaste(): void { this.dismissPaste(); this.updateCamera(); }

  private submitPaste(): void {
    if (!this.showPaste || !this.pairingCode.trim()) { return; }
    let input = this.pairingCode;
    this.dismissPaste();
    this.acceptOffer(input);
  }

  private retry(): void {
    this.error = ''; this.logs = []; this.decoded = false; this.cameraFailed = false;
    this.refreshCameraPermission();
  }

  private appendLog(line: string): void {
    let elapsed = Math.max(0, Date.now() - this.pairingStartedAt) / 1000;
    this.logs = [...this.logs.slice(-199), `+${elapsed.toFixed(elapsed < 10 ? 2 : 1)}s  ${line}`];
  }

  onBackPress(): boolean {
    if (this.showPaste) { this.closePaste(); return true; }
    if (this.openedFromLink) { router.back({ url: 'pages/Home' }); return true; }
    return false;
  }

  private acceptOffer(input: string, fromLink: boolean = false, fromCamera: boolean = false): void {
    if (this.busy || this.disposed || this.pairedHostId.length > 0 || this.decoded) { return; }
    try {
      this.confirmedOffer = parsePairingOffer(input, fromLink || fromCamera);
      this.error = ''; this.confirming = fromLink;
      if (fromCamera) {
        this.decoded = true;
        let offer = this.confirmedOffer;
        setTimeout((): void => {
          if (offer === this.confirmedOffer && this.foreground) { this.doPair().catch(() => {}); }
        }, 160);
      } else if (!fromLink) { this.doPair().catch(() => {}); }
    } catch (e) {
      this.confirmedOffer = null; this.confirming = false;
      this.error = fromLink ? '此链接缺少有效的配对码' : fromCamera ? scanErrorLabel(input) :
        '配对码无效，请从电脑复制后重新粘贴';
      this.updateCamera();
    }
  }

  private async continueAfterPair(hostId: string): Promise<void> {
    this.pairedHostId = hostId;
    if (this.disposed || !this.visible || this.navigationBusy) { return; }
    this.navigationBusy = true;
    try {
      let steps = loadMobileOnboardingSteps(getContext(this));
      if (steps.length === 0 && hostId === this.repairHostId) { router.back(); return; }
      let params: Record<string, string> = { 'hostId': hostId };
      await router.replaceUrl({ url: steps.length > 0 ? 'pages/MobileOnboarding' : 'pages/ShellScreen', params: params });
    } catch (e) {
      if (!this.disposed) { this.error = '配对已保存，无法继续首次设置，请重试'; }
    } finally { this.navigationBusy = false; }
  }

  async doPair(): Promise<void> {
    let offer = this.confirmedOffer;
    if (this.busy || this.disposed || !this.visible || !offer || this.pairedHostId.length > 0) {
      return;
    }
    let pairingStartedAt = Date.now();
    this.pairingStartedAt = pairingStartedAt;
    let navigationEpoch = this.navigationEpoch;
    this.busy = true; this.confirming = false; this.error = '';
    this.updateCamera();
    this.logs = [];
    this.timedOut = false;
    let attempt = new PairingConnection();
    this.attempt = attempt;
    this.deadline = setTimeout((): void => {
      this.timedOut = true; attempt.close();
    }, PAIR_TIMEOUT_MS);
    try {
      this.appendLog(this.t('正在验证配对信息…'));
      let endpoint = offer.endpoint;
      let connected = await attempt.connect(offer, (line: string): void => {
        if (!this.disposed) { this.appendLog(line); }
      });
      if (this.disposed) { return; }
      if (this.timedOut) { throw new Error('Pairing timed out'); }
      let client = connected.client;
      let hostName = endpoint;
      let capabilities: string[] = [];
      let status: ESObject = JSON.parse(connected.status.result);
      if (status && typeof status['machineName'] === 'string' && status['machineName'].length > 0) {
        hostName = status['machineName'];
      }
      if (status && Array.isArray(status['capabilities'])) {
        capabilities = (status['capabilities'] as string[]).filter((value: string): boolean => typeof value === 'string');
      }
      this.appendLog(`host: ${hostName}`);

      if (this.disposed) { return; }
      if (this.timedOut) { throw new Error('Pairing timed out'); }
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
      if (prepared) { await commitRelayPairing(getContext(this), meta, token, prepared, (): boolean => !this.disposed && !this.timedOut); }
      else { await saveHost(getContext(this), meta, token, undefined, pairingStartedAt); }
      refreshDesktopConnection(meta.id, 'paired');
      if (this.disposed) { return; }
      this.pairingCode = '';
      this.appendLog('配对成功');
      recordConnection(getContext(this), LOG_LEVEL_INFO, '桌面配对成功', '', meta.id).catch(() => {});
      attempt.close();
      this.confirmedOffer = null; this.pairedHostId = meta.id;
      await new Promise<void>((resolve): void => { setTimeout(resolve, PAIRED_HOLD_MS); });
      await this.continueAfterPair(meta.id);
    } catch (e) {
      if (this.disposed) { return; }
      this.confirmedOffer = null; this.decoded = false;
      this.error = this.timedOut ? '未能在 {{seconds}} 秒内连接，请查看下方日志' :
        (e as Error).message === PAIRING_CODE_REFUSED ? REJECTED_CODE : '配对失败，请检查配对码和网络连接后重试';
      this.appendLog(this.t(this.error).replace('{{seconds}}', String(PAIR_TIMEOUT_MS / 1000)));
      recordConnection(getContext(this), LOG_LEVEL_ERROR, '桌面配对失败', '', hostIdFor(offer.publicKeyB64)).catch(() => {});
    } finally {
      if (this.deadline >= 0) { clearTimeout(this.deadline); this.deadline = -1; }
      attempt.close();
      this.attempt = null;
      this.busy = false; this.updateCamera();
      if (!this.disposed && this.visible && navigationEpoch !== this.navigationEpoch
        && this.pairedHostId.length > 0 && !this.navigationBusy) {
        this.continueAfterPair(this.pairedHostId).catch(() => {});
      }
    }
  }

  @Builder
  private step(number: number, label: string) {
    Row({ space: 8 }) {
      Text(String(number)).fontFamily('Geist').fontSize(12).fontWeight(FontWeight.Bold)
        .fontColor(this.themeSecondary).textAlign(TextAlign.Center).width(22).height(22).borderRadius(11)
        .backgroundColor(this.themeScheme === 'light' ? '#f5f5f5' : '#262626')
      Text(this.t(label)).fontFamily('Geist').fontSize(14).fontColor(this.themeSecondary).layoutWeight(1)
    }.width('100%')
  }

  @Builder
  private primary(label: string, activate: () => void, fullWidth: boolean = false, enabled: boolean = true, qr: boolean = false) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 4 }) {
        if (qr) {
          Image($r('app.media.lucide_qr_code')).width(16).height(16).supportSvg2(true)
            .colorFilter(lucideColorFilter(this.themeBg))
        }
        Text(this.t(label)).fontFamily('Geist').fontSize(14).fontWeight(FontWeight.Medium).fontColor(this.themeBg)
      }.justifyContent(FlexAlign.Center)
    }
      .backgroundColor(this.themeText).borderRadius(12).constraintSize({ minHeight: 40 })
      .width(fullWidth ? '100%' : 'auto').padding({ left: 24, right: 24 })
      .enabled(enabled).opacity(enabled ? 1 : 0.48).accessibilityText(this.t(label)).onClick(activate)
  }

  @Builder
  private secondary(label: string, activate: () => void, clipboard: boolean = false) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 4 }) {
        if (clipboard) {
          Image($r('app.media.lucide_clipboard')).width(16).height(16).supportSvg2(true)
            .colorFilter(lucideColorFilter(this.themeSecondary))
        }
        Text(this.t(label)).fontFamily('Geist').fontSize(14).fontWeight(FontWeight.Medium).fontColor(this.themeSecondary)
      }.justifyContent(FlexAlign.Center)
    }.constraintSize({ minHeight: 40 }).borderRadius(12).backgroundColor(Color.Transparent)
      .accessibilityText(this.t(label)).onClick(activate)
  }

  @Builder
  private heading(title: string, description: string) {
    Text(this.t(title)).fontFamily('Geist').fontSize(24).fontWeight(FontWeight.Medium)
      .fontColor(this.themeText).textAlign(TextAlign.Center)
    Text(this.t(description)).fontFamily('Geist').fontSize(14).fontColor(this.themeSecondary)
      .textAlign(TextAlign.Center).lineHeight(20).constraintSize({ maxWidth: 360 }).margin({ bottom: 16 })
  }

  @Builder
  private pasteSheet() {
    Column({ space: 8 }) {
      Column() {
        Blank().width(36).height(5).borderRadius(3).backgroundColor(this.themeMuted).opacity(0.5)
      }.width('100%').height(20).justifyContent(FlexAlign.Center)
        .gesture(PanGesture({ direction: PanDirection.Down, distance: 12 }).onActionEnd((): void => this.closePaste()))
      Column({ space: 2 }) {
        Text(this.t('粘贴配对码')).fontFamily('Geist').fontSize(15).fontWeight(FontWeight.Medium).fontColor(this.themeText)
        Text(this.t('复制电脑上二维码下方显示的配对码。')).fontFamily('Geist').fontSize(13)
          .fontColor(this.themeMuted).lineHeight(18)
      }.alignItems(HorizontalAlign.Start).padding({ left: 4, right: 4, bottom: 4 })
      TextInput({ text: this.pairingCode, controller: this.pasteInput, placeholder: this.t('orca://pair?code=... 或粘贴配对码') })
        .fontFamily('Geist').fontSize(14).fontColor(this.themeText).placeholderColor(this.themeMuted)
        .backgroundColor(this.themeBg).border({ width: 1, color: this.themeBorder, radius: 12 }).height(44)
        .width('100%').id(PAIRING_CODE_FIELD).enterKeyType(EnterKeyType.Done).maxLength(132096)
        .onAppear((): void => {
          setTimeout((): void => {
            if (this.showPaste && this.visible) { this.getUIContext().getFocusController().requestFocus(PAIRING_CODE_FIELD); }
          }, 0);
        })
        .onChange((value: string): void => { this.pairingCode = value; })
        .onSubmit((): void => this.submitPaste())
      Row({ space: 8 }) {
        this.secondary('取消', (): void => this.closePaste())
        Button(this.t('保存'), { type: ButtonType.Normal })
          .fontFamily('Geist').fontSize(14).fontWeight(FontWeight.Medium).fontColor(this.themeBg)
          .backgroundColor(this.themeText).borderRadius(12).constraintSize({ minHeight: 40 })
          .padding({ left: 16, right: 16 }).enabled(this.pairingCode.trim().length > 0)
          .opacity(this.pairingCode.trim().length > 0 ? 1 : 0.4)
          .onClick((): void => this.submitPaste())
      }.width('100%').justifyContent(FlexAlign.End)
    }.width('100%').constraintSize({ maxWidth: 520 }).alignItems(HorizontalAlign.Start)
      .padding({ left: 12, right: 12, top: 8, bottom: 20 }).backgroundColor(this.themeSheet)
      .borderRadius({ topLeft: 24, topRight: 24 })
  }

  @Builder
  private pairingLog() {
    if (this.logs.length > 0) {
      Column({ space: 4 }) {
        Text(this.t('配对日志')).fontFamily('monospace').fontSize(11).fontColor(this.themeMuted).letterSpacing(1)
        Scroll(this.logScroll) {
          Column({ space: 6 }) {
            ForEach(this.logs, (line: string): void => {
              Text(line).fontFamily('monospace').fontSize(11).fontColor(this.themeSecondary).maxLines(3)
            }, (line: string, index: number): string => `${index}-${line}`)
          }.width('100%').alignItems(HorizontalAlign.Start)
            .onSizeChange((): void => this.logScroll.scrollEdge(Edge.Bottom))
        }.scrollBar(BarState.Off).constraintSize({ maxHeight: 200 }).width('100%')
      }.alignItems(HorizontalAlign.Start).width('100%').constraintSize({ maxWidth: 520 })
        .padding({ left: 12, right: 12, top: 8, bottom: 8 }).backgroundColor(this.themeSurface)
        .border({ width: 0.5, radius: 16, color: this.themeBorder }).margin({ top: 8, bottom: 12 })
    }
  }

  @Builder
  private scanPreview() {
    Column() {
      Stack() {
        if (this.showCamera) {
          PairingCamera({ decoded: this.decoded,
            onCode: (code: string): void => this.acceptOffer(code, false, true),
            onFailure: (): void => { this.cameraFailed = true; this.updateCamera(); } })
        }
      }.width('100%').layoutWeight(1).borderRadius(16).clip(true).backgroundColor(this.themeSurface)
      this.secondary('或粘贴配对码', (): void => this.openPaste(), true)
    }.width('100%').layoutWeight(1)
  }

  @Builder
  private centeredContent() {
    Column({ space: 8 }) {
      if (this.confirming) {
        this.heading('要与这台桌面配对吗？', '你打开了来自桌面的配对链接。确认后会将它添加到你的主机。')
        Column({ space: 8 }) {
          this.primary('配对', (): void => { this.doPair().catch(() => {}); }, true)
          this.secondary('取消', (): void => { this.onBackPress(); })
        }.width('100%').constraintSize({ maxWidth: 360 })
      } else if (this.pairedHostId && !this.error) {
        Image($r('app.media.lucide_check')).width(36).height(36).padding(7).supportSvg2(true)
          .colorFilter(lucideColorFilter(this.themeBg)).borderRadius(18)
          .backgroundColor(this.themeScheme === 'light' ? '#147638' : '#86efac')
        Text(this.t('已连接')).fontFamily('Geist').fontSize(14).fontColor(this.themeSecondary).margin({ top: 8 })
        this.pairingLog()
      } else if (this.error) {
        Text(this.t(this.error).replace('{{seconds}}', String(PAIR_TIMEOUT_MS / 1000)))
          .fontFamily('Geist').fontSize(14).fontColor(this.themeScheme === 'light' ? '#b91c1c' : '#ff6568')
          .textAlign(TextAlign.Center).lineHeight(20).constraintSize({ maxWidth: 360 })
        this.pairingLog()
        if (this.pairedHostId) {
          this.primary('继续首次设置', (): void => { this.continueAfterPair(this.pairedHostId).catch(() => {}); })
        } else if (this.openedFromLink) {
          this.primary('返回首页', (): void => { this.onBackPress(); })
        } else {
          this.primary('重试', (): void => this.retry())
          this.secondary('改为粘贴配对码', (): void => this.openPaste(), true)
        }
      } else if (this.busy) {
        LoadingProgress().width(36).height(36).color(this.themeSecondary)
        Text(this.t('正在连接…')).fontFamily('Geist').fontSize(14).fontColor(this.themeSecondary).margin({ top: 8 })
        this.pairingLog()
      } else if (this.cameraFailed) {
        this.heading('无法启动相机', '你可以重试扫码，或改为粘贴配对码。')
        this.primary('重试', (): void => this.retry())
        this.secondary('改为粘贴配对码', (): void => this.openPaste(), true)
      } else {
        this.heading(this.permission === abilityAccessCtrl.PermissionStatus.NOT_DETERMINED ? '与桌面配对' : '相机权限已关闭',
          this.permission === abilityAccessCtrl.PermissionStatus.NOT_DETERMINED
            ? '扫描电脑上 Orca 显示的二维码，或改为粘贴配对码。' : '在设置中启用相机访问，或改为粘贴配对码。')
        this.primary(this.permission === abilityAccessCtrl.PermissionStatus.NOT_DETERMINED ? '继续' : '打开设置',
          (): void => { this.requestCamera().catch(() => {}); }, false, !this.permissionBusy,
          this.permission === abilityAccessCtrl.PermissionStatus.NOT_DETERMINED)
        this.secondary('改为粘贴配对码', (): void => this.openPaste(), true)
      }
    }.layoutWeight(1).width('100%').justifyContent(FlexAlign.Center).padding({ bottom: this.openedFromLink ? 48 : 0 })
  }

  @Builder
  private pairingContent() {
    Column({ space: 8 }) {
      Row() {
        Button({ type: ButtonType.Normal }) {
          Image($r('app.media.lucide_chevron_left')).width(22).height(22).supportSvg2(true)
            .colorFilter(lucideColorFilter(this.themeSecondary))
        }.width(36).height(36).borderRadius(12).backgroundColor(Color.Transparent)
          .accessibilityText(this.t('返回')).onClick((): void => {
            if (!this.onBackPress()) { router.back(); }
          })
      }.width('100%')
      if (!this.openedFromLink && this.permission === abilityAccessCtrl.PermissionStatus.GRANTED) {
        Column({ space: 8 }) {
          this.step(1, '在电脑上打开 Orca')
          this.step(2, '前往设置 → 移动端')
          this.step(3, '扫描二维码')
        }.width('100%').padding({ left: 7, bottom: 8 })
      }
      if (!this.openedFromLink && this.permission === abilityAccessCtrl.PermissionStatus.GRANTED &&
        !this.busy && !this.pairedHostId && !this.error && !this.cameraFailed) {
        this.scanPreview()
      } else {
        this.centeredContent()
      }
    }.width('100%').height('100%').padding({ left: 16, right: 16, top: 8, bottom: 8 }).backgroundColor(this.themeBg)
      .accessibilityLevel(this.showPaste ? 'no-hide-descendants' : 'auto')
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      this.pairingContent()
      if (this.showPaste) {
        Blank().width('100%').height('100%').backgroundColor('rgba(0, 0, 0, 0.55)')
          .accessibilityLevel('no').onClick((): void => this.closePaste())
        this.pasteSheet()
      }
    }.width('100%').height('100%').backgroundColor(this.themeBg)
  }
}
