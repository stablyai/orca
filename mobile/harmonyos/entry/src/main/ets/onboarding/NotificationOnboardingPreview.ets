import { curves } from '@kit.ArkUI';
import { lucideColorFilter } from '../settings/LucideColor';
import { uiText } from '../settings/NativeUi';

const ENTER_MS = 676;
const EXIT_MS = 416;
const STAGGER_MS = 546;
const HOLD_MS = 2860;
const GAP_MS = 624;
const SLIDE_FROM_Y = -22;

@Component
export struct NotificationOnboardingPreview {
  @Prop @Watch('syncMotion') active: boolean = false;
  @Prop @Watch('syncMotion') reducedMotion: boolean = true;
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBorder') themeBorder: string = '#262626';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeRaised') themeRaised: string = '#262626';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @State shown: number = 0;
  private timer: number = -1;

  aboutToAppear(): void { this.syncMotion(); }
  aboutToDisappear(): void { this.stopTimer(); }

  private stopTimer(): void {
    if (this.timer >= 0) { clearTimeout(this.timer); this.timer = -1; }
  }

  private syncMotion(): void {
    this.stopTimer();
    this.shown = this.active && this.reducedMotion ? 2 : 0;
    if (this.active && !this.reducedMotion) {
      this.timer = setTimeout((): void => this.enterFirst(), 0);
    }
  }

  private enterFirst(): void {
    this.enter(1);
    this.timer = setTimeout((): void => {
      this.enter(2);
      this.timer = setTimeout((): void => this.leave(), ENTER_MS + HOLD_MS);
    }, ENTER_MS + STAGGER_MS);
  }

  private enter(count: number): void {
    this.getUIContext().animateTo({ duration: ENTER_MS, curve: curves.cubicBezierCurve(1 / 3, 1, 2 / 3, 1) },
      (): void => { this.shown = count; });
  }

  private leave(): void {
    this.getUIContext().animateTo({ duration: EXIT_MS, curve: curves.cubicBezierCurve(1 / 3, 0, 2 / 3, 0) },
      (): void => { this.shown = 0; });
    this.timer = setTimeout((): void => this.enterFirst(), EXIT_MS + GAP_MS);
  }

  @Builder
  private notification(title: string, body: string, index: number) {
    Row({ space: 12 }) {
      Stack() {
        Image($r('app.media.orca_mark')).supportSvg2(true).width(22).height(14)
          .colorFilter(lucideColorFilter(this.themeText))
      }.width(32).height(32).borderRadius(10).backgroundColor(this.themeRaised)
      Column({ space: 2 }) {
        Row() {
          Text('Orca').fontFamily('Geist').fontSize(11).fontWeight(FontWeight.Medium)
            .fontColor(this.themeMuted).layoutWeight(1)
          Text(uiText('现在', this.uiLocale)).fontFamily('Geist').fontSize(11).fontColor(this.themeMuted)
        }.width('100%')
        Text(uiText(title, this.uiLocale)).fontFamily('Geist').fontSize(14).fontWeight(FontWeight.Medium)
          .fontColor(this.themeText).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(uiText(body, this.uiLocale)).fontFamily('Geist').fontSize(11).fontColor(this.themeSecondary)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
    }.width('100%').padding(12).backgroundColor(this.themeSurface)
      .border({ width: 1, radius: 16, color: this.themeBorder })
      .opacity(this.shown >= index ? 1 : 0)
      .translate({ y: this.shown >= index ? 0 : SLIDE_FROM_Y })
  }

  build() {
    Column({ space: 8 }) {
      this.notification('Codex 已完成', '测试已通过。', 1)
      this.notification('Claude 需要输入', '等待您的回应。', 2)
    }.width('100%').constraintSize({ maxWidth: 320 }).margin({ bottom: 40 })
      .accessibilityLevel('no-hide-descendants').hitTestBehavior(HitTestMode.None)
  }
}
