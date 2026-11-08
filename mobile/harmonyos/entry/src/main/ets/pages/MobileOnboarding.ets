import { lucideColorFilter } from '../settings/LucideColor';
import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { uiText } from '../settings/NativeUi';
import { LocalNotifier } from '../notifications/LocalNotifier';
import { loadMobileOnboardingSteps, saveOnboardingSessionView, saveOnboardingOnlineNotifications } from '../onboarding/MobileOnboardingPlan';

@Entry
@Component
struct MobileOnboarding {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeScheme') scheme: string = 'dark';
  @StorageProp('themeBorder') themeBorder: string = '#262626';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeAccent') themeAccent: string = '#3276f2';
  @State step: string = '';
  @State error: string = '';
  @State busy: boolean = false;
  @State loaded: boolean = false;
  @State completed: number = 0;
  private hostId: string = '';
  private total: number = 0;
  private disposed: boolean = false;
  private visible: boolean = false;
  private navigationEpoch: number = 0;

  aboutToAppear(): void {
    let params = (router.getParams() ?? {}) as Record<string, string>;
    this.hostId = params['hostId'] ?? '';
  }
  onPageShow(): void { this.visible = true; this.navigationEpoch++; this.refresh(); }
  onPageHide(): void { this.visible = false; this.navigationEpoch++; }
  aboutToDisappear(): void { this.disposed = true; this.visible = false; this.navigationEpoch++; }
  onBackPress(): boolean { return true; }

  refresh(): void {
    try {
      let steps = loadMobileOnboardingSteps(getContext(this));
      if (!this.loaded) { this.total = steps.length; }
      this.loaded = true; this.error = '';
      if (steps.length === 0) { this.step = ''; this.continueToApp(); }
      else { this.step = steps[0]; }
    } catch (e) { this.error = '无法读取首次设置，请重试'; }
  }

  private continueToApp(): void {
    if (this.disposed || !this.visible) { return; }
    if (/^[a-f0-9]{32}$/.test(this.hostId)) {
      router.replaceUrl({ url: 'pages/ShellScreen', params: { 'hostId': this.hostId } }).catch(() => { this.error = '无法打开桌面，请重试'; });
    } else {
      router.replaceUrl({ url: 'pages/Home' }).catch(() => { this.error = '无法打开首次设置，请重试'; });
    }
  }

  async chooseSession(view: string): Promise<void> {
    if (this.busy || this.disposed || !this.visible || this.step !== 'session-view') { return; }
    this.busy = true; this.error = '';
    let navigationEpoch = this.navigationEpoch;
    try {
      await saveOnboardingSessionView(getContext(this), view);
      if (!this.disposed && this.visible && navigationEpoch === this.navigationEpoch) { this.completed++; this.refresh(); }
    } catch (e) { if (!this.disposed) { this.error = '无法保存选择，请重试'; } }
    finally {
      this.busy = false;
      if (!this.disposed && this.visible && navigationEpoch !== this.navigationEpoch) { this.refresh(); }
    }
  }

  async chooseNotifications(enable: boolean): Promise<void> {
    if (this.busy || this.disposed || !this.visible || this.step !== 'online-notifications') { return; }
    this.busy = true; this.error = '';
    let navigationEpoch = this.navigationEpoch;
    try {
      let granted = false;
      if (enable) {
        let notifier = new LocalNotifier();
        granted = await notifier.requestEnable(getContext(this) as common.UIAbilityContext);
      }
      if (this.disposed) { return; }
      await saveOnboardingOnlineNotifications(getContext(this), granted);
      if (!this.disposed && this.visible && navigationEpoch === this.navigationEpoch) { this.completed++; this.refresh(); }
    } catch (e) { if (!this.disposed) { this.error = '无法保存通知选择，请重试'; } }
    finally {
      this.busy = false;
      if (!this.disposed && this.visible && navigationEpoch !== this.navigationEpoch) { this.refresh(); }
    }
  }

