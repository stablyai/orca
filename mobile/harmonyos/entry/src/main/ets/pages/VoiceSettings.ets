import { common } from '@kit.AbilityKit';
import { i18n } from '@kit.LocalizationKit';
import { endpointLabel } from '../diagnostics/ConnectionDiagnostics';
import { modelInFlight, SpeechModel, VoiceConfig, VoiceSettingsRpc, VoiceSetup, voiceShortcutMode,
  voiceShortcutModeConfig } from '../dictation/VoiceSetup';
import { lucideColorFilter } from '../settings/LucideColor';
import { uiText } from '../settings/NativeUi';
import { SettingsNavBar } from '../settings/SettingsNavBar';
import {
  readDictationEngine, setString, KEY_DICTATION_ENGINE, DICTATION_ENGINE_OPTIONS,
  DICTATION_ENGINE_AUTOMATIC, DICTATION_ENGINE_ONDEVICE, OptionEntry
} from '../settings/SettingsStore';
import { HostMeta, listHosts } from '../storage/HostStore';
import { DesktopConnectionLease, retainDesktopConnection } from '../transport/DesktopConnections';
import { SpikeRpcClient } from '../transport/SpikeRpcClient';
import { NativeSpeech } from '../webshell/NativeSpeech';

interface VoiceDesktop { id: string; lease: DesktopConnectionLease; unobserve: () => void; }
interface VoiceAction { kind: string; modelId: string; }
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
  @StorageProp('themeRaised') themeRaised: string = '#262626';
  @StorageProp('themeBorder') themeBorder: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeAccent') themeAccent: string = '#3276f2';
  @StorageProp('themeStatusRed') themeStatusRed: string = '#ff6568';
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
  @State busyAction: VoiceAction | null = null;
  @State modelsOpen: boolean = false;
  @State desktopPickerOpen: boolean = false;
  @State hosts: HostMeta[] = [];
  @State hostId: string = '';
  @State viewportHeight: number = 0;
  private shown: boolean = false;
  private pageEpoch: number = 0;
  private requestEpoch: number = 0;
  private desktops: VoiceDesktop[] = [];
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
      this.hosts = hosts;
      if (!this.hostId && hosts.length === 1) { this.hostId = hosts[0].id; }
      this.desktops = hosts.map((host: HostMeta): VoiceDesktop =>
        ({ id: host.id, lease: retainDesktopConnection(context, host.id, 'automatic'), unobserve: (): void => {} }));
      this.desktops.forEach((desktop: VoiceDesktop): void => {
        desktop.unobserve = desktop.lease.connection.observe((): void => this.selectDesktop());
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
    this.desktops = []; this.client = null; this.hosts = []; this.setup = null; this.connected = false;
    this.modelsOpen = false; this.desktopPickerOpen = false; this.loading = false; this.busyAction = null;
    this.loadError = ''; this.changeError = '';
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
    let desktop = this.desktops.find((candidate: VoiceDesktop): boolean => candidate.id === this.hostId);
    let client = desktop?.lease.connection.getClient() ?? null;
    this.connecting = desktop !== undefined && client === null &&
      ['idle', 'connecting', 'handshaking', 'reconnecting'].includes(desktop.lease.connection.getPhase());
    if (client === this.client) { return; }
    this.requestEpoch++; this.stopPolling();
    this.client = client; this.connected = client !== null; this.loading = false; this.busyAction = null;
    if (client) { this.refresh().catch(() => {}); }
  }

  private pickDesktop(id: string): void {
    if (!this.shown || this.busyAction || !this.hosts.some((host: HostMeta): boolean => host.id === id)) { return; }
    this.desktopPickerOpen = false;
    if (id === this.hostId) { return; }
    this.requestEpoch++; this.stopPolling();
    this.hostId = id; this.client = null; this.setup = null; this.connected = false; this.modelsOpen = false;
    this.loading = false; this.loadError = ''; this.changeError = ''; this.downloadGraceUntil = 0;
    this.selectDesktop();
  }

  private selectedDesktop(): HostMeta | undefined {
    return this.hosts.find((host: HostMeta): boolean => host.id === this.hostId);
  }

  private desktopName(): string { return this.selectedDesktop()?.name ?? this.t('选择桌面'); }

  private desktopAddress(): string {
    let host = this.selectedDesktop();
    return host ? endpointLabel(host.endpoint) : '';
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
    if (!this.canConfigure() || !client || !this.setup) { return; }
    let epoch = ++this.requestEpoch;
    let rpc = new VoiceSettingsRpc(client);
    this.stopPolling(); this.loading = false; this.busyAction = { kind: action, modelId: id }; this.changeError = '';
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
        this.busyAction = null;
        this.refresh().catch(() => {});
      }
    }
  }

  private t(label: string): string { return uiText(label, this.uiLocale); }
  private engineAvailable(value: string): boolean { return value !== DICTATION_ENGINE_ONDEVICE || this.phoneStatus !== 'unsupported'; }
  private canConfigure(): boolean {
    return this.connected && this.client !== null && this.setup !== null && this.busyAction === null
      && this.desktops.find((desktop: VoiceDesktop): boolean => desktop.id === this.hostId)?.lease.connection.getClient() === this.client;
  }
  private canChooseModel(): boolean { return this.canConfigure() && this.setup?.enabled === true; }
  private offersAuto(): boolean { return this.setup?.dictationHoldToRecord !== undefined; }
  private model(id: string): SpeechModel | undefined {
    return this.setup?.models.find((model: SpeechModel): boolean => model.id === id);
  }
  private modelAction(model: SpeechModel, selectedModelId: string | undefined): string {
    if (model.status === 'ready') { return model.id === selectedModelId ? 'selected' : 'use'; }
    if (model.provider === 'openai') { return 'key'; }
    return modelInFlight(model) ? 'progress' : 'download';
  }
  private modelDetails(model: SpeechModel, locale: string): string {
    if (model.provider === 'openai') { return 'OpenAI API'; }
    let intlLocale = locale === 'pt' ? 'pt-BR' : locale === 'zh' ? 'zh-Hans' : locale;
    let size = model.sizeBytes > 0 ? uiText('components.voiceModelList.modelSize', locale)
      .replace('{{size}}', Math.round(model.sizeBytes / 1_000_000).toLocaleString(intlLocale)) : '';
    if (modelInFlight(model) && model.progress !== null) {
      return uiText('components.voiceModelList.modelProgress', locale).replace('{{size}}', size)
        .replace('{{progress}}', Math.round(model.progress * 100).toLocaleString(intlLocale));
    }
    if (model.status === 'extracting') {
      return uiText('components.voiceModelList.modelExtracting', locale).replace('{{size}}', size);
    }
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
  private desktopSelector() {
    if (this.hosts.length > 0) {
      Column() {
        this.title('已配对桌面')
        Button({ type: ButtonType.Normal }) {
          Row({ space: 12 }) {
            Image($r('app.media.lucide_monitor')).supportSvg2(true).width(18).height(18)
              .colorFilter(lucideColorFilter(this.themeSecondary))
            Column({ space: 3 }) {
              Text(this.desktopName()).fontFamily('Geist').fontSize(16).fontColor(this.themeText).maxLines(1)
              if (this.desktopAddress()) {
                Text(this.desktopAddress()).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
                  .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
              }
            }.alignItems(HorizontalAlign.Start).layoutWeight(1)
            if (this.hosts.length > 1 || !this.selectedDesktop()) {
              Image($r('app.media.lucide_chevron_down')).supportSvg2(true).width(16).height(16)
                .colorFilter(lucideColorFilter(this.themeMuted))
            }
          }.width('100%').padding(16)
        }.width('100%').backgroundColor(this.themeSurface).borderRadius(16)
          .enabled((this.hosts.length > 1 || !this.selectedDesktop()) && this.busyAction === null)
          .accessibilityText(this.desktopName()).id('voice-desktop-picker')
          .onClick((): void => { this.desktopPickerOpen = true; })
      }.width('100%')
    }
  }

  @Builder
  private desktopPicker() {
    Column() {
      this.title('选择桌面')
      List() {
        ForEach(this.hosts, (host: HostMeta, index: number) => {
          ListItem() {
            Column() {
              if (index > 0) { this.separator() }
              Button({ type: ButtonType.Normal }) {
                Row({ space: 12 }) {
                  Column({ space: 3 }) {
                    Text(host.name).fontFamily('Geist').fontSize(16).fontColor(this.themeText).maxLines(1)
                    Text(endpointLabel(host.endpoint)).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
                      .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
                  }.alignItems(HorizontalAlign.Start).layoutWeight(1)
                  if (host.id === this.hostId) {
                    Image($r('app.media.lucide_check')).supportSvg2(true).width(18).height(18)
                      .colorFilter(lucideColorFilter(this.themeAccent))
                  }
                }.width('100%').padding({ left: 16, right: 16 })
              }.width('100%').height(56).backgroundColor(Color.Transparent).enabled(this.busyAction === null)
                .accessibilitySelected(host.id === this.hostId).onClick((): void => { this.pickDesktop(host.id); })
            }.width('100%')
          }
        }, (host: HostMeta): string => host.id)
      }.height(Math.min(this.hosts.length, 4) * 56.5).width('100%').backgroundColor(this.themeSurface)
        .borderRadius(16).clip(true).scrollBar(BarState.Auto)
    }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 20 })
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
      .fontWeight(FontWeight.Medium).fontColor(voiceShortcutMode(this.setup) === value ? this.themeText : this.themeSecondary)
      .height(30).padding({ left: 11, right: 11 }).borderRadius(8)
      .backgroundColor(voiceShortcutMode(this.setup) === value ? this.themeBg : Color.Transparent)
      .accessibilitySelected(voiceShortcutMode(this.setup) === value).id(`voice-mode-${value}`)
      .enabled(this.canChooseModel()).onClick((): void => {
        if (voiceShortcutMode(this.setup) !== value) { this.change('configure', '', voiceShortcutModeConfig(value)).catch(() => {}); }
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
            .width(51).height(31).switchPointColor(Color.White)
            .enabled(this.canConfigure()).accessibilityText(this.t('启用语音听写')).id('voice-enabled')
            .onChange((on: boolean): void => {
              if (on !== this.setup?.enabled) { this.change('configure', '', { enabled: on }).catch(() => {}); }
            })
        }.width('100%').constraintSize({ minHeight: 52 }).padding(16)
        this.separator()
        Row({ space: 10 }) {
          Text(this.t('听写模式')).fontFamily('Geist').fontSize(16).fontColor(this.themeText).layoutWeight(1)
          Row({ space: 2 }) {
            if (this.offersAuto()) {
              this.mode('auto', 'settings.voiceSettingsScreen.autoMode')
              this.mode('hold', '按住')
              this.mode('toggle', '切换')
            } else {
              this.mode('toggle', '切换')
              this.mode('hold', '按住')
            }
          }.padding(3).borderRadius(10).backgroundColor(this.themeSheet)
        }.width('100%').constraintSize({ minHeight: 50 }).padding({ left: 16, right: 16 })
          .opacity(this.setup?.enabled === true ? 1 : 0.45)
      }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
      this.note(this.offersAuto() ? 'settings.voiceSettingsScreen.dictationModeWithAutoDescription'
        : '切换：按一次开始，再按一次停止。按住：按住期间进行听写。')
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
  private modelButton(model: SpeechModel, action: string, labelKey: string) {
    Button({ type: ButtonType.Normal }) {
      if (this.busyAction?.modelId === model.id && this.busyAction?.kind === action) {
        LoadingProgress().width(18).height(18).color(action === 'delete' ? this.themeStatusRed : this.themeSecondary)
      } else if (action === 'delete') {
        Image($r('app.media.lucide_trash_2')).supportSvg2(true).width(18).height(18)
          .colorFilter(lucideColorFilter(this.themeStatusRed))
      } else if (action === 'download') {
        Image($r('app.media.lucide_download')).supportSvg2(true).width(18).height(18)
          .colorFilter(lucideColorFilter(this.themeSecondary))
      } else {
        Text(this.t('components.voiceModelList.use')).fontFamily('Geist').fontSize(12)
          .fontWeight(FontWeight.Medium).fontColor(this.themeSecondary)
      }
    }.constraintSize({ minWidth: 42, minHeight: 40 }).padding({ left: 8, right: 8 })
      .borderRadius(10).backgroundColor(this.themeRaised).enabled(this.canChooseModel())
      .id(`voice-${action}-${model.id}`).accessibilityText(this.t(labelKey).replace('{{label}}', model.label))
      .onClick((): void => {
        this.change(action, model.id, action === 'use' ? { enabled: true, modelId: model.id } : {}).catch(() => {});
      })
  }

  @Builder
  private modelRow(model: SpeechModel) {
    Row({ space: 8 }) {
      Column({ space: 3 }) {
        Text(model.label).fontFamily('Geist').fontSize(15).fontColor(this.themeText)
        if (this.modelDetails(model, this.uiLocale)) {
          Text(this.modelDetails(model, this.uiLocale)).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
        }
        if (model.recommended) {
          Text(this.t('components.voiceModelList.recommended')).fontFamily('Geist').fontSize(11).fontWeight(FontWeight.Bold)
            .fontColor(this.themeScheme === 'light' ? '#147638' : '#86efac')
        }
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      if (this.modelAction(model, this.setup?.selectedModelId) === 'selected') {
        Row({ space: 4 }) {
          Image($r('app.media.lucide_check')).supportSvg2(true).width(14).height(14)
            .colorFilter(lucideColorFilter(this.themeScheme === 'light' ? '#147638' : '#86efac'))
          Text(this.t('components.voiceModelList.inUse')).fontFamily('Geist').fontSize(12)
            .fontColor(this.themeScheme === 'light' ? '#147638' : '#86efac')
        }
      } else if (this.modelAction(model, this.setup?.selectedModelId) === 'use') {
        this.modelButton(model, 'use', 'components.voiceModelList.useModel')
      } else if (this.modelAction(model, this.setup?.selectedModelId) === 'download') {
        this.modelButton(model, 'download', 'components.voiceModelList.downloadModel')
      } else if (this.modelAction(model, this.setup?.selectedModelId) === 'progress') {
        LoadingProgress().width(18).height(18).color(this.themeSecondary)
      } else {
        Text(this.t('dictation.setup.cloudModelNeedsKey')).fontFamily('Geist').fontSize(12).fontColor(this.themeMuted)
          .constraintSize({ maxWidth: '40%' })
      }
      if (model.provider !== 'openai' && model.status === 'ready') {
        this.modelButton(model, 'delete', 'components.voiceModelList.deleteModel')
      }
    }.width('100%').constraintSize({ minHeight: 56 }).padding({ left: 14, right: 10, top: 8, bottom: 8 })
  }

  @Builder
  private modelDrawer() {
    Scroll() {
      Column({ space: 10 }) {
        Text(this.t('语音模型')).fontFamily('Geist').fontSize(13).fontWeight(FontWeight.Medium)
          .fontColor(this.themeSecondary).width('100%').padding({ left: 4 })
        Text(this.desktopName()).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
          .maxLines(1).width('100%').padding({ left: 4 })
        if (this.changeError || this.loadError) { this.note(this.changeError || this.loadError, true) }
        if (!this.connected) { this.note('连接桌面后可管理语音设置。') }
        Column() {
          ForEach(this.setup?.models ?? [], (model: SpeechModel, index: number): void => {
            if (index > 0) { this.separator() }
            this.modelRow(model)
          }, (model: SpeechModel, index: number): string => `${index > 0}:${JSON.stringify(model)}`)
        }.width('100%').backgroundColor(this.themeScheme === 'light' ? this.themeBg : this.themeRaised)
          .borderRadius(16).clip(true)
      }.width('100%').padding({ left: 16, right: 16, bottom: 20, top: 8 })
    }.width('100%').height('auto').constraintSize({ maxHeight: Math.max(160, this.viewportHeight * 0.85) })
      .scrollBar(BarState.Off).align(Alignment.Top)
  }

  build() {
    Column() {
      SettingsNavBar({ title: this.t('语音') })

      Scroll() {
        Column({ space: 20 }) {
          this.transcription()
          this.desktopSelector()
          if (this.connected && this.setup !== null) {
            this.desktopOptions()
          } else if (this.hosts.length > 0 && !this.selectedDesktop()) {
            this.note('选择桌面')
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
      .onSizeChange((_previous: SizeOptions, current: SizeOptions): void => { this.viewportHeight = Number(current.height); })
      .bindSheet(this.modelsOpen, this.modelDrawer, { height: SheetSize.FIT_CONTENT, backgroundColor: this.themeSheet,
        maskColor: 'rgba(0,0,0,0.55)', showClose: false, onDisappear: (): void => { this.modelsOpen = false; } })
      .bindSheet(this.desktopPickerOpen, this.desktopPicker, { height: SheetSize.FIT_CONTENT, backgroundColor: this.themeSheet,
        maskColor: 'rgba(0,0,0,0.55)', showClose: false, onDisappear: (): void => { this.desktopPickerOpen = false; } })
  }
}
