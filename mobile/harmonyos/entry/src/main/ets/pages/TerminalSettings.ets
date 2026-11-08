import { router } from '@kit.ArkUI';
import {
  getString,
  getNumber,
  getBool,
  setString,
  setNumber,
  setBool,
  KEY_TERMINAL_FONT_SCALE,
  KEY_TERMINAL_FONT_FAMILY,
  KEY_TERMINAL_SHOW_KEY_RAIL,
  FONT_FAMILY_OPTIONS,
  FONT_FAMILY_MONO,
  OptionEntry
} from '../settings/SettingsStore';

/** 会话打开时应用字号和快捷键设置；终端固定使用等宽字体。 */

@Entry
@Component
struct TerminalSettings {
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#1c1c1c';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeSecondary') themeSecondary: string = '#b5bec9';
  @StorageProp('themeAccent') themeAccent: string = '#7ddf7d';
  @StorageProp('themeLink') themeLink: string = '#96b8e5';
  @StorageProp('themeWarning') themeWarning: string = '#e0c070';
  @State fontScale: number = 14;
  @State fontFamily: string = FONT_FAMILY_MONO;
  @State showKeyRail: boolean = true;

  aboutToAppear(): void {
    let ctx = getContext(this);
    getNumber(ctx, KEY_TERMINAL_FONT_SCALE).then((v: number) => {
      this.fontScale = v;
    }).catch((e: Error) => {
      // 读取失败保持默认 14
    });
    getString(ctx, KEY_TERMINAL_FONT_FAMILY).then((v: string) => {
      this.fontFamily = v;
    }).catch((e: Error) => {
      // 读取失败保持默认等宽
    });
    getBool(ctx, KEY_TERMINAL_SHOW_KEY_RAIL).then((v: boolean) => {
      this.showKeyRail = v;
    }).catch((e: Error) => {
      // 读取失败保持默认显示
    });
  }

  persistFontScale(value: number): void {
    let snapped = Math.round(value);
    if (snapped < 12) {
      snapped = 12;
    }
    if (snapped > 24) {
      snapped = 24;
    }
    this.fontScale = snapped;
    setNumber(getContext(this), KEY_TERMINAL_FONT_SCALE, snapped).catch((e: Error) => {
      // 忽略写失败
    });
  }

  selectFontFamily(value: string): void {
    if (value !== FONT_FAMILY_MONO) { return; }
    this.fontFamily = value;
    setString(getContext(this), KEY_TERMINAL_FONT_FAMILY, value).catch((e: Error) => {
      // 忽略写失败
    });
  }

  toggleKeyRail(isOn: boolean): void {
    this.showKeyRail = isOn;
    setBool(getContext(this), KEY_TERMINAL_SHOW_KEY_RAIL, isOn).catch((e: Error) => {
      // 忽略写失败
    });
  }

