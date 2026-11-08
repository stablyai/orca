import { webview } from '@kit.ArkWeb';

/**
 * Spike A: validate that the ArkWeb component can run the same xterm.js + WebGL
 * renderer stack that Orca Mobile uses inside its terminal WebView.
 *
 * The page polls the in-page spike status object and shows it above the terminal.
 * The page-side script also pushes status through the `orcaSpike` JavaScriptProxy,
 * which exercises the same bridge mechanism the production web-shell uses.
 */

class SpikeBridge {
  private sink: ((msg: string) => void) | null = null;

  setSink(sink: (msg: string) => void): void {
    this.sink = sink;
  }

  post(msg: string): string {
    if (this.sink) {
      this.sink(msg);
    }
    return 'ack';
  }
}

@Entry
@Component
struct SpikeXterm {
  controller: webview.WebviewController = new webview.WebviewController();
  private bridge: SpikeBridge = new SpikeBridge();
  @State status: string = 'waiting for page…';
  private pollTimer: number = -1;

  aboutToAppear(): void {
    this.bridge.setSink((msg: string): void => {
      this.status = msg;
    });
  }

  pollStatus(): void {
    this.controller.runJavaScript('JSON.stringify(window.__spikeStatus || {})')
      .then((v: string) => {
        if (v && v !== 'null' && v.length > 2) {
          this.status = v;
        }
      })
      .catch(() => {
      });
  }

  aboutToDisappear(): void {
    if (this.pollTimer >= 0) {
      clearInterval(this.pollTimer);
      this.pollTimer = -1;
    }
  }

  build() {
    Column() {
      Row({ space: 10 }) {
        Text('Spike A · ArkWeb xterm')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor('#e8e8e8')
          .layoutWeight(1)
        Button('状态')
          .fontSize(12)
          .height(30)
          .onClick(() => this.pollStatus())
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 4 })

      Text(this.status)
        .fontSize(10)
        .fontColor('#8a8a8a')
        .maxLines(5)
        .width('100%')
        .padding({ left: 12, right: 12, bottom: 4 })

      Web({ src: $rawfile('spike/xterm.html'), controller: this.controller })
        .javaScriptProxy({
          object: this.bridge,
          name: 'orcaSpike',
          methodList: ['post'],
          controller: this.controller
        })
        .onControllerAttached(() => {
          this.pollTimer = setInterval(() => this.pollStatus(), 2000);
        })
        .width('100%')
        .layoutWeight(1)
        .backgroundColor('#111111')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#111111')
  }
}
