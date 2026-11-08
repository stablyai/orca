import { router } from '@kit.ArkUI';
import { bundleManager } from '@kit.AbilityKit';

/**
 * 关于页：版本信息（bundleManager.getBundleInfoForSelfSync 读取 versionName）、
 * 上游项目致谢（stablyai/orca，MIT）、开源许可列表（tweetnacl / fflate / xterm，
 * 均 MIT），以及跳转连接事件日志的诊断入口。
 */

interface LicenseEntry {
  name: string;
  usage: string;
  license: string;
}

@Entry
@Component
struct About {
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#1c1c1c';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeSecondary') themeSecondary: string = '#b5bec9';
  @StorageProp('themeAccent') themeAccent: string = '#7ddf7d';
  @StorageProp('themeLink') themeLink: string = '#96b8e5';
  @StorageProp('themeWarning') themeWarning: string = '#e0c070';
  @State versionName: string = '';

  private licenses: LicenseEntry[] = [
    { name: 'tweetnacl', usage: '配对密钥协商与报文签名（与上游一致）', license: 'MIT' },
    { name: 'fflate', usage: 'Spike 包解压', license: 'MIT' },
    { name: 'xterm', usage: '上游桌面端终端渲染组件', license: 'MIT' }
  ];

  aboutToAppear(): void {
    try {
      let info: bundleManager.BundleInfo =
        bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
      this.versionName = info.versionName;
    } catch (e) {
      this.versionName = '';
    }
  }

  versionText(): string {
    return this.versionName.length > 0 ? `版本 ${this.versionName}` : '版本信息不可用';
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
        Text('关于')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 10, right: 14, top: 10 })

      Scroll() {
        Column({ space: 14 }) {
          // 应用卡片
          Column({ space: 6 }) {
            Text('Orca')
              .fontSize(28)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.themeAccent)
            Text('Orca Mobile · 鸿蒙版')
              .fontSize(13)
              .fontColor(this.themeSecondary)
            Text(this.versionText())
              .fontSize(12)
              .fontColor(this.themeLink)
          }
          .width('100%')
          .padding(20)
          .borderRadius(12)
          .backgroundColor(this.themeSurface)
          .border({ width: 1, color: this.themeBorder })
          .alignItems(HorizontalAlign.Center)

          // 上游致谢
          Column({ space: 8 }) {
            Text('上游致谢')
              .fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
            Text('Orca Mobile 是 stablyai/orca 的鸿蒙客户端移植。上游项目以 MIT 协议开源，感谢上游所有贡献者。')
              .fontSize(12)
              .fontColor(this.themeSecondary)
              .lineHeight(18)
              .width('100%')
            Text('上游仓库：github.com/stablyai/orca（MIT）')
              .fontSize(11)
              .fontColor(this.themeLink)
              .width('100%')
          }
          .width('100%')
          .padding(14)
          .borderRadius(12)
          .backgroundColor(this.themeSurface)
          .border({ width: 1, color: this.themeBorder })
          .alignItems(HorizontalAlign.Start)

          // 开源许可
          Column({ space: 4 }) {
            Text('开源许可')
              .fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ bottom: 4 })
            ForEach(this.licenses, (item: LicenseEntry, index: number) => {
              Column() {
                Row({ space: 10 }) {
                  Column({ space: 3 }) {
                    Text(item.name)
                      .fontSize(14)
                      .fontColor(this.themeText)
                    Text(item.usage)
                      .fontSize(11)
                      .fontColor(this.themeMuted)
                  }
                  .alignItems(HorizontalAlign.Start)
                  .layoutWeight(1)

                  Text(item.license)
                    .fontSize(11)
                    .fontColor(this.themeAccent)
                }
                .width('100%')
                .padding({ top: 10, bottom: 10, left: 2, right: 2 })

                if (index < this.licenses.length - 1) {
                  Divider()
                    .color(this.themeBorder)
                    .strokeWidth(1)
                }
              }
            }, (item: LicenseEntry, index: number) => `${index}-${item.name}`)
          }
          .width('100%')
          .padding(14)
          .borderRadius(12)
          .backgroundColor(this.themeSurface)
          .border({ width: 1, color: this.themeBorder })

          // 诊断入口
          Button('打开连接事件日志')
            .fontSize(13)
            .width('100%')
            .height(40)
            .backgroundColor('#2a6a5a')
            .onClick(() => {
              router.pushUrl({ url: 'pages/ConnectionLog' });
            })

          Text('本应用按 MIT 协议开源')
            .fontSize(11)
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
