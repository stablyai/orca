import { KeyboardAvoidMode as PageKeyboardAvoidMode, promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { uiText } from '../settings/NativeUi';
import { lucideColorFilter } from '../settings/LucideColor';
import { DesktopEndpointEdit, displayHostEndpoint, resolveDesktopEndpoint } from '../diagnostics/ConnectionDiagnostics';
import { listHosts, updateHostNameAndEndpoint, HostMeta } from '../storage/HostStore';
import { removeDesktop } from '../storage/HostRemoval';
import { refreshDesktopConnection } from '../transport/DesktopConnections';

@Entry
@Component
struct HostDetail {
  @StorageProp('uiLocale') locale: string = 'en';
  @StorageProp('themeScheme') scheme: string = 'dark';
  @StorageProp('themeBg') backgroundTint: string = '#0a0a0a';
  @StorageProp('themeSurface') surface: string = '#171717';
  @StorageProp('themeBorder') borderTint: string = '#2c2c2c';
  @StorageProp('themeText') ink: string = '#fafafa';
  @StorageProp('themeSecondary') secondary: string = '#acacac';
  @StorageProp('themeMuted') muted: string = '#898989';
  @State host: HostMeta | null = null;
  @State personalName: string = '';
  @State address: string = '';
  @State endpointEdit: DesktopEndpointEdit | null = null;
  @State loadError: string = '';
  @State saveError: string = '';
  @State saving: boolean = false;
  private epoch: number = 0;
  private hostId: string = '';
  private priorKeyboardMode?: PageKeyboardAvoidMode;

  aboutToAppear(): void {
    let params = (router.getParams() ?? {}) as Record<string, string>;
    this.hostId = params['hostId'] ?? '';
    this.loadEditor().catch(() => {});
  }
  onPageShow(): void {
    let ui = this.getUIContext();
    this.priorKeyboardMode = ui.getKeyboardAvoidMode(); ui.setKeyboardAvoidMode(PageKeyboardAvoidMode.RESIZE);
  }
  onPageHide(): void { this.restoreKeyboardMode(); }
  aboutToDisappear(): void { this.epoch++; this.restoreKeyboardMode(); }

  private restoreKeyboardMode(): void {
    if (this.priorKeyboardMode !== undefined) {
      this.getUIContext().setKeyboardAvoidMode(this.priorKeyboardMode);
      this.priorKeyboardMode = undefined;
    }
  }

  private t(label: string): string { return uiText(label, this.locale); }
  private danger(): string { return this.scheme === 'light' ? '#b91c1c' : '#ff6568'; }

  private async loadEditor(): Promise<void> {
    let epoch = ++this.epoch;
    try {
      let hosts = await listHosts(getContext(this));
      if (epoch !== this.epoch) { return; }
      let host = hosts.find((item: HostMeta): boolean => item.id === this.hostId);
      if (!host) { this.loadError = '桌面已从此手机移除'; return; }
      this.host = host;
      this.personalName = host.personalName ?? '';
      this.address = displayHostEndpoint(host.endpoint);
      this.endpointEdit = resolveDesktopEndpoint(host.endpoint, this.address);
    } catch (e) { if (epoch === this.epoch) { this.loadError = '无法读取桌面，请重试'; } }
  }

  private canSave(): boolean {
    return this.host !== null && this.endpointEdit !== null && this.endpointEdit.kind !== 'invalid' && !this.saving &&
      (this.personalName.trim() !== (this.host.personalName ?? '') || this.endpointEdit.kind === 'changed');
  }

  private async saveEditor(): Promise<void> {
    let edit = this.endpointEdit;
    if (!this.canSave() || !edit?.endpoint) { return; }
    let name = this.personalName.trim();
    let personalName = name === (this.host?.personalName ?? '') ? undefined : name;
    let endpoint = edit.kind === 'changed' ? edit.endpoint : undefined;
    this.saving = true; this.saveError = '';
    let epoch = this.epoch;
    try {
      let context = getContext(this) as common.UIAbilityContext;
      let endpointChanged = await updateHostNameAndEndpoint(context, this.hostId, personalName, endpoint);
      refreshDesktopConnection(this.hostId, endpointChanged ? 'endpoint' : 'name');
      if (epoch === this.epoch) { router.back(); }
    } catch (e) {
      if (epoch === this.epoch) { this.saveError = '保存失败，请检查桌面地址并重试'; }
    } finally { if (epoch === this.epoch) { this.saving = false; } }
  }

  private async confirmRemove(): Promise<void> {
    let host = this.host;
    if (!host || this.saving) { return; }
    let epoch = this.epoch;
    let answer = await promptAction.showDialog({ title: this.t('移除主机'),
      message: this.t('移除“{{name}}”？之后可以重新配对。').replace('{{name}}', host.name),
      buttons: [{ text: this.t('取消'), color: this.secondary }, { text: this.t('移除'), color: this.danger() }] });
    if (answer.index !== 1 || epoch !== this.epoch || this.saving) { return; }
    this.saving = true; this.saveError = '';
    let removed = false;
    let id = host.id;
    try {
      await removeDesktop(getContext(this), id, (): void => { removed = true; });
    } catch (e) {
      if (epoch === this.epoch) { this.saveError = '移除失败，凭证或页面数据未能清理，请重试。'; }
    } finally {
      if (epoch === this.epoch) {
        this.saving = false;
        if (removed) { router.back({ url: 'pages/Home' }); }
      }
    }
  }

  @Builder
  private navBar() {
    Stack({ alignContent: Alignment.Center }) {
      Text(this.t('编辑桌面')).fontFamily('Geist').fontSize(17).fontWeight(FontWeight.Medium).fontColor(this.ink)
      Row() {
        Button({ type: ButtonType.Normal }) {
          Image($r('app.media.lucide_chevron_left')).supportSvg2(true).width(22).height(22)
            .colorFilter(lucideColorFilter(this.secondary))
        }.width(40).height(40).borderRadius(12).backgroundColor(Color.Transparent)
          .accessibilityText(this.t('返回')).onClick((): void => router.back())
        Blank()
        Button({ type: ButtonType.Normal }) {
          if (this.saving) {
            LoadingProgress().width(18).height(18).color(this.secondary)
          } else {
            Image($r('app.media.lucide_check')).supportSvg2(true).width(22).height(22)
              .colorFilter(lucideColorFilter(this.canSave() ? this.ink : this.muted))
          }
        }.width(40).height(40).borderRadius(12).backgroundColor(Color.Transparent)
          .enabled(this.canSave()).accessibilityText(this.t('保存桌面'))
          .onClick((): void => { this.saveEditor().catch(() => {}); })
      }.width('100%')
    }.width('100%').height(48).padding({ left: 12, right: 12 })
  }

  @Builder
  private form() {
    Scroll() {
      Column({ space: 8 }) {
        Text(this.t('桌面编辑说明')).fontFamily('Geist').fontSize(14).lineHeight(20).fontColor(this.secondary).margin({ bottom: 8 })
        Text(this.t('名称')).fontFamily('Geist').fontSize(12).fontWeight(FontWeight.Medium).fontColor(this.secondary).letterSpacing(0.4)
        TextInput({ text: this.personalName, placeholder: this.host?.machineName ?? this.t('桌面名称') })
          .fontFamily('Geist').fontSize(14).fontColor(this.ink).placeholderColor(this.muted).height(44)
          .backgroundColor(this.backgroundTint).border({ width: 1, color: this.borderTint, radius: 12 })
          .enabled(!this.saving).enterKeyType(EnterKeyType.Next).accessibilityText(this.t('名称'))
          .onChange((value: string): void => { this.personalName = value; this.saveError = ''; })
        Text(this.t('地址')).fontFamily('Geist').fontSize(12).fontWeight(FontWeight.Medium).fontColor(this.secondary)
          .letterSpacing(0.4).margin({ top: 8 })
        TextInput({ text: this.address, placeholder: '192.168.1.10:6768' })
          .fontFamily('Geist').fontSize(14).fontColor(this.ink).placeholderColor(this.muted).height(44)
          .backgroundColor(this.backgroundTint).border({ width: 1, color: this.borderTint, radius: 12 })
          .enabled(!this.saving).enterKeyType(EnterKeyType.Done).accessibilityText(this.t('地址'))
          .onChange((value: string): void => {
            this.address = value; this.saveError = '';
            if (this.host) { this.endpointEdit = resolveDesktopEndpoint(this.host.endpoint, value); }
          }).onSubmit((): void => { this.saveEditor().catch(() => {}); })
        Text(this.t('桌面地址格式说明')).fontFamily('Geist').fontSize(12).lineHeight(16).fontColor(this.muted)
        if (this.endpointEdit?.endpoint) {
          Text(this.t('连接到 {{endpoint}}').replace('{{endpoint}}', this.endpointEdit.endpoint))
            .fontFamily('monospace').fontSize(12).maxLines(2).fontColor(this.secondary).margin({ top: 8 })
        } else if (this.address.trim() && this.endpointEdit?.error) {
          Text(this.t(this.endpointEdit.error)).fontFamily('Geist').fontSize(14).fontColor(this.danger()).margin({ top: 8 })
        }
        if (this.saveError) {
          Text(this.t(this.saveError)).fontFamily('Geist').fontSize(14).fontColor(this.danger()).margin({ top: 8 })
        }
        Button({ type: ButtonType.Normal }) {
          Text(this.t('移除桌面')).fontFamily('Geist').fontSize(15).fontColor(this.danger())
            .width('100%').textAlign(TextAlign.Start)
        }.height(46).width('100%').padding({ left: 14, right: 14 }).borderRadius(16)
          .backgroundColor(this.surface).margin({ top: 24 }).enabled(!this.saving)
          .onClick((): void => { this.confirmRemove().catch(() => {}); })
      }.width('100%').alignItems(HorizontalAlign.Start).padding({ left: 16, right: 16, top: 12, bottom: 24 })
    }.width('100%').layoutWeight(1).scrollBar(BarState.Off)
  }

  build() {
    Column() {
      this.navBar()
      if (this.host) {
        this.form()
      } else {
        Column({ space: 12 }) {
          if (this.loadError) {
            Text(this.t(this.loadError)).fontFamily('Geist').fontSize(14).fontColor(this.danger())
            Button(this.t('返回')).backgroundColor(Color.Transparent).fontColor(this.ink).onClick((): void => router.back())
          } else {
            LoadingProgress().width(28).height(28).color(this.secondary)
          }
        }.width('100%').layoutWeight(1).justifyContent(FlexAlign.Center)
      }
    }.width('100%').height('100%').backgroundColor(this.backgroundTint)
  }
}
