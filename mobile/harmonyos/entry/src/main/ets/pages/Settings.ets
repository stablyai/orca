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
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#1c1c1c';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeSecondary') themeSecondary: string = '#b5bec9';
  @StorageProp('themeAccent') themeAccent: string = '#7ddf7d';
  @StorageProp('themeLink') themeLink: string = '#96b8e5';
  @StorageProp('themeWarning') themeWarning: string = '#e0c070';
  @State themeSummary: string = '';
  @State dictationSummary: string = '';

  private groups: SettingsGroup[] = [
    {
      name: '外观',
      items: [
        { title: '主题与字号', subtitle: '主题模式、主页字号缩放', target: 'pages/AppearanceSettings', tag: 'theme' }
      ]
    },
    {
      name: '终端',
      items: [
        { title: '终端显示', subtitle: '字体大小、等宽字体、辅助键排', target: 'pages/TerminalSettings', tag: '' }
      ]
    },
    {
      name: '语音',
      items: [
        { title: '听写引擎', subtitle: '桌面转写 / 端上识别', target: 'pages/VoiceSettings', tag: 'dictation' }
      ]
    },
    {
      name: '通知',
      items: [
        { title: '通知设置', subtitle: '本地通知开关、免打扰', target: 'pages/NotificationSettings', tag: '' }
      ]
    },
    {
      name: '连接诊断',
      items: [
        { title: '连接诊断', subtitle: '已配对主机与排查提示', target: 'pages/Troubleshoot', tag: '' },
        { title: '连接事件日志', subtitle: '最近 100 条连接事件', target: 'pages/ConnectionLog', tag: '' }
      ]
    },
    {
      name: '关于',
      items: [
        { title: '关于 Orca Mobile', subtitle: '版本信息、致谢与开源许可', target: 'pages/About', tag: '' }
      ]
    }
  ];

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
          .fontSize(22)
          .fontColor(this.themeAccent)
          .width(32)
          .height(32)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            router.back();
          })
        Text('设置')
          .fontSize(20)
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
                .fontSize(12)
                .fontColor(this.themeMuted)
                .width('100%')
                .padding({ left: 4 })
              Column() {
                ForEach(group.items, (item: SettingsItem, index: number) => {
                  Column() {
                    Row({ space: 10 }) {
                      Column({ space: 3 }) {
                        Text(item.title)
                          .fontSize(15)
                          .fontColor(this.themeText)
                        Text(item.subtitle)
                          .fontSize(11)
                          .fontColor(this.themeMuted)
                      }
                      .alignItems(HorizontalAlign.Start)
                      .layoutWeight(1)

                      if (item.tag === 'theme' && this.themeSummary.length > 0) {
                        Text(this.themeSummary)
                          .fontSize(12)
                          .fontColor(this.themeLink)
                          .maxLines(1)
                      }
                      if (item.tag === 'dictation' && this.dictationSummary.length > 0) {
                        Text(this.dictationSummary)
                          .fontSize(12)
                          .fontColor(this.themeLink)
                          .maxLines(1)
                      }
                      Text('›')
                        .fontSize(18)
                        .fontColor('#555555')
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
