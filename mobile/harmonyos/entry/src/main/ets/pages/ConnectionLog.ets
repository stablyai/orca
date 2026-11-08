import { uiText } from '../settings/NativeUi';
import { router } from '@kit.ArkUI';
import {
  listLogs,
  clearLogs,
  ConnectionLogEntry,
  LOG_LEVEL_INFO,
  LOG_LEVEL_WARN,
  LOG_LEVEL_ERROR
} from '../diagnostics/ConnectionLogStore';

/** 展示配对、连接与会话加载事件，提供清空入口。 */

@Entry
@Component
struct ConnectionLog {
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
  @State entries: ConnectionLogEntry[] = [];
  @State loaded: boolean = false;

  aboutToAppear(): void {
    this.reload();
  }

  onPageShow(): void {
    this.reload();
  }

  reload(): void {
    listLogs(getContext(this)).then((entries: ConnectionLogEntry[]) => {
      // 展示按时间倒序（最新在最前）
      this.entries = entries.slice().reverse();
      this.loaded = true;
    }).catch((e: Error) => {
      this.entries = [];
      this.loaded = true;
    });
  }

  doClear(): void {
    clearLogs(getContext(this)).then(() => {
      this.entries = [];
    }).catch((e: Error) => {
      // 清空失败时保留现有展示
    });
  }

  levelColor(level: string): string {
    if (level === LOG_LEVEL_ERROR) {
      return '#e0a0a0';
    }
    if (level === LOG_LEVEL_WARN) {
      return this.themeWarning;
    }
    if (level === LOG_LEVEL_INFO) {
      return '#a0c8a0';
    }
    return '#a0c8a0';
  }

  levelTag(level: string): string {
    if (level === LOG_LEVEL_ERROR) {
      return '错误';
    }
    if (level === LOG_LEVEL_WARN) {
      return '警告';
    }
    if (level === LOG_LEVEL_INFO) {
      return '信息';
    }
    return '信息';
  }

  formatTs(ts: number): string {
    let d = new Date(ts);
    let pad = (n: number): string => {
      return (n < 10 ? '0' : '') + n.toString();
    };
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
        Text(uiText('连接事件日志', this.uiLocale))
          .fontFamily('Geist').fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
        Button(uiText('清空', this.uiLocale))
          .fontFamily('Geist').fontSize(12)
          .height(32)
          .backgroundColor('#5a2a2a')
          .onClick(() => {
            this.doClear();
          })
      }
      .width('100%')
      .padding({ left: 10, right: 14, top: 10 })

      if (this.loaded && this.entries.length === 0) {
        Column({ space: 8 }) {
          Text(uiText('暂无连接事件', this.uiLocale))
            .fontFamily('Geist').fontSize(15)
            .fontColor(this.themeSecondary)
          Text(uiText('连接与配对事件会自动记录在这里', this.uiLocale))
            .fontFamily('Geist').fontSize(12)
            .fontColor(this.themeMuted)
            .textAlign(TextAlign.Center)
            .width('80%')
        }
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        List({ space: 6 }) {
          ForEach(this.entries, (entry: ConnectionLogEntry, index: number) => {
            ListItem() {
              Column({ space: 4 }) {
                Row({ space: 8 }) {
                  Text(this.formatTs(entry.ts))
                    .fontFamily('Geist').fontSize(10)
                    .fontColor(this.themeMuted)
                    .layoutWeight(1)
                  Text(this.levelTag(entry.level))
                    .fontFamily('Geist').fontSize(10)
                    .fontColor(this.levelColor(entry.level))
                }
                .width('100%')

                Text(entry.message)
                  .fontFamily('Geist').fontSize(13)
                  .fontColor(this.themeText)

                if (entry.detail.length > 0) {
                  Text(entry.detail)
                    .fontFamily('Geist').fontSize(11)
                    .fontColor(this.levelColor(entry.level))
                    .maxLines(4)
                }
              }
              .width('100%')
              .padding(12)
              .borderRadius(10)
              .backgroundColor(this.themeSurface)
              .border({ width: 1, color: this.themeBorder })
            }
          }, (entry: ConnectionLogEntry, index: number) => `${index}-${entry.ts}`)

          ListItem() {
            Text(uiText('最多保留最近 100 条；清空后不可恢复。', this.uiLocale))
              .fontFamily('Geist').fontSize(11)
              .fontColor(this.themeMuted)
              .width('100%')
              .textAlign(TextAlign.Center)
              .padding(8)
          }
        }
        .layoutWeight(1)
        .width('100%')
        .padding({ left: 12, right: 12 })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.themeBg)
  }
}