  build() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Text('‹')
          .fontSize(22)
          .fontColor(this.themeAccent)
          .width(32)
          .height(32)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            router.back();
          })
        Text('终端显示')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 10, right: 14, top: 10 })

      List({ space: 14 }) {
        // 字体大小
        ListItem() {
          Column({ space: 8 }) {
            Text('字体大小')
              .fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Column({ space: 12 }) {
              Row({ space: 10 }) {
                Text('终端字号')
                  .fontSize(15)
                  .fontColor(this.themeText)
                  .layoutWeight(1)
                Text(`${Math.round(this.fontScale)} px`)
                  .fontSize(14)
                  .fontColor(this.themeLink)
              }
              .width('100%')

              Slider({ value: this.fontScale, min: 12, max: 24, step: 1 })
                .width('100%')
                .selectedColor('#2a6a5a')
                .blockColor(this.themeAccent)
                .onChange((value: number, mode: SliderChangeMode) => {
                  this.fontScale = value;
                  if (mode === SliderChangeMode.End) {
                    this.persistFontScale(value);
                  }
                })
            }
            .width('100%')
            .padding(14)
            .borderRadius(12)
            .backgroundColor(this.themeSurface)
            .border({ width: 1, color: this.themeBorder })
          }
          .width('100%')
        }

        // 字体选择（Toggle 组）
        ListItem() {
          Column({ space: 8 }) {
            Text('字体')
              .fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Column() {
              ForEach(FONT_FAMILY_OPTIONS, (opt: OptionEntry, index: number) => {
                Column() {
                  Row({ space: 10 }) {
                    Column({ space: 3 }) {
                      Text(opt.label)
                        .fontSize(15)
                        .fontColor(this.fontFamily === opt.value ? this.themeAccent : this.themeText)
                      Text(opt.desc)
                        .fontSize(11)
                        .fontColor(this.themeMuted)
                    }
                    .alignItems(HorizontalAlign.Start)
                    .layoutWeight(1)

                    Text(this.fontFamily === opt.value ? '✓' : '')
                      .fontSize(16)
                      .fontWeight(FontWeight.Bold)
                      .fontColor(this.themeAccent)
                      .width(24)
                      .textAlign(TextAlign.Center)
                  }
                  .width('100%')
                  .enabled(opt.value === FONT_FAMILY_MONO)
                  .opacity(opt.value === FONT_FAMILY_MONO ? 1 : 0.5)
                  .padding({ top: 12, bottom: 12, left: 14, right: 14 })
                  .onClick(() => {
                    this.selectFontFamily(opt.value);
                  })

                  if (index < FONT_FAMILY_OPTIONS.length - 1) {
                    Divider()
                      .color(this.themeBorder)
                      .strokeWidth(1)
                      .margin({ left: 14 })
                  }
                }
              }, (opt: OptionEntry, index: number) => `${index}-${opt.value}`)
            }
            .width('100%')
            .borderRadius(12)
            .backgroundColor(this.themeSurface)
            .border({ width: 1, color: this.themeBorder })
            .clip(true)
          }
          .width('100%')
        }

        // 预览
        ListItem() {
          Column({ space: 8 }) {
            Text('预览')
              .fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Column({ space: 4 }) {
              Text('$ orca session list')
                .fontFamily(this.fontFamily === FONT_FAMILY_MONO ? 'monospace' : 'sans-serif')
                .fontSize(Math.round(this.fontScale))
                .fontColor('#a0c8a0')
              Text('connected to desktop · 42ms')
                .fontFamily(this.fontFamily === FONT_FAMILY_MONO ? 'monospace' : 'sans-serif')
                .fontSize(Math.round(this.fontScale))
                .fontColor(this.themeMuted)
            }
            .width('100%')
            .padding(12)
            .borderRadius(8)
            .backgroundColor(this.themeBg)
            .border({ width: 1, color: this.themeBorder })
            .alignItems(HorizontalAlign.Start)
          }
          .width('100%')
        }

        // 辅助键排显隐
        ListItem() {
          Column({ space: 8 }) {
            Text('辅助键排')
              .fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Row({ space: 10 }) {
              Column({ space: 3 }) {
                Text('显示辅助键排')
                  .fontSize(15)
                  .fontColor(this.themeText)
                Text('显示 Esc / Tab / 方向键等快捷键；粘贴和输入入口始终保留')
                  .fontSize(11)
                  .fontColor(this.themeMuted)
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)

              Toggle({ type: ToggleType.Switch, isOn: this.showKeyRail })
                .selectedColor('#2a6a5a')
                .onChange((isOn: boolean) => {
                  this.toggleKeyRail(isOn);
                })
            }
            .width('100%')
            .padding(14)
            .borderRadius(12)
            .backgroundColor(this.themeSurface)
            .border({ width: 1, color: this.themeBorder })
          }
          .width('100%')
        }
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ left: 12, right: 12 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.themeBg)
  }
}
