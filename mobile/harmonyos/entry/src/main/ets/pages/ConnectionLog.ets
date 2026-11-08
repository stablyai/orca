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
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#1c1c1c';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeSecondary') themeSecondary: string = '#b5bec9';
  @StorageProp('themeAccent') themeAccent: string = '#7ddf7d';
  @StorageProp('themeLink') themeLink: string = '#96b8e5';
  @StorageProp('themeWarning') themeWarning: string = '#e0c070';
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
          .fontSize(22)
          .fontColor(this.themeAccent)
          .width(32)
          .height(32)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            router.back();
          })
        Text('连接事件日志')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
        Button('清空')
          .fontSize(12)
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
          Text('暂无连接事件')
            .fontSize(15)
            .fontColor(this.themeSecondary)
          Text('连接与配对事件会自动记录在这里')
            .fontSize(12)
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
                    .fontSize(10)
                    .fontColor(this.themeMuted)
                    .layoutWeight(1)
                  Text(this.levelTag(entry.level))
                    .fontSize(10)
                    .fontColor(this.levelColor(entry.level))
                }
                .width('100%')

                Text(entry.message)
                  .fontSize(13)
                  .fontColor(this.themeText)

                if (entry.detail.length > 0) {
                  Text(entry.detail)
                    .fontSize(11)
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
            Text('最多保留最近 100 条；清空后不可恢复。')
              .fontSize(11)
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
