import { lucideColorFilter } from '../settings/LucideColor';
import { uiText } from '../settings/NativeUi';
import { SETTINGS_MENU_ITEMS, SettingsMenuItem } from '../settings/SettingsMenu';
import { router } from '@kit.ArkUI';
import {
  getString,
  optionLabel,
  THEME_MODE_OPTIONS,
  DICTATION_ENGINE_OPTIONS,
  KEY_THEME_MODE,
  KEY_DICTATION_ENGINE
} from '../settings/SettingsStore';

/**
 * 设置主页：分组导航（外观 / 终端 / 语音 / 通知 / 连接诊断 / 关于）。
 * 每一项点击后 router.pushUrl 进入对应子页；部分条目右侧显示当前值摘要，
 * 从子页返回时（onPageShow）刷新摘要。
 */

interface SettingsItem {
  icon: Resource;
  title: string;
  subtitle: string;
  target: string;
  tag: string; // '' | 'theme' | 'dictation'：控制右侧当前值摘要
}

interface SettingsGroup {
  name: string;
  items: SettingsItem[];
}

@Entry
@Component
struct Settings {
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
  @State themeSummary: string = '';
  @State dictationSummary: string = '';

  private groups: SettingsGroup[] = [{ name: '设置', items: SETTINGS_MENU_ITEMS.map((item: SettingsMenuItem): SettingsItem => {
    return { icon: item.icon, title: item.label, subtitle: item.subtitle, target: item.target, tag: item.tag };
  }) }];

  aboutToAppear(): void {
    this.refreshSummaries();
  }

  onPageShow(): void {
    this.refreshSummaries();
  }

  refreshSummaries(): void {
    let ctx = getContext(this);
    getString(ctx, KEY_THEME_MODE).then((v: string) => {
      this.themeSummary = optionLabel(THEME_MODE_OPTIONS, v);
    }).catch((e: Error) => {
      this.themeSummary = '';
    });
    getString(ctx, KEY_DICTATION_ENGINE).then((v: string) => {
      this.dictationSummary = optionLabel(DICTATION_ENGINE_OPTIONS, v);
    }).catch((e: Error) => {
      this.dictationSummary = '';
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
        Text(uiText('设置', this.uiLocale))
          .fontFamily('Geist').fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 10, right: 14, top: 10 })

      List({ space: 14 }) {
        ForEach(this.groups, (group: SettingsGroup, gIndex: number) => {
          ListItem() {
            Column({ space: 8 }) {
              Text(group.name)
                .fontFamily('Geist').fontSize(12)
                .fontColor(this.themeMuted)
                .width('100%')
                .padding({ left: 4 })
              Column() {
                ForEach(group.items, (item: SettingsItem, index: number) => {
                  Column() {
                    Row({ space: 10 }) {
                      Image(item.icon).supportSvg2(true).width(18).height(18).colorFilter(lucideColorFilter(this.themeSecondary))
                      Column({ space: 3 }) {
                        Text(item.title)
                          .fontFamily('Geist').fontSize(15)
                          .fontColor(this.themeText)
                        Text(uiText(item.subtitle, this.uiLocale))
                          .fontFamily('Geist').fontSize(11)
                          .fontColor(this.themeMuted)
                      }
                      .alignItems(HorizontalAlign.Start)
                      .layoutWeight(1)

                      if (item.tag === 'theme' && this.themeSummary.length > 0) {
                        Text(this.themeSummary)
                          .fontFamily('Geist').fontSize(12)
                          .fontColor(this.themeLink)
                          .maxLines(1)
                      }
                      if (item.tag === 'dictation' && this.dictationSummary.length > 0) {
                        Text(this.dictationSummary)
                          .fontFamily('Geist').fontSize(12)
                          .fontColor(this.themeLink)
                          .maxLines(1)
                      }
                      Text('›')
                        .fontFamily('Geist').fontSize(18)
                        .fontColor(this.themeMuted)
                    }
                    .width('100%')
                    .padding({ top: 13, bottom: 13, left: 14, right: 14 })
                    .onClick(() => {
                      router.pushUrl({ url: item.target });
                    })

                    if (index < group.items.length - 1) {
                      Divider()
                        .color(this.themeBorder)
                        .strokeWidth(1)
                        .margin({ left: 14 })
                    }
                  }
                }, (item: SettingsItem, index: number) => `${index}-${item.target}`)
              }
              .width('100%')
              .borderRadius(12)
              .backgroundColor(this.themeSurface)
              .border({ width: 1, color: this.themeBorder })
              .clip(true)
            }
            .width('100%')
          }
        }, (group: SettingsGroup, gIndex: number) => `${gIndex}-${group.name}`)
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
