import { lucideColorFilter } from '../settings/LucideColor';
import { curves, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { accessibility } from '@kit.AccessibilityKit';
import { uiText } from '../settings/NativeUi';
import { requestNotificationPermission } from '../notifications/NotificationPermission';
import { loadMobileOnboardingSteps, parseMobileOnboardingSteps, saveOnboardingSessionView,
  saveOnboardingOnlineNotifications } from '../onboarding/MobileOnboardingPlan';
import { MobileOnboardingPanel } from '../onboarding/MobileOnboardingPanel';

@Entry
@Component
struct MobileOnboarding {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBorder') themeBorder: string = '#262626';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @State pages: string[] = [];
  @State step: string = '';
  @State error: string = '';
  @State busyChoice: string = '';
  @State completed: number = 0;
  @State visible: boolean = false;
  @State foreground: boolean = true;
  @State reducedMotion: boolean = true;
  private pager: SwiperController = new SwiperController();
  private hostId: string = '';
  private disposed: boolean = false;
  private navigating: boolean = false;
  private context?: common.UIAbilityContext;
  private watchingMotion: boolean = false;
  private motionChanged = (reduced: boolean): void => { this.reducedMotion = reduced; };
  private onForeground = (): void => { this.refreshMotionPreference(); this.foreground = true; };
  private onBackground = (): void => { this.foreground = false; };

  aboutToAppear(): void {
    let params = (router.getParams() ?? {}) as Record<string, string>;
    this.hostId = params['hostId'] ?? '';
    let context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.pages = params['steps'] === undefined ? loadMobileOnboardingSteps(context)
      : parseMobileOnboardingSteps(params['steps']);
    this.step = this.pages[0] ?? '';
    this.context = context;
    context.eventHub.on('orcaForeground', this.onForeground);
    context.eventHub.on('orcaBackground', this.onBackground);
    this.refreshMotionPreference();
    try {
      accessibility.onAnimationReduceStateChange(this.motionChanged);
      this.watchingMotion = true;
    } catch (e) {}
  }
  onPageShow(): void {
    this.visible = true;
    if (!this.step) { this.continueToApp(); }
  }
  onPageHide(): void { this.visible = false; }
  aboutToDisappear(): void {
    this.disposed = true; this.visible = false;
    this.context?.eventHub.off('orcaForeground', this.onForeground);
    this.context?.eventHub.off('orcaBackground', this.onBackground);
    if (this.watchingMotion) {
      try { accessibility.offAnimationReduceStateChange(this.motionChanged); } catch (e) {}
    }
  }
  onBackPress(): boolean { return true; }

  private refreshMotionPreference(): void {
    try { this.reducedMotion = accessibility.isAnimationReduceEnabledSync(); }
    catch (e) { this.reducedMotion = true; }
  }

  private advance(): void {
    this.completed++;
    this.step = this.pages[this.completed] ?? '';
    if (this.step) { this.pager.changeIndex(this.completed, !this.reducedMotion); }
    else { this.continueToApp(); }
  }

  private continueToApp(): void {
    if (this.disposed || !this.visible || this.navigating) { return; }
    this.navigating = true; this.error = '';
    let hasHost = /^[a-f0-9]{32}$/.test(this.hostId);
    let params: Record<string, string> = {};
    if (hasHost) { params['hostId'] = this.hostId; }
    router.replaceUrl({ url: hasHost ? 'pages/ShellScreen' : 'pages/Home', params: params }).catch(() => {
      this.navigating = false;
      if (!this.disposed) { this.error = hasHost ? '无法打开桌面，请重试' : '无法打开首次设置，请重试'; }
    });
  }

  async chooseSession(view: string): Promise<void> {
    if (this.busyChoice || this.disposed || !this.visible || this.step !== 'session-view') { return; }
    this.busyChoice = view; this.error = '';
    try {
      await saveOnboardingSessionView(getContext(this), view);
      if (!this.disposed) { this.advance(); }
    } catch (e) { if (!this.disposed) { this.error = '无法保存选择，请重试'; } }
    finally { this.busyChoice = ''; }
  }

  async chooseNotifications(enable: boolean): Promise<void> {
    if (this.busyChoice || this.disposed || !this.visible || this.step !== 'online-notifications') { return; }
    this.busyChoice = enable ? 'enable' : 'skip'; this.error = '';
    try {
      const granted = enable && (await requestNotificationPermission(getContext(this) as common.UIAbilityContext)) === 'granted';
      if (this.disposed) { return; }
      await saveOnboardingOnlineNotifications(getContext(this), granted);
      if (!this.disposed) { this.advance(); }
    } catch (e) { if (!this.disposed) { this.error = '无法保存通知选择，请重试'; } }
    finally { this.busyChoice = ''; }
  }

  @Builder
  private brand() {
    Stack() {
      Row({ space: 8 }) {
        Image($r('app.media.orca_mark')).supportSvg2(true).width(35).height(22)
          .colorFilter(lucideColorFilter(this.themeText))
        Text('Orca').fontFamily('Geist').fontSize(17).fontWeight(FontWeight.Bold).fontColor(this.themeText)
      }.width('100%').padding({ left: 24, right: 24 })
      if (this.pages.length > 1 && this.step.length > 0) {
        Row({ space: 7 }) {
          ForEach(this.pages, (_page: string, index: number) => {
            Row().height(7).width(index === this.completed ? 22 : 7).borderRadius(999)
              .backgroundColor(index === this.completed ? this.themeText : this.themeBorder)
          }, (page: string): string => page)
        }.accessibilityText(`${this.completed + 1} / ${this.pages.length}`)
      }
    }.width('100%').height(52)
  }

  build() {
    Column() {
      this.brand()
      if (this.step.length > 0) {
        Swiper(this.pager) {
          ForEach(this.pages, (page: string) => {
            MobileOnboardingPanel({ step: page, active: this.step === page, busyChoice: this.busyChoice,
              previewActive: this.visible && this.foreground, reducedMotion: this.reducedMotion,
              error: this.step === page ? this.error : '', onChoice: (choice: string): void => {
                if (page === 'session-view') { this.chooseSession(choice).catch(() => {}); }
                else { this.chooseNotifications(choice === 'enable').catch(() => {}); }
              } })
          }, (page: string): string => page)
        }.layoutWeight(1).width('100%').indicator(false).loop(false).disableSwipe(true)
          .duration(300).curve(curves.cubicBezierCurve(0.2, 0.8, 0.2, 1))
      } else {
        Column({ space: 8 }) {
          if (this.error.length > 0) {
            Text(uiText(this.error, this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeText)
              .textAlign(TextAlign.Center)
            Button(uiText('重试', this.uiLocale)).fontFamily('Geist').fontSize(14)
              .enabled(this.busyChoice === '').onClick((): void => this.continueToApp())
          } else {
            LoadingProgress().width(28).height(28).color(this.themeSecondary)
          }
        }.width('100%').layoutWeight(1).justifyContent(FlexAlign.Center).padding(24)
      }
    }.width('100%').height('100%').backgroundColor(this.themeBg)
  }
}
