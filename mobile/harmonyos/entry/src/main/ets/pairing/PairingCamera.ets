import { customScan, scanBarcode, scanCore } from '@kit.ScanKit';
import { BusinessError } from '@kit.BasicServicesKit';

let cameraReleased: Promise<void> = Promise.resolve();

@Component
export struct PairingCamera {
  @Prop decoded: boolean = false;
  onCode: (code: string) => void = (_code: string): void => {};
  onFailure: () => void = (): void => {};
  @State guideSize: number = 0;
  private controller: XComponentController = new XComponentController();
  private surfaceId: string = '';
  private previewWidth: number = 0;
  private previewHeight: number = 0;
  private generation: number = 0;
  private started: boolean = false;
  private decodedCode: boolean = false;
  private disposed: boolean = false;

  aboutToDisappear(): void { this.disposed = true; this.releaseCamera(); }

  private releaseCamera(): void {
    this.generation++;
    if (!this.started) { return; }
    this.started = false;
    // Scan Kit owns one stream. Release it before a replacement surface starts.
    cameraReleased = cameraReleased.then(async (): Promise<void> => {
      try { await customScan.stop(); } catch (e) {}
      try { await customScan.release(); } catch (e) {}
    });
  }

  private updatePreview(): void {
    this.releaseCamera();
    if (!this.surfaceId || this.previewWidth <= 0 || this.previewHeight <= 0 || this.decodedCode) { return; }
    let generation = this.generation;
    let surface: customScan.ViewControl = { surfaceId: this.surfaceId, width: this.previewWidth, height: this.previewHeight };
    cameraReleased.then((): void => {
      if (this.disposed || generation !== this.generation) { return; }
      try {
        customScan.init({ scanTypes: [scanCore.ScanType.QR_CODE], enableAlbum: false });
        this.started = true;
        customScan.start(surface, (err: BusinessError, results: scanBarcode.ScanResult[]): void => {
          if (this.disposed || generation !== this.generation || this.decodedCode) { return; }
          if (err) { this.releaseCamera(); this.onFailure(); return; }
          let code = results?.[0]?.originalValue;
          if (code) { this.decodedCode = true; this.onCode(code); }
        });
      } catch (e) { this.releaseCamera(); this.onFailure(); }
    });
  }

  @Builder
  private corner(left: boolean, top: boolean) {
    Blank()
      .width(28).height(28)
      .borderWidth({ left: left ? 2.5 : 0, right: left ? 0 : 2.5, top: top ? 2.5 : 0, bottom: top ? 0 : 2.5 })
      .borderColor('rgba(255, 255, 255, 0.7)')
      .borderRadius({ topLeft: left && top ? 4 : 0, topRight: !left && top ? 4 : 0,
        bottomLeft: left && !top ? 4 : 0, bottomRight: !left && !top ? 4 : 0 })
  }

  build() {
    Stack() {
      XComponent({ id: 'pairing-preview', type: XComponentType.SURFACE, controller: this.controller })
        .width('100%').height('100%')
        .onLoad((): void => { this.surfaceId = this.controller.getXComponentSurfaceId(); this.updatePreview(); })
        .onDestroy((): void => { this.surfaceId = ''; this.releaseCamera(); })
        .onAreaChange((_old: Area, area: Area): void => {
          let width = Math.round(Number(area.width)); let height = Math.round(Number(area.height));
          if (width === this.previewWidth && height === this.previewHeight) { return; }
          this.previewWidth = width; this.previewHeight = height;
          this.guideSize = Math.min(360, Math.round(Math.min(width, height) * 0.62));
          this.updatePreview();
        })
      Column() {
        Row() { this.corner(true, true); Blank(); this.corner(false, true); }
          .width('100%').height(28)
        Blank()
        Row() { this.corner(true, false); Blank(); this.corner(false, false); }
          .width('100%').height(28)
      }
      .width(this.guideSize).height(this.guideSize)
      .scale({ x: this.decoded ? 0.94 : 1, y: this.decoded ? 0.94 : 1 })
      .animation({ duration: 160 })
      .hitTestBehavior(HitTestMode.None)
    }.width('100%').height('100%').borderRadius(16).clip(true).backgroundColor(Color.Black)
  }
}
