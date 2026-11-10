import { bundleManager, common } from '@kit.AbilityKit';
import { lucideColorFilter } from '../settings/LucideColor';
import { uiText } from '../settings/NativeUi';
import { SettingsNavBar } from '../settings/SettingsNavBar';

const LABEL = 'settings.aboutScreen.';

@Entry
@Component
struct About {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeScheme') scheme: string = 'dark';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeRaised') themeRaised: string = '#262626';
  @StorageProp('themeBorder') themeBorder: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeStatusRed') themeStatusRed: string = '#ff6568';
  @State version: string = 'v?.?.?';
  @State linkFailed: boolean = false;

  aboutToAppear(): void {
    try {
      let info = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
      this.version = info.versionCode > 0 ? `v${info.versionName} (${info.versionCode})` : `v${info.versionName}`;
    } catch (e) {}
  }

  private async openLink(uri: string): Promise<void> {
    this.linkFailed = false;
    try {
      let context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      await context.startAbility({ action: 'ohos.want.action.viewData', uri: uri });
    } catch (e) { this.linkFailed = true; }
  }

  @Builder
  private link(title: string, label: string, icon: Resource, uri: string) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Row() {
          Image(icon).supportSvg2(true).width(18).height(18)
            .colorFilter(lucideColorFilter(this.themeSecondary)).accessibilityLevel('no')
        }.width(24).justifyContent(FlexAlign.Center)
        Text(title).fontFamily('Geist').fontSize(15).fontColor(this.themeText)
          .layoutWeight(1).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 8 })
    }.width('100%').constraintSize({ minHeight: 48 }).padding(0).backgroundColor(Color.Transparent)
      .accessibilityText(uiText(LABEL + label, this.uiLocale)).onClick((): void => { this.openLink(uri).catch(() => {}); })
  }

  @Builder
  private separator() {
    Divider().strokeWidth(0.5).color(this.themeBorder).margin({ left: 52 })
  }

  build() {
    Column() {
      SettingsNavBar({ title: uiText(LABEL + 'title', this.uiLocale) })
      Scroll() {
        Column() {
          Column() {
            Image($r('app.media.orca_mark')).supportSvg2(true).width(44).height(28)
              .colorFilter(lucideColorFilter(this.themeText)).accessibilityLevel('no')
            Text('Orca').fontFamily('Geist').fontSize(22).fontWeight(800)
              .fontColor(this.themeText).margin({ top: 8 })
            Text(uiText(LABEL + 'tagline', this.uiLocale)).fontFamily('Geist').fontSize(13)
              .fontColor(this.themeMuted).textAlign(TextAlign.Center).margin({ top: 4 })
          }.width('100%').padding({ top: 24, bottom: 24 })

          Column() {
            this.link('onOrca.dev', 'website', $r('app.media.lucide_globe'), 'https://onOrca.dev')
            this.separator()
            this.link('stablyai/orca', 'sourceCode', $r('app.media.github_mark'), 'https://github.com/stablyai/orca')
            this.separator()
            this.link('@orca_build', 'socialProfile', $r('app.media.x_mark'), 'https://x.com/orca_build')
          }.width('100%').borderRadius(16).backgroundColor(this.scheme === 'light' ? this.themeBg : this.themeRaised).clip(true)

          Text(this.version).fontFamily('Geist').fontSize(12).fontColor(this.themeMuted)
            .textAlign(TextAlign.Center).margin({ top: 16 })
          if (this.linkFailed) {
            Text(uiText(LABEL + 'openLinkFailed', this.uiLocale)).fontFamily('Geist').fontSize(12)
              .fontColor(this.themeStatusRed).textAlign(TextAlign.Center).margin({ top: 8 })
          }
        }.width('100%').padding({ top: 8, left: 16, right: 16, bottom: 24 })
      }.width('100%').layoutWeight(1).align(Alignment.Top).scrollBar(BarState.Off)
    }.width('100%').height('100%').backgroundColor(this.themeBg)
  }
}
