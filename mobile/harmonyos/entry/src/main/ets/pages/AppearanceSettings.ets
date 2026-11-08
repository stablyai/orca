import { uiText, UI_LANGUAGE_CHOICES, UiLanguageChoice, setUiLanguage } from '../settings/NativeUi';
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
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('uiLanguagePreference') language: string = 'system';
  @State languageSaving: boolean = false;
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

  async selectTheme(value: string): Promise<void> {
    try {
      await setString(getContext(this), KEY_THEME_MODE, value);
      this.themeMode = value; applyThemeMode(value); this.error = '';
    } catch (e) { this.error = '无法保存主题，请重试'; }
  }

  async persistHomeScale(value: number): Promise<void> {
    let snapped = Math.max(0.8, Math.min(1.5, Math.round(value * 20) / 20));
    try { await setNumber(getContext(this), KEY_HOME_FONT_SCALE, snapped); this.homeScale = snapped; this.error = ''; }
    catch (e) { this.error = '无法保存字号，请重试'; this.homeScale = await getNumber(getContext(this), KEY_HOME_FONT_SCALE); }
  }

  private async chooseLanguage(value: string): Promise<void> {
    if (this.languageSaving) { return; } this.languageSaving = true;
    try { await setUiLanguage(getContext(this), value); this.error = ''; }
    catch (e) { this.error = '无法保存语言，请重试'; }
    finally { this.languageSaving = false; }
  }

  scalePercent(): string {
    return `${Math.round(this.homeScale * 100)}%`;
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
        Text(uiText('外观', this.uiLocale))
          .fontFamily('Geist').fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 10, right: 14, top: 10 })

      if (this.error.length > 0) { Text(this.error).fontFamily('Geist').fontSize(13).fontColor(this.themeText).padding(12) }
      List({ space: 14 }) {
        // 主题模式
        ListItem() {
          Column({ space: 8 }) {
            Text(uiText('主题模式', this.uiLocale))
              .fontFamily('Geist').fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Column() {
              ForEach(THEME_MODE_OPTIONS, (opt: OptionEntry, index: number) => {
                Column() {
                  Row({ space: 10 }) {
                    Column({ space: 3 }) {
                      Text(uiText(opt.label, this.uiLocale))
                        .fontFamily('Geist').fontSize(15)
                        .fontColor(this.themeMode === opt.value ? this.themeAccent : this.themeText)
                      Text(uiText(opt.desc, this.uiLocale))
                        .fontFamily('Geist').fontSize(11)
                        .fontColor(this.themeMuted)
                    }
                    .alignItems(HorizontalAlign.Start)
                    .layoutWeight(1)

                    Text(this.themeMode === opt.value ? '✓' : '')
                      .fontFamily('Geist').fontSize(16)
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

            Text(uiText('主题立即生效，并在下次启动时保留。', this.uiLocale))
              .fontFamily('Geist').fontSize(11)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
          }
          .width('100%')
        }

        ListItem() {
          Column({ space: 8 }) {
            Text(uiText('语言', this.uiLocale)).fontFamily('Geist').fontSize(12).fontColor(this.themeMuted).width('100%')
            ForEach(UI_LANGUAGE_CHOICES, (choice: UiLanguageChoice) => {
              Row() {
                Text(choice.value === 'system' ? uiText('跟随系统', this.uiLocale) : choice.label)
                  .fontFamily('Geist').fontSize(15).fontColor(this.themeText).layoutWeight(1)
                Text(this.language === choice.value ? '✓' : '').fontFamily('Geist').fontSize(16).fontColor(this.themeAccent)
              }.width('100%').padding(12).enabled(!this.languageSaving).onClick(() => { this.chooseLanguage(choice.value); })
            }, (choice: UiLanguageChoice): string => choice.value)
          }.padding(14).width('100%').backgroundColor(this.themeSurface).borderRadius(12)
        }
        // 主页字号缩放
        ListItem() {
          Column({ space: 8 }) {
            Text(uiText('主页字号缩放', this.uiLocale))
              .fontFamily('Geist').fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })
            Column({ space: 12 }) {
              Row({ space: 10 }) {
                Text(uiText('缩放比例', this.uiLocale))
                  .fontFamily('Geist').fontSize(15)
                  .fontColor(this.themeText)
                  .layoutWeight(1)
                Text(this.scalePercent())
                  .fontFamily('Geist').fontSize(14)
                  .fontColor(this.themeLink)
              }
              .width('100%')

              Slider({ value: this.homeScale, min: 0.8, max: 1.5, step: 0.05 })
                .width('100%')
                .selectedColor(this.themeAccent)
                .blockColor(this.themeAccent)
                .onChange((value: number, mode: SliderChangeMode) => {
                  this.homeScale = value;
                  if (mode === SliderChangeMode.End) {
                    this.persistHomeScale(value);
                  }
                })

              Column({ space: 4 }) {
                Text(uiText('预览 · 会话列表', this.uiLocale))
                  .fontFamily('Geist').fontSize(Math.round(16 * this.homeScale))
                  .fontWeight(FontWeight.Medium)
                  .fontColor(this.themeText)
                Text(uiText('桌面连接正常 · 终端会话进行中', this.uiLocale))
                  .fontFamily('Geist').fontSize(Math.round(12 * this.homeScale))
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

            Text(uiText('主页列表字号按此比例缩放；终端字号在「终端显示」中单独设置。', this.uiLocale))
              .fontFamily('Geist').fontSize(11)
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
