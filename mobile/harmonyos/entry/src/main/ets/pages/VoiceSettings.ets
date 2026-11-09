import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { i18n } from '@kit.LocalizationKit';
import { modelInFlight, SpeechModel, VoiceConfig, VoiceSettingsRpc, VoiceSetup } from '../dictation/VoiceSetup';
import { lucideColorFilter } from '../settings/LucideColor';
import { uiText } from '../settings/NativeUi';
import {
  readDictationEngine, setString, KEY_DICTATION_ENGINE, DICTATION_ENGINE_OPTIONS,
  DICTATION_ENGINE_AUTOMATIC, DICTATION_ENGINE_ONDEVICE, OptionEntry
} from '../settings/SettingsStore';
import { HostMeta, listHosts } from '../storage/HostStore';
import { DesktopConnectionLease, retainDesktopConnection } from '../transport/DesktopConnections';
import { SpikeRpcClient } from '../transport/SpikeRpcClient';
import { NativeSpeech } from '../webshell/NativeSpeech';

interface VoiceDesktop { id: string; lease: DesktopConnectionLease; unobserve: () => void; }
const MODEL_POLL_MS = 1500;
const PHONE_RECHECK_MS = 3000;

@Entry
@Component
struct VoiceSettings {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeScheme') themeScheme: string = 'dark';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeSheet') themeSheet: string = '#171717';
  @StorageProp('themeBorder') themeBorder: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeAccent') themeAccent: string = '#3276f2';
  @State engine: string = DICTATION_ENGINE_AUTOMATIC;
  @State engineBusy: boolean = true;
  @State engineError: string = '';
  @State phoneStatus: string = 'checking';
  @State connecting: boolean = true;
  @State connected: boolean = false;
  @State loading: boolean = false;
  @State setup: VoiceSetup | null = null;
  @State loadError: string = '';
  @State changeError: string = '';
  @State busyAction: string = '';
  @State modelsOpen: boolean = false;
  private shown: boolean = false;
  private pageEpoch: number = 0;
  private requestEpoch: number = 0;
  private desktops: VoiceDesktop[] = [];
  private hostId: string = '';
  private client: SpikeRpcClient | null = null;
  private phone: NativeSpeech | null = null;
  private phoneTimer: number = -1;
  private modelTimer: number = -1;
  private downloadGraceUntil: number = 0;

  onPageShow(): void {
    this.shown = true;
    let epoch = ++this.pageEpoch;
    let context = getContext(this) as common.UIAbilityContext;
    this.engineBusy = true; this.engineError = ''; this.connecting = true;
    readDictationEngine(context).then((value: string): void => {
      if (epoch === this.pageEpoch) { this.engine = value; }
    }).catch((): void => {
      if (epoch === this.pageEpoch) { this.engineError = '无法读取语音设置'; }
    }).finally((): void => { if (epoch === this.pageEpoch) { this.engineBusy = false; } });
    this.checkPhone(epoch);
    listHosts(context).then((hosts: HostMeta[]): void => {
      if (epoch !== this.pageEpoch) { return; }
      this.desktops = hosts.map((host: HostMeta): VoiceDesktop =>
        ({ id: host.id, lease: retainDesktopConnection(context, host.id), unobserve: (): void => {} }));
      this.desktops.forEach((desktop: VoiceDesktop): void => {
        desktop.unobserve = desktop.lease.connection.observe((): void => this.selectDesktop());
        desktop.lease.connection.connect();
      });
      this.selectDesktop();
    }).catch((): void => {
      if (epoch === this.pageEpoch) { this.connecting = false; this.loadError = '无法读取已配对桌面'; }
    });
  }

  onPageHide(): void { this.stop(); }
  aboutToDisappear(): void { this.stop(); }

  private stop(): void {
    this.shown = false; this.pageEpoch++; this.requestEpoch++;
    if (this.phoneTimer >= 0) { clearTimeout(this.phoneTimer); this.phoneTimer = -1; }
    this.phone?.dispose(); this.phone = null;
    this.stopPolling();
    this.desktops.forEach((desktop: VoiceDesktop): void => { desktop.unobserve(); desktop.lease.release(); });
    this.desktops = []; this.client = null; this.hostId = ''; this.setup = null; this.connected = false;
    this.modelsOpen = false; this.loading = false; this.busyAction = ''; this.loadError = ''; this.changeError = '';
    this.downloadGraceUntil = 0;
  }

  private stopPolling(): void {
    if (this.modelTimer >= 0) { clearTimeout(this.modelTimer); this.modelTimer = -1; }
  }

  private checkPhone(epoch: number): void {
    let speech = new NativeSpeech(getContext(this) as common.UIAbilityContext);
    this.phone = speech;
    this.phoneStatus = 'checking';
    let locale = i18n.System.getPreferredLanguageList()[0] ?? i18n.System.getSystemLanguage();
    speech.serve({ action: 'status', locale: locale }).then((value: ESObject): void => {
      if (epoch !== this.pageEpoch) { return; }
      this.phoneStatus = value['status'] === 'ready' ? 'ready' : value['status'] === 'busy' ? 'checking' : 'unsupported';
      if (this.phoneStatus === 'checking') {
        this.phoneTimer = setTimeout((): void => { this.phoneTimer = -1; this.checkPhone(epoch); }, PHONE_RECHECK_MS);
      }
    }).catch((): void => {
      if (epoch === this.pageEpoch) { this.phoneStatus = 'unsupported'; }
    }).finally((): void => { speech.dispose(); if (this.phone === speech) { this.phone = null; } });
  }

  private async selectEngine(value: string): Promise<void> {
    if (this.engineBusy || value === this.engine || !this.engineAvailable(value)) { return; }
    let epoch = this.pageEpoch;
    this.engineBusy = true; this.engineError = '';
    try {
      await setString(getContext(this), KEY_DICTATION_ENGINE, value);
      if (epoch === this.pageEpoch) { this.engine = value; }
    } catch (e) { if (epoch === this.pageEpoch) { this.engineError = '无法保存语音设置，请重试'; } }
    finally { if (epoch === this.pageEpoch) { this.engineBusy = false; } }
  }

  private selectDesktop(): void {
    if (!this.shown) { return; }
    let ready = this.desktops.find((desktop: VoiceDesktop): boolean => desktop.lease.connection.getClient() !== null);
    this.connecting = !ready && this.desktops.some((desktop: VoiceDesktop): boolean =>
      ['idle', 'connecting', 'reconnecting'].includes(desktop.lease.connection.getPhase()));
    let client = ready?.lease.connection.getClient() ?? null;
    if (client === this.client) { return; }
    this.requestEpoch++; this.stopPolling();
    this.client = client; this.connected = client !== null; this.loading = false; this.busyAction = '';
    if (ready && ready.id !== this.hostId) {
      this.hostId = ready.id; this.setup = null; this.modelsOpen = false;
      this.loadError = ''; this.changeError = ''; this.downloadGraceUntil = 0;
    }
    if (client) { this.refresh().catch(() => {}); }
  }

  private async refresh(): Promise<void> {
    let client = this.client;
    if (!client || this.loading || this.busyAction) { return; }
    let epoch = this.requestEpoch;
    this.stopPolling(); this.loading = true;
    try {
      let setup = await new VoiceSettingsRpc(client).load();
      if (epoch === this.requestEpoch) { this.setup = setup; this.loadError = ''; }
    } catch (e) {
      if (epoch === this.requestEpoch) { this.loadError = (e as Error).message || '无法加载语音设置'; }
    } finally {
      if (epoch === this.requestEpoch) {
        this.loading = false;
        if (this.setup?.models.some(modelInFlight) || Date.now() < this.downloadGraceUntil) {
          this.modelTimer = setTimeout((): void => { this.modelTimer = -1; this.refresh().catch(() => {}); }, MODEL_POLL_MS);
        }
      }
    }
  }

  private async change(action: string, id: string, config: VoiceConfig = {}): Promise<void> {
    let client = this.client;
    if (!client || this.busyAction || !this.setup) { return; }
    let epoch = ++this.requestEpoch;
    let rpc = new VoiceSettingsRpc(client);
    this.stopPolling(); this.loading = false; this.busyAction = id || action; this.changeError = '';
    try {
      let next: VoiceSetup | null = null;
      if (action === 'download') {
        await rpc.download(id);
        if (epoch === this.requestEpoch) { this.downloadGraceUntil = Date.now() + 3 * MODEL_POLL_MS; }
      } else if (action === 'delete') { next = await rpc.delete(id); }
      else { next = await rpc.configure(config); }
      if (epoch !== this.requestEpoch) { return; }
      if (next) {
        if (action === 'use' || (action === 'delete' && this.setup.selectedModelId === id)) { this.modelsOpen = false; }
        this.setup = next; this.loadError = '';
      }
    } catch (e) {
      if (epoch !== this.requestEpoch) { return; }
      let fallback = action === 'download' ? '下载失败' : action === 'delete' ? '删除失败' :
        action === 'use' ? '无法选择模型' : '无法更新语音设置';
      this.changeError = (e as Error).message || fallback;
    } finally {
      if (epoch === this.requestEpoch) {
        // Read the desktop's state after an ambiguous reply. Writes are never replayed.
        this.busyAction = '';
        this.refresh().catch(() => {});
      }
    }
  }

  private t(label: string): string { return uiText(label, this.uiLocale); }
  private engineAvailable(value: string): boolean { return value !== DICTATION_ENGINE_ONDEVICE || this.phoneStatus !== 'unsupported'; }
  private canConfigure(): boolean { return this.connected && this.busyAction === ''; }
  private canChooseModel(): boolean { return this.canConfigure() && this.setup?.enabled === true; }
  private model(id: string): SpeechModel | undefined {
    return this.setup?.models.find((model: SpeechModel): boolean => model.id === id);
  }
  private modelAction(id: string): string {
    let model = this.model(id);
    if (!model) { return ''; }
    if (model.status === 'ready') { return model.id === this.setup?.selectedModelId ? 'selected' : 'use'; }
    if (model.provider === 'openai') { return 'key'; }
    if (modelInFlight(model)) { return 'progress'; }
    return model.provider === 'local' && ['error', 'not-downloaded'].includes(model.status) ? 'download' : '';
  }
  private modelDetails(id: string): string {
    let model = this.model(id);
    if (!model) { return ''; }
    if (model.provider === 'openai') { return 'OpenAI API'; }
    let size = model.sizeBytes > 0 ? `${Math.round(model.sizeBytes / 1_000_000)} MB` : '';
    if (modelInFlight(model) && model.progress !== null) { return [size, `${Math.round(model.progress * 100)}%`].filter(Boolean).join(' · '); }
    if (model.status === 'extracting') { return [size, this.t('正在解压…')].filter(Boolean).join(' · '); }
    if (model.status === 'error') { return [size, this.t('下载失败')].filter(Boolean).join(' · '); }
    return size;
  }

  @Builder
  private title(label: string) {
    Text(this.t(label)).fontFamily('Geist').fontSize(11).fontWeight(FontWeight.Medium)
      .fontColor(this.themeMuted).letterSpacing(0.5).width('100%').padding({ left: 16, bottom: 8 })
  }

  @Builder
  private note(label: string, error: boolean = false) {
    Text(this.t(label)).fontFamily('Geist').fontSize(13).lineHeight(18)
      .fontColor(error ? (this.themeScheme === 'light' ? '#b91c1c' : '#ff6568') : this.themeSecondary)
      .width('100%').padding({ top: 8, left: 16, right: 16 })
  }

  @Builder
  private separator() {
    Row().width('100%').height(0.5).backgroundColor(this.themeBorder).margin({ left: 16 })
  }

  @Builder
  private engineRow(option: OptionEntry) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Column({ space: 4 }) {
          Text(this.t(option.label)).fontFamily('Geist').fontSize(16).fontColor(this.themeText)
          if (option.value === DICTATION_ENGINE_ONDEVICE) {
            Text(this.t(this.phoneStatus === 'ready' ? '此手机已就绪' : this.phoneStatus === 'checking' ?
              '正在检查…' : '此手机不可用')).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
          }
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        if (this.engine === option.value) {
          Image($r('app.media.lucide_check')).supportSvg2(true).width(18).height(18)
            .colorFilter(lucideColorFilter(this.themeAccent))
        }
      }.width('100%').padding({ left: 16, right: 16, top: 12, bottom: 12 })
    }.width('100%').constraintSize({ minHeight: 48 }).backgroundColor(Color.Transparent)
      .enabled(!this.engineBusy && this.engineAvailable(option.value))
      .opacity(this.engineAvailable(option.value) ? 1 : 0.5)
      .accessibilitySelected(this.engine === option.value).onClick((): void => { this.selectEngine(option.value).catch(() => {}); })
  }

  @Builder
  private transcription() {
    Column() {
      this.title('转写位置')
      Column() {
        ForEach(DICTATION_ENGINE_OPTIONS, (option: OptionEntry, index: number): void => {
          if (index > 0) { this.separator() }
          this.engineRow(option)
        }, (option: OptionEntry): string => option.value)
      }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
      this.note('在此手机上转写时，音频保留在手机上。自动模式会在手机无法转写时使用电脑。')
      if (this.engineError) { this.note(this.engineError, true) }
    }.width('100%')
  }

  @Builder
  private mode(value: string, label: string) {
    Button(this.t(label), { type: ButtonType.Normal }).fontFamily('Geist').fontSize(12)
      .fontWeight(FontWeight.Medium).fontColor(this.setup?.dictationMode === value ? this.themeText : this.themeSecondary)
      .height(30).padding({ left: 11, right: 11 }).borderRadius(8)
      .backgroundColor(this.setup?.dictationMode === value ? this.themeBg : Color.Transparent)
      .accessibilitySelected(this.setup?.dictationMode === value)
      .enabled(this.canChooseModel()).onClick((): void => {
        if (this.setup?.dictationMode !== value) { this.change('configure', '', { dictationMode: value }).catch(() => {}); }
      })
  }

  @Builder
  private desktopOptions() {
    Column() {
      this.title('听写')
      Column() {
        Row({ space: 12 }) {
          Column({ space: 4 }) {
            Text(this.t('启用语音听写')).fontFamily('Geist').fontSize(16).fontColor(this.themeText)
            Text(this.t('在电脑上向任何获得焦点的窗格听写文本。')).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
          }.alignItems(HorizontalAlign.Start).layoutWeight(1)
          Toggle({ type: ToggleType.Switch, isOn: this.setup?.enabled === true }).selectedColor(this.themeAccent)
            .enabled(this.canConfigure()).accessibilityText(this.t('启用语音听写')).id('voice-enabled')
            .onChange((on: boolean): void => {
              if (on !== this.setup?.enabled) { this.change('configure', '', { enabled: on }).catch(() => {}); }
            })
        }.width('100%').constraintSize({ minHeight: 52 }).padding(16)
        this.separator()
        Row({ space: 10 }) {
          Text(this.t('听写模式')).fontFamily('Geist').fontSize(16).fontColor(this.themeText).layoutWeight(1)
          Row({ space: 2 }) {
            this.mode('toggle', '切换')
            this.mode('hold', '按住')
          }.padding(3).borderRadius(10).backgroundColor(this.themeSheet)
        }.width('100%').constraintSize({ minHeight: 50 }).padding({ left: 16, right: 16 })
          .opacity(this.setup?.enabled === true ? 1 : 0.45)
      }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
      this.note('切换：按一次开始，再按一次停止。按住：按住期间进行听写。')
    }.width('100%')
    Column() {
      this.title('语音模型')
      Button({ type: ButtonType.Normal }) {
        Row({ space: 12 }) {
          Column({ space: 4 }) {
            Text(this.t('语音模型')).fontFamily('Geist').fontSize(16).fontColor(this.themeText)
            Text(this.model(this.setup?.selectedModelId ?? '')?.label ?? this.t('未选择模型'))
              .fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
          }.alignItems(HorizontalAlign.Start).layoutWeight(1)
          Image($r('app.media.lucide_chevron_right')).supportSvg2(true).width(16).height(16)
            .colorFilter(lucideColorFilter(this.themeMuted))
        }.width('100%').padding(16)
      }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).enabled(this.canChooseModel())
        .opacity(this.setup?.enabled === true ? 1 : 0.45)
        .onClick((): void => { this.modelsOpen = true; })
      if (this.changeError || this.loadError) { this.note(this.changeError || this.loadError, true) }
    }.width('100%')
  }

  @Builder
  private modelButton(id: string, action: string, label: string) {
    Button({ type: ButtonType.Normal }) {
      if (this.busyAction === id) {
        LoadingProgress().width(18).height(18).color(this.themeSecondary)
      } else if (action === 'delete') {
        Image($r('app.media.lucide_trash_2')).supportSvg2(true).width(18).height(18)
          .colorFilter(lucideColorFilter(this.themeScheme === 'light' ? '#b91c1c' : '#ff6568'))
      } else if (action === 'download') {
        Image($r('app.media.lucide_download')).supportSvg2(true).width(18).height(18)
          .colorFilter(lucideColorFilter(this.themeSecondary))
      } else {
        Text(this.t(label)).fontFamily('Geist').fontSize(12).fontWeight(FontWeight.Medium).fontColor(this.themeSecondary)
      }
    }.constraintSize({ minWidth: 42, minHeight: 40 }).padding({ left: 8, right: 8 })
      .borderRadius(10).backgroundColor(this.themeSheet).enabled(this.canChooseModel())
      .id(`voice-${action}-${id}`).accessibilityText(`${this.t(label)} ${this.model(id)?.label ?? id}`)
      .onClick((): void => {
        this.change(action, id, action === 'use' ? { enabled: true, modelId: id } : {}).catch(() => {});
      })
  }

  @Builder
  private modelRow(id: string) {
    Row({ space: 8 }) {
      Column({ space: 3 }) {
        Text(this.model(id)?.label ?? id).fontFamily('Geist').fontSize(15).fontColor(this.themeText)
        if (this.modelDetails(id)) {
          Text(this.modelDetails(id)).fontFamily('Geist').fontSize(12).fontColor(this.themeSecondary)
        }
        if (this.model(id)?.recommended === true) {
          Text(this.t('推荐')).fontFamily('Geist').fontSize(11).fontWeight(FontWeight.Medium)
            .fontColor(this.themeScheme === 'light' ? '#147638' : '#86efac')
        }
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      if (this.modelAction(id) === 'selected') {
        Text(this.t('使用中')).fontFamily('Geist').fontSize(12)
          .fontColor(this.themeScheme === 'light' ? '#147638' : '#86efac')
      } else if (this.modelAction(id) === 'use') {
        this.modelButton(id, 'use', '使用')
      } else if (this.modelAction(id) === 'download') {
        this.modelButton(id, 'download', '下载')
      } else if (this.modelAction(id) === 'progress') {
        LoadingProgress().width(18).height(18).color(this.themeSecondary)
      } else if (this.modelAction(id) === 'key') {
        Text(this.t('需要 OpenAI 密钥')).fontFamily('Geist').fontSize(12).fontColor(this.themeMuted)
      }
      if (this.model(id)?.provider === 'local' && this.model(id)?.status === 'ready') {
        this.modelButton(id, 'delete', '删除')
      }
    }.width('100%').constraintSize({ minHeight: 56 }).padding({ left: 14, right: 10, top: 8, bottom: 8 })
  }

  @Builder
  private modelDrawer() {
    Column({ space: 10 }) {
      Text(this.t('语音模型')).fontFamily('Geist').fontSize(16).fontWeight(FontWeight.Medium)
        .fontColor(this.themeText).width('100%').padding({ left: 4 })
      if (this.changeError || this.loadError) { this.note(this.changeError || this.loadError, true) }
      if (!this.connected) { this.note('连接桌面后可管理语音设置。') }
      Scroll() {
        Column() {
          ForEach(this.setup?.models ?? [], (model: SpeechModel, index: number): void => {
            if (index > 0) { this.separator() }
            this.modelRow(model.id)
          }, (model: SpeechModel): string => model.id)
        }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top)
    }.width('100%').height('100%').padding({ left: 16, right: 16, bottom: 20, top: 8 })
  }

  build() {
    Column() {
      Row() {
        Button({ type: ButtonType.Circle }) {
          Image($r('app.media.lucide_chevron_left')).supportSvg2(true).width(22).height(22)
            .colorFilter(lucideColorFilter(this.themeText))
        }.width(44).height(44).backgroundColor(this.themeSurface)
          .accessibilityText(this.t('返回')).onClick(() => router.back())
        Text(this.t('语音')).fontFamily('Geist').fontSize(17).fontWeight(FontWeight.Medium)
          .fontColor(this.themeText).layoutWeight(1).textAlign(TextAlign.Center)
        Row().width(44)
      }.width('100%').height(54).padding({ left: 16, right: 16 })

      Scroll() {
        Column({ space: 20 }) {
          this.transcription()
          if (this.connected && this.setup !== null) {
            this.desktopOptions()
          } else if (this.connecting || this.loading) {
            LoadingProgress().width(24).height(24).color(this.themeSecondary)
            this.note('正在加载语音设置…')
          } else if (this.loadError) {
            this.note(this.loadError, true)
            if (this.connected) {
              Button(this.t('重试')).fontFamily('Geist').fontSize(14).fontColor(this.themeText)
                .backgroundColor(this.themeSurface).onClick((): void => { this.refresh().catch(() => {}); })
            }
          } else {
            this.note('连接桌面后可管理语音设置。')
          }
        }.width('100%').padding({ top: 8, left: 16, right: 16, bottom: 24 })
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top)
    }.width('100%').height('100%').backgroundColor(this.themeBg)
      .bindSheet(this.modelsOpen, this.modelDrawer, { height: '75%', backgroundColor: this.themeSheet,
        maskColor: 'rgba(0,0,0,0.55)', showClose: false, onDisappear: (): void => { this.modelsOpen = false; } })
  }
}
