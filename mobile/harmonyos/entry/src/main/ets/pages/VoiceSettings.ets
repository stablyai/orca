import { router } from '@kit.ArkUI';
import {
  getString,
  setString,
  KEY_DICTATION_ENGINE,
  DICTATION_ENGINE_OPTIONS,
  DICTATION_ENGINE_DESKTOP,
  DICTATION_ENGINE_ONDEVICE,
  OptionEntry
} from '../settings/SettingsStore';

/** 当前支持加密桌面转写；端上识别明确禁用。 */

@Entry
@Component
struct VoiceSettings {
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#1c1c1c';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeSecondary') themeSecondary: string = '#b5bec9';
  @StorageProp('themeAccent') themeAccent: string = '#7ddf7d';
  @StorageProp('themeLink') themeLink: string = '#96b8e5';
  @StorageProp('themeWarning') themeWarning: string = '#e0c070';
  @State engine: string = DICTATION_ENGINE_DESKTOP;

  aboutToAppear(): void {
    getString(getContext(this), KEY_DICTATION_ENGINE).then((v: string) => {
      this.engine = DICTATION_ENGINE_DESKTOP;
    }).catch((e: Error) => {
      // 读取失败保持默认桌面转写
    });
  }

  selectEngine(value: string): void {
    if (value === DICTATION_ENGINE_ONDEVICE) { return; }
    this.engine = value;
    setString(getContext(this), KEY_DICTATION_ENGINE, value).catch((e: Error) => {
      // 写入失败时，下次进入回落到默认值
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
        Text('语音')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 10, right: 14, top: 10 })

      List({ space: 14 }) {
        // 听写引擎选择
        ListItem() {
          Column({ space: 8 }) {
            Text('听写引擎')
              .fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Column() {
              ForEach(DICTATION_ENGINE_OPTIONS, (opt: OptionEntry, index: number) => {
                Column() {
                  Row({ space: 10 }) {
                    Column({ space: 3 }) {
                      Text(opt.label)
                        .fontSize(15)
                        .fontColor(this.engine === opt.value ? this.themeAccent : this.themeText)
                      Text(opt.desc)
                        .fontSize(11)
                        .fontColor(this.themeMuted)
                    }
                    .alignItems(HorizontalAlign.Start)
                    .layoutWeight(1)

                    Text(this.engine === opt.value ? '✓' : '')
                      .fontSize(16)
                      .fontWeight(FontWeight.Bold)
                      .fontColor(this.themeAccent)
                      .width(24)
                      .textAlign(TextAlign.Center)
                  }
                  .width('100%')
                  .enabled(opt.value !== DICTATION_ENGINE_ONDEVICE)
                  .opacity(opt.value !== DICTATION_ENGINE_ONDEVICE ? 1 : 0.5)
                  .padding({ top: 12, bottom: 12, left: 14, right: 14 })
                  .onClick(() => {
                    this.selectEngine(opt.value);
                  })

                  if (index < DICTATION_ENGINE_OPTIONS.length - 1) {
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

        // 实验性提示
        ListItem() {
          Column({ space: 8 }) {
            if (this.engine === DICTATION_ENGINE_ONDEVICE) {
              Row({ space: 8 }) {
                Text('⚠')
                  .fontSize(14)
                  .fontColor(this.themeWarning)
                Text('端上识别为实验特性：识别质量依赖设备性能与语速，复杂指令可能被误识别。遇到问题请切回桌面转写。')
                  .fontSize(12)
                  .fontColor(this.themeWarning)
                  .layoutWeight(1)
                  .lineHeight(18)
              }
              .width('100%')
              .padding(12)
              .borderRadius(10)
              .backgroundColor(this.themeSurface)
              .border({ width: 1, color: '#5a4a2a' })
            }

            Row({ space: 8 }) {
              Text('说明')
                .fontSize(14)
                .fontColor(this.themeLink)
              Text('听写在会话页通过麦克风按钮触发；桌面转写会把音频流经加密通道发送到已配对桌面处理。')
                .fontSize(12)
                .fontColor(this.themeSecondary)
                .layoutWeight(1)
                .lineHeight(18)
            }
            .width('100%')
            .padding(12)
            .borderRadius(10)
            .backgroundColor(this.themeSurface)
            .border({ width: 1, color: this.themeBorder })
            .alignItems(VerticalAlign.Top)
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
