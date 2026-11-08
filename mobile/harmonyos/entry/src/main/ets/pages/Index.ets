import { router } from '@kit.ArkUI';

@Entry
@Component
struct Index {
  build() {
    Column({ space: 16 }) {
      Text('Orca · 鸿蒙版')
        .fontFamily('Geist').fontSize(28)
        .fontWeight(FontWeight.Bold)
      Text('Phase 0 spikes')
        .fontFamily('Geist').fontSize(14)
        .opacity(0.6)

      Button('Spike A · ArkWeb xterm 终端验证')
        .width('80%')
        .onClick(() => {
          router.pushUrl({ url: 'pages/SpikeXterm' });
        })

      Button('Spike B · 配对 + E2EE 连接桌面')
        .width('80%')
        .onClick(() => {
          router.pushUrl({ url: 'pages/SpikePair' });
        })

      Button('Spike C · Web bundle 下载与加载')
        .width('80%')
        .onClick(() => {
          router.pushUrl({ url: 'pages/SpikeBundle' });
        })
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#111111')
  }
}
