import { uiText } from '../settings/NativeUi';
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
          .fontFamily('Geist').fontSize(22)
          .fontColor(this.themeAccent)
          .width(32)
          .height(32)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            router.back();
          })
        Text(uiText('关于', this.uiLocale))
          .fontFamily('Geist').fontSize(20)
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
              .fontFamily('Geist').fontSize(28)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.themeAccent)
            Text(uiText('Orca Mobile · 鸿蒙版', this.uiLocale))
              .fontFamily('Geist').fontSize(13)
              .fontColor(this.themeSecondary)
            Text(this.versionText())
              .fontFamily('Geist').fontSize(12)
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
            Text(uiText('上游致谢', this.uiLocale))
              .fontFamily('Geist').fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
            Text(uiText('Orca Mobile 是 stablyai/orca 的鸿蒙客户端移植。上游项目以 MIT 协议开源，感谢上游所有贡献者。', this.uiLocale))
              .fontFamily('Geist').fontSize(12)
              .fontColor(this.themeSecondary)
              .lineHeight(18)
              .width('100%')
            Text(uiText('上游仓库：github.com/stablyai/orca（MIT）', this.uiLocale))
              .fontFamily('Geist').fontSize(11)
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
            Text(uiText('开源许可', this.uiLocale))
              .fontFamily('Geist').fontSize(12)
              .fontColor(this.themeMuted)
              .width('100%')
              .padding({ bottom: 4 })
            ForEach(this.licenses, (item: LicenseEntry, index: number) => {
              Column() {
                Row({ space: 10 }) {
                  Column({ space: 3 }) {
                    Text(item.name)
                      .fontFamily('Geist').fontSize(14)
                      .fontColor(this.themeText)
                    Text(item.usage)
                      .fontFamily('Geist').fontSize(11)
                      .fontColor(this.themeMuted)
                  }
                  .alignItems(HorizontalAlign.Start)
                  .layoutWeight(1)

                  Text(item.license)
                    .fontFamily('Geist').fontSize(11)
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
          Button(uiText('打开连接事件日志', this.uiLocale))
            .fontFamily('Geist').fontSize(13)
            .width('100%')
            .height(40)
            .backgroundColor('#2a6a5a')
            .onClick(() => {
              router.pushUrl({ url: 'pages/ConnectionLog' });
            })

          Text(uiText('本应用按 MIT 协议开源', this.uiLocale))
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
