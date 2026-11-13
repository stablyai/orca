import { uiText } from '../settings/NativeUi';
import { lucideColorFilter } from '../settings/LucideColor';
import terminalRail, { SideRailStrip } from '../vendor/terminal-rail.js';
import { TERMINAL_RAIL_ARROWS, TerminalRailClaim, terminalRailKeyEnabled } from './TerminalRailClaim';

const KEY_LABELS: Map<string, string> = new Map([
  ['escape', 'Esc'], ['tab', 'Tab'], ['shiftTab', '⇧Tab'], ['enter', '⏎'], ['ctrlC', 'Ctrl+C'],
  ['ctrl', 'Ctrl'], ['alt', 'Alt'], ['shift', 'Shift'], ['arrowUp', '↑'], ['arrowDown', '↓'],
  ['arrowLeft', '←'], ['arrowRight', '→']
]);
const ARROW_LABELS: Map<string, string> = new Map([
  ['arrowUp', '方向键盘向上'], ['arrowDown', '方向键盘向下'], ['arrowLeft', '方向键盘向左'], ['arrowRight', '方向键盘向右']
]);

@Component
export struct TerminalKeyRail {
  @Prop @Watch('geometryChanged') strip: SideRailStrip = { side: 'right', width: 0, height: 0, top: 0, bottom: 0 };
  @Prop @Watch('claimChanged') claim: TerminalRailClaim | null = null;
  @Prop @Watch('geometryChanged') keys: string[] = [];
  @Prop hasPad: boolean = false;
  onKey: (owner: string, key: string) => Promise<boolean> = async (): Promise<boolean> => false;
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeRaised') themeRaised: string = '#262626';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeText') themeText: string = '#fafafa';
  private repeat = terminalRail.createTerminalAccessoryRepeatController();
  private owner: string = '';
  private pressOwner: string = '';
  private pressKey: string = '';
  private pressX: number = 0;
  private pressY: number = 0;
  private cancelled: boolean = false;
  private repeated: boolean = false;
  private down: boolean = false;

  aboutToAppear(): void { this.owner = this.claim?.owner ?? ''; }
  aboutToDisappear(): void { this.cancel(); }

  private claimChanged(): void {
    let owner = this.claim?.owner ?? '';
    if (this.owner !== owner || this.claim?.canSend !== true) { this.cancel(); }
    this.owner = owner;
  }

  private geometryChanged(): void { this.cancel(); }

  private cancel(): void { this.cancelled = true; this.down = false; this.repeat.cancel(); }

  private onTouchKey(key: string, event: TouchEvent): void {
    let touch = event.changedTouches[0];
    if (event.type === TouchType.Down && touch) {
      this.repeat.cancel();
      this.pressOwner = this.claim?.owner ?? ''; this.pressKey = key;
      this.pressX = touch.windowX; this.pressY = touch.windowY;
      this.down = true; this.cancelled = false; this.repeated = false;
    } else if (event.type === TouchType.Move && touch &&
      Math.hypot(touch.windowX - this.pressX, touch.windowY - this.pressY) > 8) {
      this.cancel();
    } else if (event.type === TouchType.Cancel) {
      this.cancel();
    } else if (event.type === TouchType.Up) {
      this.down = false; this.repeat.cancel();
    }
  }

  private tap(key: string): void {
    let owner = this.claim?.owner ?? '';
    let fromTouch = this.pressKey === key;
    let allowed = !fromTouch || (!this.cancelled && !this.repeated && this.pressOwner === owner);
    this.pressKey = '';
    if (allowed && owner) { this.onKey(owner, key).catch(() => {}); }
  }

  private hold(key: string): void {
    if (!TERMINAL_RAIL_ARROWS.includes(key) || !this.down || this.cancelled || this.pressKey !== key) { return; }
    this.repeated = true;
    let owner = this.pressOwner;
    this.repeat.start(key, (value: string): Promise<boolean> =>
      this.down && !this.cancelled && owner === this.claim?.owner ? this.onKey(owner, value) : Promise.resolve(false));
  }

  private t(label: string): string { return uiText(label, this.uiLocale); }
  private showPad(): boolean { return this.hasPad && this.claim?.directionPadEnabled !== false; }
  private latch(key: string): string {
    if (key === 'ctrl') { return this.claim?.ctrl ?? 'off'; }
    if (key === 'alt') { return this.claim?.alt ?? 'off'; }
    if (key === 'shift') { return this.claim?.shift ?? 'off'; }
    return key === 'toggleInputMode' && this.claim?.liveInputEnabled ? 'locked' : 'off';
  }

