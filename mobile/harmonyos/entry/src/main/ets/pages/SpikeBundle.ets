import { webview } from '@kit.ArkWeb';

/**
 * Spike C: validate the two-way ArkWeb bridge the production web-shell relies on.
 * - page → native: window.orcaBridge.post(json) via javaScriptProxy
 * - native → page: controller.runJavaScript("window.__nativePush(<json>)")
 *
 * The mock page mirrors the production `orcaBridge` object name and first-frame
 * behavior of mobile/src/mobile-web-shell/bridge (page.ready) so the mechanics
 * transfer 1:1 to the real bundle shell.
 */

class OrcaBridgeImpl {
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
struct SpikeBundle {
  controller: webview.WebviewController = new webview.WebviewController();
  private bridge: OrcaBridgeImpl = new OrcaBridgeImpl();
  @State log: string = '';
  @State pushCount: number = 0;

  aboutToAppear(): void {
    this.bridge.setSink((msg: string): void => {
      let preview = msg.length > 120 ? `${msg.slice(0, 120)}…(${msg.length} chars)` : msg;
      this.log = `page→native: ${preview}`;
    });
  }

  pushNativeHello(): void {
    let payload = JSON.stringify({ type: 'native.hello', v: 2, ok: true, ts: Date.now() });
    // Embed the JSON string safely inside runJavaScript source.
    let js = `window.__nativePush(${JSON.stringify(payload)})`;
    this.controller.runJavaScript(js)
      .then((reply: string) => {
        this.pushCount++;
        this.log = `native→page: ${reply} (pushes=${this.pushCount})`;
      })
      .catch((e: Error) => {
        this.log = `native→page failed: ${e.message}`;
      });
  }

  build() {
    Column({ space: 8 }) {
      Row({ space: 10 }) {
        Text('Spike C · ArkWeb bridge 双向')
          .fontFamily('Geist').fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor('#e8e8e8')
          .layoutWeight(1)
        Button('推送 native.hello')
          .fontFamily('Geist').fontSize(12)
          .height(32)
          .onClick(() => this.pushNativeHello())
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8 })

      Text(this.log)
        .fontFamily('Geist').fontSize(11)
        .fontColor('#9ad0ff')
        .maxLines(3)
        .width('100%')
        .padding({ left: 12, right: 12 })

      Web({ src: $rawfile('spike/shell-page.html'), controller: this.controller })
        .javaScriptProxy({
          object: this.bridge,
          name: 'orcaBridge',
          methodList: ['post'],
          controller: this.controller
        })
        .onPageEnd(() => {
          this.pushNativeHello();
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
