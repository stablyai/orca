import { uiText } from '../settings/NativeUi';
import { common } from '@kit.AbilityKit';
import { NativeSpeech } from '../webshell/NativeSpeech';
import { router } from '@kit.ArkUI';
import {
  getString,
  setString,
  KEY_DICTATION_ENGINE,
  DICTATION_ENGINE_OPTIONS,
  DICTATION_ENGINE_DESKTOP,
  DICTATION_ENGINE_AUTOMATIC,
  DICTATION_ENGINE_ONDEVICE,
  OptionEntry
} from '../settings/SettingsStore';

/** 识别能力由系统引擎实时探测，不以设置值代替可用性。 */

@Entry
@Component
struct VoiceSettings {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeBorder') themeBorder: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeAccent') themeAccent: string = '#3276f2';
  @StorageProp('themeLink') themeLink: string = '#3276f2';
  @StorageProp('themeWarning') themeWarning: string = '#eab308';
  @State error: string = '';
  @State engine: string = DICTATION_ENGINE_AUTOMATIC;
  @State localStatus: string = '正在检测本机识别';
  private speech: NativeSpeech | null = null;

  aboutToDisappear(): void { this.speech?.dispose(); this.speech = null; }

  aboutToAppear(): void {
    let speech = new NativeSpeech(getContext(this) as common.UIAbilityContext); this.speech = speech;
    speech.serve({ action: 'status', locale: 'zh-CN' }).then((result: ESObject): void => {
      if (this.speech !== speech) { return; }
      this.localStatus = result.status === 'ready' ? '离线普通话识别可用' : result.status === 'busy' ? '系统识别服务忙，请稍后重试' : '当前设备的离线识别服务不可用';
    }).catch((): void => { this.localStatus = '无法检测本机识别服务'; }).finally((): void => { speech.dispose(); if (this.speech === speech) { this.speech = null; } });
    getString(getContext(this), KEY_DICTATION_ENGINE).then((v: string) => {
      this.engine = v;
    }).catch((e: Error) => {
      // 读取失败保持默认桌面转写
    });
  }

  selectEngine(value: string): void {
    setString(getContext(this), KEY_DICTATION_ENGINE, value).then((): void => { this.engine = value; this.error = ''; }).catch((e: Error) => {
      this.error = '无法保存语音设置，请重试';
    });
  }

  build() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Text('‹')
          .fontFamily('Geist').fontSize(22)
          .fontColor(this.themeAccent)
          .width(32)
          .height(32)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            router.back();
          })
        Text(uiText('语音', this.uiLocale))
          .fontFamily('Geist').fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 10, right: 14, top: 10 })

      Text(this.localStatus).fontFamily('Geist').fontSize(12).fontColor(this.themeMuted).width('100%').padding({ left: 16, right: 16 })
      if (this.error.length > 0) { Text(this.error).fontFamily('Geist').fontSize(13).fontColor(this.themeText).padding(12) }
      List({ space: 14 }) {
        // 听写引擎选择
        ListItem() {
          Column({ space: 8 }) {
            Text(uiText('听写引擎', this.uiLocale))
              .fontFamily('Geist').fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Column() {
              ForEach(DICTATION_ENGINE_OPTIONS, (opt: OptionEntry, index: number) => {
                Column() {
                  Row({ space: 10 }) {
                    Column({ space: 3 }) {
                      Text(uiText(opt.label, this.uiLocale))
                        .fontFamily('Geist').fontSize(15)
                        .fontColor(this.engine === opt.value ? this.themeAccent : this.themeText)
                      Text(uiText(opt.desc, this.uiLocale))
                        .fontFamily('Geist').fontSize(11)
                        .fontColor(this.themeMuted)
                    }
                    .alignItems(HorizontalAlign.Start)
                    .layoutWeight(1)

                    Text(this.engine === opt.value ? '✓' : '')
                      .fontFamily('Geist').fontSize(16)
                      .fontWeight(FontWeight.Bold)
                      .fontColor(this.themeAccent)
                      .width(24)
                      .textAlign(TextAlign.Center)
                  }
                  .width('100%')
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
                  .fontFamily('Geist').fontSize(14)
                  .fontColor(this.themeWarning)
                Text(uiText('本机识别仅支持系统提供的离线普通话。系统服务不可用或当前语言不支持时会提示失败，不会将音频发送到电脑。', this.uiLocale))
                  .fontFamily('Geist').fontSize(12)
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
              Text(uiText('说明', this.uiLocale))
                .fontFamily('Geist').fontSize(14)
                .fontColor(this.themeLink)
              Text(uiText('听写在会话页通过麦克风按钮触发；桌面转写会把音频流经加密通道发送到已配对桌面处理。', this.uiLocale))
                .fontFamily('Geist').fontSize(12)
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