  private label(key: string): string {
    if (key === 'toggleKeyboard') { return this.t(this.claim?.keyboardVisible ? '收起键盘' : '显示键盘'); }
    if (key === 'toggleDisplayMode') { return this.t(this.claim?.phoneDisplayMode ? '桌面宽度' : '手机宽度'); }
    if (key === 'toggleInputMode') { return this.t('切换输入模式'); }
    if (key === 'moreKeys') { return this.t('更多按键和操作'); }
    if (key === 'ctrlC') { return this.t('中断终端'); }
    return this.t(ARROW_LABELS.get(key) ?? KEY_LABELS.get(key) ?? key.substring(5));
  }

  @Builder
  private icon(icon: Resource, key: string, size: number = 16) {
    Image(icon).supportSvg2(true).width(size).height(size)
      .colorFilter(lucideColorFilter(this.latch(key) === 'locked' ? this.themeBg : this.themeSecondary))
  }

  @Builder
  private railButton(key: string, width: string | number = '100%', height: number = 40) {
    Button({ type: ButtonType.Normal }) {
      if (key === 'toggleKeyboard') {
        Column() {
          this.icon($r('app.media.lucide_keyboard'), key)
          if (this.claim?.keyboardVisible) { this.icon($r('app.media.lucide_chevron_down'), key, 10) }
        }
      } else if (key === 'toggleDisplayMode') {
        if (this.claim?.phoneDisplayMode) { this.icon($r('app.media.lucide_monitor'), key) }
        else { this.icon($r('app.media.lucide_smartphone'), key) }
      } else if (key === 'toggleInputMode') {
        this.icon($r('app.media.lucide_chevrons_right'), key)
      } else if (key === 'moreKeys') {
        this.icon($r('app.media.lucide_ellipsis'), key, 18)
      } else {
        Text(KEY_LABELS.get(key) ?? key.substring(5)).fontFamily('monospace')
          .fontSize(this.showPad() && TERMINAL_RAIL_ARROWS.includes(key) ? 14 : 12)
          .maxLines(1).minFontSize(9).maxFontSize(this.showPad() && TERMINAL_RAIL_ARROWS.includes(key) ? 14 : 12)
          .fontColor(this.latch(key) === 'locked' ? this.themeBg : this.themeSecondary)
      }
    }.width(width).height(height).padding(0)
      .backgroundColor(this.latch(key) === 'locked' ? this.themeText : this.themeRaised)
      .border({ width: this.latch(key) === 'once' ? 1 : 0, radius: 12, color: this.themeText })
      .enabled(this.claim !== null && terminalRailKeyEnabled(this.claim, key))
      .accessibilityText(this.label(key)).accessibilitySelected(this.latch(key) !== 'off')
      .focusOnTouch(false).id(`terminal-rail-${key}`)
      .onTouch((event: TouchEvent): void => this.onTouchKey(key, event))
      .onClick((): void => this.tap(key))
      .gesture(LongPressGesture({ duration: terminalRail.TERMINAL_ACCESSORY_REPEAT_DELAY_MS })
        .onAction((): void => this.hold(key))
        .onActionCancel((): void => { if (this.repeated) { this.cancel(); } }))
  }

  @Builder
  private directionPad() {
    Column({ space: 4 }) {
      this.railButton('arrowUp', '100%', 44)
      Row({ space: 4 }) {
        this.railButton('arrowLeft', Math.min(32, (this.strip.width - 20) / 2), 44)
        this.railButton('arrowRight', Math.min(32, (this.strip.width - 20) / 2), 44)
      }.justifyContent(FlexAlign.Center)
      this.railButton('arrowDown', '100%', 44)
    }.width(Math.min(68, this.strip.width - 16)).padding({ top: 4, bottom: 4 })
  }

  build() {
    Column() {
      Scroll() {
        Column({ space: 4 }) {
          if (this.showPad() && !terminalRail.hasTerminalDirectionPadSpace(this.strip)) { this.directionPad() }
          ForEach(this.keys, (key: string): void => {
            if (!this.showPad() || !TERMINAL_RAIL_ARROWS.includes(key)) { this.railButton(key) }
          }, (key: string): string => key)
        }.width('100%').padding({ top: 4, bottom: 4, left: 8, right: 8 })
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top)
        .onScrollStart((): void => this.cancel())
      if (this.showPad() && terminalRail.hasTerminalDirectionPadSpace(this.strip)) { this.directionPad() }
    }.width(this.strip.width).height(this.strip.height).backgroundColor(this.themeBg)
  }
}
