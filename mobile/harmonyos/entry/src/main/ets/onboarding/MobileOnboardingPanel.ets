import { lucideColorFilter } from '../settings/LucideColor';
import { uiText } from '../settings/NativeUi';

@Component
export struct MobileOnboardingPanel {
  @Prop step: string = '';
  @Prop active: boolean = false;
  @Prop busyChoice: string = '';
  @Prop error: string = '';
  onChoice: (choice: string) => void = (_choice: string): void => {};
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeScheme') scheme: string = 'dark';
  @StorageProp('themeBorder') themeBorder: string = '#262626';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeRaised') themeRaised: string = '#262626';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @State viewportHeight: number = 0;
  @State footerHeight: number = 0;

  private t(label: string): string { return uiText(label, this.uiLocale); }

  @Builder
  private notification(title: string, body: string) {
    Row({ space: 12 }) {
      Stack() {
        Image($r('app.media.orca_mark')).supportSvg2(true).width(22).height(14)
          .colorFilter(lucideColorFilter(this.themeText))
      }.width(32).height(32).borderRadius(10).backgroundColor(this.themeRaised)
      Column({ space: 2 }) {
        Row() {
          Text('Orca').fontFamily('Geist').fontSize(11).fontWeight(FontWeight.Medium)
            .fontColor(this.themeMuted).layoutWeight(1)
          Text(this.t('现在')).fontFamily('Geist').fontSize(11).fontColor(this.themeMuted)
        }.width('100%')
        Text(this.t(title)).fontFamily('Geist').fontSize(14).fontWeight(FontWeight.Medium)
          .fontColor(this.themeText).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.t(body)).fontFamily('Geist').fontSize(11).fontColor(this.themeSecondary)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
    }.width('100%').padding(12).backgroundColor(this.themeSurface)
      .border({ width: 1, radius: 16, color: this.themeBorder })
  }

  @Builder
  private hero() {
    Column() {
      if (this.step === 'session-view') {
        Stack() {
          Image($r('app.media.lucide_message_square')).supportSvg2(true).width(30).height(30)
            .colorFilter(lucideColorFilter(this.themeText))
        }.width(64).height(64).borderRadius(10).backgroundColor(this.themeRaised).margin({ bottom: 24 })
      } else {
        Column({ space: 8 }) {
          this.notification('Codex 已完成', '测试已通过。')
          this.notification('Claude 需要输入', '等待您的回应。')
        }.width('100%').constraintSize({ maxWidth: 320 }).margin({ bottom: 40 })
          .accessibilityLevel('no-hide-descendants').hitTestBehavior(HitTestMode.None)
      }
      Text(this.t(this.step === 'session-view' ? '会话应如何打开？' : '开启在线智能体提醒？'))
        .fontFamily('Geist').fontSize(26).fontWeight(FontWeight.Bold).fontColor(this.themeText)
        .textAlign(TextAlign.Center)
      Text(this.t(this.step === 'session-view'
        ? '选择此手机上支持的智能体会话默认使用聊天界面还是终端。长按会话标签可单独切换，也可随时在设置 → 聊天界面更改默认值。'
        : '当此应用与桌面保持连接时，可在智能体完成或等待输入时显示本机通知。点击开启后才会请求系统通知权限。'))
        .fontFamily('Geist').fontSize(14).lineHeight(21).fontColor(this.themeSecondary)
        .textAlign(TextAlign.Center).margin({ top: 12 })
    }.width('100%').constraintSize({ maxWidth: 420, minHeight: Math.max(0, this.viewportHeight - this.footerHeight) })
      .justifyContent(this.step === 'session-view' ? FlexAlign.Center : FlexAlign.Start)
      .padding({ top: this.step === 'session-view' ? 16 : 24, bottom: 12 })
  }

  @Builder
  private choice(label: string, value: string, primary: boolean) {
    Button({ type: ButtonType.Normal }) {
      if (this.busyChoice === value) {
        LoadingProgress().width(18).height(18).color(primary ? this.themeBg : this.themeSecondary)
      } else {
        Text(this.t(label)).fontFamily('Geist').fontSize(14)
          .fontWeight(primary ? FontWeight.Bold : FontWeight.Medium)
          .fontColor(primary ? this.themeBg : this.themeSecondary)
      }
    }.width('100%').constraintSize({ minHeight: 44 }).borderRadius(12)
      .backgroundColor(primary ? (this.scheme === 'light' ? '#171717' : '#e5e5e5') : Color.Transparent)
      .opacity(this.busyChoice !== '' && this.busyChoice !== value ? 0.58 : 1)
      .enabled(this.active && this.busyChoice === '').accessibilityText(this.t(label))
      .onClick((): void => this.onChoice(value))
  }

  @Builder
  private footer() {
    Column({ space: 4 }) {
      if (this.step !== 'session-view') {
        Text(this.t('本版本尚未接入华为远程推送；应用断开或退出后无法保证送达。此选择仅控制在线通知。'))
          .fontFamily('Geist').fontSize(11).lineHeight(18).fontColor(this.themeSecondary)
          .textAlign(TextAlign.Center).margin({ bottom: 16 })
      }
      if (this.error.length > 0) {
        Text(this.t(this.error)).fontFamily('Geist').fontSize(11).lineHeight(18)
          .fontColor(this.scheme === 'light' ? '#b91c1c' : '#ff6568').textAlign(TextAlign.Center).margin({ bottom: 8 })
      }
      if (this.step === 'session-view') {
        this.choice('使用聊天界面', 'chat', true)
        this.choice('保留终端', 'terminal', false)
      } else {
        this.choice('开启在线通知', 'enable', true)
        this.choice('暂不开启', 'skip', false)
      }
    }.width('100%').constraintSize({ maxWidth: 420 }).padding({ bottom: 16 })
      .onAreaChange((_old: Area, area: Area): void => { this.footerHeight = Number(area.height); })
  }

  build() {
    Scroll() {
      Column() {
        this.hero()
        this.footer()
      }.width('100%').padding({ left: 24, right: 24 })
    }.width('100%').height('100%').scrollBar(BarState.Off)
      .accessibilityLevel(this.active ? 'auto' : 'no-hide-descendants')
      .onAreaChange((_old: Area, area: Area): void => { this.viewportHeight = Number(area.height); })
  }
}
