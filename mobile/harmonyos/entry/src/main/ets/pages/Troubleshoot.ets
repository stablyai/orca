import { uiText } from '../settings/NativeUi';
import { router } from '@kit.ArkUI';
import { listHosts, HostMeta } from '../storage/HostStore';

/**
 * 连接诊断（只读）：列出全部已配对主机的 endpoint 与上次连接时间，
 * 并给出常见连接问题的排查提示（桌面需监听 6768 及以上端口、
 * 模拟器访问宿主机用 10.0.2.2、真机用局域网 IP 等）。
 */

interface TipEntry {
  title: string;
  detail: string;
}

@Entry
@Component
struct Troubleshoot {
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
  @State hosts: HostMeta[] = [];
  @State loaded: boolean = false;

  private tips: TipEntry[] = [
    { title: '桌面端未监听', detail: '在桌面 Orca 设置 → Mobile 确认连接服务已开启；桌面需监听 6768 及以上端口（6768 为默认）。' },
    { title: '模拟器连不上', detail: '模拟器访问宿主机不能用 localhost：endpoint 主机名填 10.0.2.2，端口与桌面保持一致。' },
    { title: '真机连不上', detail: '真机与桌面需在同一局域网，endpoint 填桌面机器的局域网 IP，并确认防火墙放行对应端口。' },
    { title: '配对失效', detail: '桌面重置配对后旧凭证即失效：删除该主机后重新扫码配对。' },
    { title: '看失败原因', detail: '点击下方「连接事件日志」查看最近 100 条连接事件。' }
  ];

  onPageShow(): void {
    this.reload();
  }

  reload(): void {
    listHosts(getContext(this)).then((hosts: HostMeta[]) => {
      this.hosts = hosts;
      this.loaded = true;
    }).catch((e: Error) => {
      this.hosts = [];
      this.loaded = true;
    });
  }

  lastConnectedText(host: HostMeta): string {
    if (host.lastConnected <= 0) {
      return '尚未连接过';
    }
    return `上次连接 ${new Date(host.lastConnected).toLocaleString()}`;
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
        Text(uiText('连接诊断', this.uiLocale))
          .fontFamily('Geist').fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 10, right: 14, top: 10 })

      Scroll() {
        Column({ space: 14 }) {
          // 已配对主机（只读）
          Column({ space: 8 }) {
            Text(`已配对主机（${this.hosts.length}）`)
              .fontFamily('Geist').fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })

            if (this.loaded && this.hosts.length === 0) {
              Column({ space: 6 }) {
                Text(uiText('还没有已配对的桌面', this.uiLocale))
                  .fontFamily('Geist').fontSize(14)
                  .fontColor(this.themeSecondary)
                Text(uiText('先回到主页完成扫码配对，再回来查看诊断信息', this.uiLocale))
                  .fontFamily('Geist').fontSize(11)
                  .fontColor(this.themeMuted)
              }
              .width('100%')
              .padding(16)
              .borderRadius(10)
              .backgroundColor(this.themeSurface)
              .border({ width: 1, color: this.themeBorder })
              .alignItems(HorizontalAlign.Center)
            }

            ForEach(this.hosts, (host: HostMeta, index: number) => {
              Column({ space: 4 }) {
                Row({ space: 8 }) {
                  Text(host.name)
                    .fontFamily('Geist').fontSize(15)
                    .fontWeight(FontWeight.Medium)
                    .fontColor(this.themeText)
                    .maxLines(1)
                    .layoutWeight(1)
                  Text(uiText('已配对', this.uiLocale))
                    .fontFamily('Geist').fontSize(10)
                    .fontColor(this.themeAccent)
                }
                .width('100%')

                Text(`endpoint：${host.endpoint}`)
                  .fontFamily('Geist').fontSize(11)
                  .fontColor(this.themeLink)
                  .maxLines(1)
                  .width('100%')

                Text(this.lastConnectedText(host))
                  .fontFamily('Geist').fontSize(10)
                  .fontColor(this.themeMuted)
                  .width('100%')
              }
              .width('100%')
              .padding(12)
              .borderRadius(10)
              .backgroundColor(this.themeSurface)
              .border({ width: 1, color: this.themeBorder })
              .alignItems(HorizontalAlign.Start)
            }, (host: HostMeta, index: number) => `${index}-${host.id}`)
          }
          .width('100%')

          // 排查提示
          Column({ space: 12 }) {
            Text(uiText('常见问题排查', this.uiLocale))
              .fontFamily('Geist').fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ left: 4 })

            ForEach(this.tips, (tip: TipEntry, index: number) => {
              Column({ space: 3 }) {
                Text(tip.title)
                  .fontFamily('Geist').fontSize(14)
                  .fontColor(this.themeWarning)
                Text(tip.detail)
                  .fontFamily('Geist').fontSize(12)
                  .fontColor(this.themeSecondary)
                  .lineHeight(17)
              }
              .width('100%')
              .padding(12)
              .borderRadius(10)
              .backgroundColor(this.themeSurface)
              .border({ width: 1, color: this.themeBorder })
              .alignItems(HorizontalAlign.Start)
            }, (tip: TipEntry, index: number) => `${index}-${tip.title}`)
          }
          .width('100%')

          Button(uiText('连接事件日志', this.uiLocale)).fontColor(this.themeText).backgroundColor(this.themeSurface).height(44).width('100%')
            .onClick((): void => { router.pushUrl({ url: 'pages/ConnectionLog' }); })
          Text(uiText('本页为只读诊断；连接失败的具体错误会记录在连接事件日志中。', this.uiLocale))
            .fontFamily('Geist').fontSize(11)
            .fontColor(this.themeMuted)
            .width('100%')
            .textAlign(TextAlign.Center)
            .padding(8)
        }
        .width('100%')
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ left: 12, right: 12 })
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.themeBg)
  }
}
