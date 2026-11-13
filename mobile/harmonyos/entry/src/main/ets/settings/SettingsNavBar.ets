import { router } from '@kit.ArkUI';
import { lucideColorFilter } from './LucideColor';
import { uiText } from './NativeUi';

@Component
export struct SettingsNavBar {
  @Prop title: string = '';
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeText') themeText: string = '#fafafa';

  build() {
    Row() {
      Button({ type: ButtonType.Circle }) {
        Image($r('app.media.lucide_chevron_left')).supportSvg2(true).width(22).height(22)
          .colorFilter(lucideColorFilter(this.themeText))
      }.width(44).height(44).backgroundColor(this.themeSurface)
        .accessibilityText(uiText('返回', this.uiLocale)).onClick(() => router.back())
      Text(this.title).fontFamily('Geist').fontSize(17).fontWeight(FontWeight.Medium)
        .fontColor(this.themeText).layoutWeight(1).textAlign(TextAlign.Center).maxLines(1)
      Row().width(44)
    }.width('100%').height(54).padding({ left: 16, right: 16 })
  }
}