  build() {
    Column({ space: 20 }) {
      Row({ space: 8 }) {
        Image($r('app.media.icon')).width(24).height(24)
        Text('Orca').fontFamily('Geist').fontSize(17).fontWeight(FontWeight.Bold).fontColor(this.themeText).layoutWeight(1)
        if (this.loaded && this.total > 1 && this.step.length > 0) {
          Row({ space: 7 }) {
            ForEach([0, 1], (index: number) => {
              Row().height(7).width(index === this.completed ? 22 : 7).borderRadius(999)
                .backgroundColor(index === this.completed ? this.themeText : this.themeBorder)
            })
          }.accessibilityText(`${this.completed + 1} / ${this.total}`)
        }
      }.width('100%')
      Scroll() {
        Column({ space: 16 }) {
          if (this.step === 'session-view') {
            Stack() {
              Image($r('app.media.lucide_message_square')).supportSvg2(true).colorFilter(lucideColorFilter(this.themeText)).width(30).height(30)
            }.width(64).height(64).borderRadius(10).backgroundColor(this.scheme === 'light' ? '#f5f5f5' : '#262626').margin({ bottom: 24 })
            Text(uiText('会话应如何打开？', this.uiLocale)).fontFamily('Geist').fontSize(26).fontWeight(FontWeight.Bold).fontColor(this.themeText).textAlign(TextAlign.Center)
            Text(uiText('选择此手机上支持的智能体会话默认使用聊天界面还是终端。长按会话标签可单独切换，也可随时在设置 → 聊天界面更改默认值。', this.uiLocale))
              .fontFamily('Geist').fontSize(14).lineHeight(21).fontColor(this.themeSecondary).textAlign(TextAlign.Center)
            Button(uiText('使用聊天界面', this.uiLocale)).fontFamily('Geist').fontSize(14).width('100%').height(44).borderRadius(12)
              .fontColor(this.themeBg).backgroundColor(this.scheme === 'light' ? '#171717' : '#e5e5e5').enabled(!this.busy)
              .onClick(() => { this.chooseSession('chat').catch(() => {}); })
            Button(uiText('保留终端', this.uiLocale)).fontFamily('Geist').fontSize(14).width('100%').height(44).borderRadius(12)
              .fontColor(this.themeSecondary).backgroundColor(Color.Transparent).enabled(!this.busy)
              .onClick(() => { this.chooseSession('terminal').catch(() => {}); })
          } else if (this.step === 'online-notifications') {
            Image($r('app.media.lucide_bell')).supportSvg2(true).colorFilter(lucideColorFilter(this.themeText)).width(44).height(44)
            Text(uiText('开启在线智能体提醒？', this.uiLocale)).fontFamily('Geist').fontSize(26).fontWeight(FontWeight.Bold).fontColor(this.themeText).textAlign(TextAlign.Center)
            Text(uiText('当此应用与桌面保持连接时，可在智能体完成或等待输入时显示本机通知。点击开启后才会请求系统通知权限。', this.uiLocale))
              .fontFamily('Geist').fontSize(14).lineHeight(21).fontColor(this.themeSecondary).textAlign(TextAlign.Center)
            Text(uiText('本版本尚未接入华为远程推送；应用断开或退出后无法保证送达。此选择仅控制在线通知。', this.uiLocale))
              .fontFamily('Geist').fontSize(14).fontColor(this.themeSecondary).textAlign(TextAlign.Center)
            Button(uiText('开启在线通知', this.uiLocale)).fontFamily('Geist').fontSize(14).width('100%').height(44).borderRadius(12)
              .fontColor(this.themeBg).backgroundColor(this.scheme === 'light' ? '#171717' : '#e5e5e5').enabled(!this.busy)
              .onClick(() => { this.chooseNotifications(true).catch(() => {}); })
            Button(uiText('暂不开启', this.uiLocale)).fontFamily('Geist').fontSize(14).width('100%').height(44).borderRadius(12)
              .fontColor(this.themeSecondary).backgroundColor(Color.Transparent).enabled(!this.busy)
              .onClick(() => { this.chooseNotifications(false).catch(() => {}); })
          }
          if (this.busy) { LoadingProgress().width(28).height(28) }
          if (this.error.length > 0) {
            Text(uiText(this.error, this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeText).width('100%')
            if (!this.loaded || this.step.length === 0) { Button(uiText('重试', this.uiLocale)).fontFamily('Geist').fontSize(14).enabled(!this.busy).onClick(() => this.refresh()) }
          }
        }.width('100%').constraintSize({ minHeight: '100%' }).justifyContent(FlexAlign.Center)
      }.layoutWeight(1).width('100%').scrollBar(BarState.Off)
    }.width('100%').height('100%').padding(24).backgroundColor(this.themeBg)
  }
}
