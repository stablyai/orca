import { applyThemeMode } from '../settings/Appearance';
import { router } from '@kit.ArkUI';
import {
  getString,
  getNumber,
  setString,
  setNumber,
  KEY_THEME_MODE,
  KEY_HOME_FONT_SCALE,
  THEME_MODE_OPTIONS,
  THEME_MODE_SYSTEM,
  OptionEntry
} from '../settings/SettingsStore';

@Entry
@Component
struct AppearanceSettings {
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#1c1c1c';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeSecondary') themeSecondary: string = '#b5bec9';
  @StorageProp('themeAccent') themeAccent: string = '#7ddf7d';
  @StorageProp('themeLink') themeLink: string = '#96b8e5';
  @StorageProp('themeWarning') themeWarning: string = '#e0c070';
  @State themeMode: string = THEME_MODE_SYSTEM;
  @State homeScale: number = 1;

  aboutToAppear(): void {
    let ctx = getContext(this);
    getString(ctx, KEY_THEME_MODE).then((v: string) => {
      this.themeMode = v;
    }).catch((e: Error) => {
      // 读取失败保持默认（跟随系统）
    });
    getNumber(ctx, KEY_HOME_FONT_SCALE).then((v: number) => {
      this.homeScale = v;
    }).catch((e: Error) => {
      // 读取失败保持默认 100%
    });
  }

  selectTheme(value: string): void {
    this.themeMode = value;
    applyThemeMode(value);
    setString(getContext(this), KEY_THEME_MODE, value).catch((e: Error) => {
      // 写入失败时，下次进入回落到默认值
    });
  }

  persistHomeScale(value: number): void {
    // 步进 0.05，吸附到 5% 网格消除浮点误差
    let snapped = Math.round(value * 20) / 20;
    this.homeScale = snapped;
    setNumber(getContext(this), KEY_HOME_FONT_SCALE, snapped).catch((e: Error) => {
      // 忽略写失败
    });
  }

  scalePercent(): string {
    return `${Math.round(this.homeScale * 100)}%`;
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
        Text('外观')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 10, right: 14, top: 10 })

      List({ space: 14 }) {
        // 主题模式
        ListItem() {
          Column({ space: 8 }) {
            Text('主题模式')
              .fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Column() {
              ForEach(THEME_MODE_OPTIONS, (opt: OptionEntry, index: number) => {
                Column() {
                  Row({ space: 10 }) {
                    Column({ space: 3 }) {
                      Text(opt.label)
                        .fontSize(15)
                        .fontColor(this.themeMode === opt.value ? this.themeAccent : this.themeText)
                      Text(opt.desc)
                        .fontSize(11)
                        .fontColor(this.themeMuted)
                    }
                    .alignItems(HorizontalAlign.Start)
                    .layoutWeight(1)

                    Text(this.themeMode === opt.value ? '✓' : '')
                      .fontSize(16)
                      .fontWeight(FontWeight.Bold)
                      .fontColor(this.themeAccent)
                      .width(24)
                      .textAlign(TextAlign.Center)
                  }
                  .width('100%')
                  .padding({ top: 12, bottom: 12, left: 14, right: 14 })
                  .onClick(() => {
                    this.selectTheme(opt.value);
                  })

                  if (index < THEME_MODE_OPTIONS.length - 1) {
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

            Text('主题立即生效，并在下次启动时保留。')
              .fontSize(11)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
          }
          .width('100%')
        }

        // 主页字号缩放
        ListItem() {
          Column({ space: 8 }) {
            Text('主页字号缩放')
              .fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Column({ space: 12 }) {
              Row({ space: 10 }) {
                Text('缩放比例')
                  .fontSize(15)
                  .fontColor(this.themeText)
                  .layoutWeight(1)
                Text(this.scalePercent())
                  .fontSize(14)
                  .fontColor(this.themeLink)
              }
              .width('100%')

              Slider({ value: this.homeScale, min: 0.8, max: 1.5, step: 0.05 })
                .width('100%')
                .selectedColor('#2a6a5a')
                .blockColor(this.themeAccent)
                .onChange((value: number, mode: SliderChangeMode) => {
                  this.homeScale = value;
                  if (mode === SliderChangeMode.End) {
                    this.persistHomeScale(value);
                  }
                })

              Column({ space: 4 }) {
                Text('预览 · 会话列表')
                  .fontSize(Math.round(16 * this.homeScale))
                  .fontWeight(FontWeight.Medium)
                  .fontColor(this.themeText)
                Text('桌面连接正常 · 终端会话进行中')
                  .fontSize(Math.round(12 * this.homeScale))
                  .fontColor(this.themeSecondary)
              }
              .width('100%')
              .padding(12)
              .borderRadius(8)
              .backgroundColor(this.themeBg)
              .border({ width: 1, color: this.themeBorder })
              .alignItems(HorizontalAlign.Start)
            }
            .width('100%')
            .padding(14)
            .borderRadius(12)
            .backgroundColor(this.themeSurface)
            .border({ width: 1, color: this.themeBorder })

            Text('主页列表字号按此比例缩放；终端字号在「终端显示」中单独设置。')
              .fontSize(11)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
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
