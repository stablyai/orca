import { common } from '@kit.AbilityKit';
import { fileUri } from '@kit.CoreFileKit';
import { pdfService, pdfViewManager, PdfView } from '@kit.PDFKit';
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
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeStatusRed') themeStatusRed: string = '#ff6568';
  @State unlocked: boolean = false;
  @State unlocking: boolean = false;
  @State password: string = '';
  @State passwordError: string = '';
  private controller: pdfViewManager.PdfController | null = null;
  private visible: boolean = true;

  aboutToAppear(): void {
    this.controller = this.preview?.controller ?? null;
    this.unlocked = this.controller !== null;
  }

  aboutToDisappear(): void { this.visible = false; this.password = ''; }

  private async submitPassword(): Promise<void> {
    let unlock = this.preview?.unlock;
    if (!unlock || this.unlocking || !this.password) { return; }
    let password = this.password;
    this.password = ''; this.passwordError = ''; this.unlocking = true;
    try {
      let controller = await unlock(password);
      if (!this.visible) { return; }
      if (!controller) { this.passwordError = '密码不正确'; return; }
      this.controller = controller;
      this.unlocked = true;
      this.getUIContext().getFocusController().clearFocus();
    } catch (e) {
      if (this.visible) { this.passwordError = '无法解锁 PDF'; }
    } finally {
      if (this.visible) { this.unlocking = false; }
    }
  }

  private async share(): Promise<void> {
    let preview = this.preview;
    if (!preview || !this.unlocked) { return; }
    try {
      let data = new systemShare.SharedData({ utd: 'general.pdf', uri: fileUri.getUriFromPath(preview.path),
        title: preview.title });
      await new systemShare.ShareController(data).show(getContext(this) as common.UIAbilityContext, {});
    } catch (e) {
      this.getUIContext().getPromptAction().showToast({ message: uiText('失败', this.uiLocale) });
    }
  }

  @Builder
  private passwordForm() {
    Column({ space: 12 }) {
      Text(uiText('此 PDF 受密码保护', this.uiLocale)).fontFamily('Geist').fontSize(15)
        .fontWeight(FontWeight.Medium).fontColor(this.themeText).textAlign(TextAlign.Center)
      TextInput({ text: this.password, placeholder: uiText('密码', this.uiLocale) })
        .type(InputType.Password).showPasswordIcon(false).enableAutoFill(false).enablePreviewText(false)
        .fontFamily('Geist').fontSize(14).fontColor(this.themeText).placeholderColor(this.themeMuted)
        .backgroundColor(this.themeSurface).border({ width: 1, color: this.themeBorder, radius: 12 }).height(44)
        .enterKeyType(EnterKeyType.Done).enabled(!this.unlocking).accessibilityText(uiText('密码', this.uiLocale))
        .onChange((value: string): void => { this.password = value; if (value) { this.passwordError = ''; } })
        .onSubmit((): void => { this.submitPassword().catch(() => {}); })
      if (this.passwordError) {
        Text(uiText(this.passwordError, this.uiLocale)).fontFamily('Geist').fontSize(13).fontColor(this.themeStatusRed)
      }
      Button(uiText('解锁', this.uiLocale), { type: ButtonType.Normal })
        .fontFamily('Geist').fontSize(14).fontWeight(FontWeight.Medium).fontColor(this.themeBg)
        .backgroundColor(this.themeText).borderRadius(12).constraintSize({ minHeight: 40 }).width('100%')
        .enabled(!this.unlocking && this.password.length > 0).opacity(!this.unlocking && this.password.length > 0 ? 1 : 0.4)
        .onClick((): void => { this.submitPassword().catch(() => {}); })
    }.width('100%').constraintSize({ maxWidth: 360 }).layoutWeight(1).justifyContent(FlexAlign.Center)
      .padding({ left: 16, right: 16, bottom: 32 })
  }

  build() {
    Column() {
      if (this.preview) {
        Row({ space: 8 }) {
          Button(uiText(this.unlocked ? '完成' : '取消', this.uiLocale), { type: ButtonType.Normal })
            .fontFamily('Geist').fontSize(14).fontColor(this.themeText).backgroundColor(Color.Transparent)
            .constraintSize({ minHeight: 44 }).onClick((): void => { this.onClose(); })
          Text(this.preview.title).fontFamily('Geist').fontSize(14).fontWeight(FontWeight.Medium).fontColor(this.themeText)
            .textAlign(TextAlign.Center).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
          if (this.unlocked) {
            Button(uiText('共享…', this.uiLocale), { type: ButtonType.Normal })
              .fontFamily('Geist').fontSize(14).fontColor(this.themeText).backgroundColor(Color.Transparent)
              .constraintSize({ minHeight: 44 }).onClick((): void => { this.share().catch(() => {}); })
          } else { Blank().width(56) }
        }.width('100%').padding({ left: 8, right: 8 }).backgroundColor(this.themeSurface)
          .border({ width: { bottom: 1 }, color: this.themeBorder })
        if (this.unlocked && this.controller) {
          PdfView({ controller: this.controller, pageFit: pdfService.PageFit.FIT_WIDTH,
            isContinuous: true, showScroll: true }).width('100%').layoutWeight(1)
        } else { this.passwordForm() }
      }
    }.width('100%').height('100%').backgroundColor(this.themeBg)
  }
}
