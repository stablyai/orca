import { common } from '@kit.AbilityKit';
import { fileUri } from '@kit.CoreFileKit';
import { pdfService, PdfView } from '@kit.PDFKit';
import { systemShare } from '@kit.ShareKit';
import { uiText } from '../settings/NativeUi';
import { PdfPreview } from './NativePdfViewer';

@Component
export struct PdfPreviewSurface {
  preview: PdfPreview | null = null;
  onClose: () => void = (): void => {};
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';

  private async share(): Promise<void> {
    let preview = this.preview;
    if (!preview) { return; }
    try {
      let data = new systemShare.SharedData({ utd: 'general.pdf', uri: fileUri.getUriFromPath(preview.path),
        title: preview.title });
      await new systemShare.ShareController(data).show(getContext(this) as common.UIAbilityContext, {});
    } catch (e) {
      this.getUIContext().getPromptAction().showToast({ message: uiText('失败', this.uiLocale) });
    }
  }

  build() {
    Column() {
      if (this.preview) {
        Row({ space: 8 }) {
          Button(uiText('完成', this.uiLocale), { type: ButtonType.Normal })
            .fontFamily('Geist').fontSize(14).fontColor(this.themeText).backgroundColor(Color.Transparent)
            .constraintSize({ minHeight: 44 }).onClick((): void => { this.onClose(); })
          Text(this.preview.title).fontFamily('Geist').fontSize(14).fontWeight(FontWeight.Medium).fontColor(this.themeText)
            .textAlign(TextAlign.Center).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
          Button(uiText('共享…', this.uiLocale), { type: ButtonType.Normal })
            .fontFamily('Geist').fontSize(14).fontColor(this.themeText).backgroundColor(Color.Transparent)
            .constraintSize({ minHeight: 44 }).onClick((): void => { this.share().catch(() => {}); })
        }.width('100%').padding({ left: 8, right: 8 }).backgroundColor(this.themeSurface)
          .border({ width: { bottom: 1 }, color: this.themeBorder })
        PdfView({ controller: this.preview.controller, pageFit: pdfService.PageFit.FIT_WIDTH,
          isContinuous: true, showScroll: true }).width('100%').layoutWeight(1)
      }
    }.width('100%').height('100%').backgroundColor(this.themeBg)
  }
}
