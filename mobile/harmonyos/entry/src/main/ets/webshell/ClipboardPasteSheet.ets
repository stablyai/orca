import { uiText } from '../settings/NativeUi';
import { ClipboardPastePrompt } from './NativeDevice';

@Component
export struct ClipboardPasteSheet {
  prompt: ClipboardPastePrompt | null = null;
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeSheet') themeSheet: string = '#171717';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeStatusRed') themeStatusRed: string = '#ff6568';
  @State refused: boolean = false;

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column().width('100%').height('100%').backgroundColor('rgba(0,0,0,0.55)').accessibilityLevel('no')
        .onClick((): void => { this.prompt?.cancel(); })
      Column({ space: 12 }) {
        Text(uiText('从剪贴板粘贴', this.uiLocale)).fontFamily('Geist').fontSize(15).fontWeight(FontWeight.Medium)
          .fontColor(this.themeText).accessibilityGroup(true)
        if (this.refused) {
          Text(uiText('无法读取剪贴板', this.uiLocale)).fontFamily('Geist').fontSize(13).fontColor(this.themeStatusRed)
        }
        Row({ space: 8 }) {
          Button(uiText('取消', this.uiLocale), { type: ButtonType.Normal })
            .fontFamily('Geist').fontSize(14).fontColor(this.themeText).backgroundColor(Color.Transparent)
            .constraintSize({ minHeight: 44 }).onClick((): void => { this.prompt?.cancel(); })
          PasteButton({ icon: PasteIconStyle.LINES, text: PasteDescription.PASTE, buttonType: ButtonType.Capsule })
            .onClick((_event: ClickEvent, result: PasteButtonOnClickResult): void => {
              this.refused = result !== PasteButtonOnClickResult.SUCCESS;
              if (!this.refused) { this.prompt?.confirm().catch(() => {}); }
            })
        }
      }.width('100%').constraintSize({ maxWidth: 480 }).padding({ top: 16, bottom: 16, left: 16, right: 16 })
        .backgroundColor(this.themeSheet).borderRadius({ topLeft: 24, topRight: 24 })
    }.width('100%').height('100%')
  }
}
