import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { uiText } from '../settings/NativeUi';
import { BundleRemedy } from '../transport/WebBundleFetcher';

@Component
export struct BundleCompatibilityCard {
  @Prop remedy: BundleRemedy = 'desktop';
  @StorageProp('uiLocale') locale: string = 'en';
  @StorageProp('themeBg') bg: string = '#0a0a0a';
  @StorageProp('themeSurface') surface: string = '#171717';
  @StorageProp('themeRaised') raised: string = '#262626';
  @StorageProp('themeBorder') borderTint: string = 'rgba(255,255,255,0.07)';
  @StorageProp('themeText') text: string = '#fafafa';
  @StorageProp('themeSecondary') secondary: string = '#acacac';
  @StorageProp('themeMuted') muted: string = '#898989';
  onBack: () => void = () => {};

  private t(label: string): string { return uiText(label, this.locale); }

  private title(): string {
    if (this.remedy === 'mobile') { return this.t('更新 Orca Mobile'); }
    if (this.remedy === 'workspace') { return this.t('刷新移动端工作区'); }
    return this.t('更新电脑上的 Orca');
  }

  private message(): string {
    if (this.remedy === 'mobile') {
      return this.t('此桌面需要更新版本的 Orca Mobile。请安装新版鸿蒙构建，再重新连接。');
    }
    if (this.remedy === 'workspace') {
      return this.t('此主机的工作区缓存版本低于桌面要求。请重新连接此主机，下载当前版本。');
    }
    return this.t('已配对的桌面应用版本过旧，无法与当前的 Orca Mobile 兼容。请更新电脑上的 Orca，然后重新连接此主机。');
  }

  private openDesktopReleases(): void {
    let context = getContext(this) as common.UIAbilityContext;
    context.startAbility({ action: 'ohos.want.action.viewData', uri: 'https://github.com/stablyai/orca/releases' })
      .catch(() => { promptAction.showToast({ message: this.t('无法打开链接') }); });
  }

  build() {
    Column() {
      Scroll() {
        Column({ space: 8 }) {
          Text(this.title()).fontFamily('Geist').fontSize(20).fontWeight(FontWeight.Bold).fontColor(this.text)
          Text(this.message()).fontFamily('Geist').fontSize(14).lineHeight(20).fontColor(this.secondary).margin({ bottom: 8 })
          if (this.remedy === 'desktop') {
            Button(this.t('打开 GitHub Releases'), { type: ButtonType.Normal })
              .width('100%').constraintSize({ minHeight: 44 }).borderRadius(12).fontFamily('Geist')
              .fontSize(14).fontWeight(600).backgroundColor(this.text).fontColor(this.bg)
              .onClick(() => this.openDesktopReleases())
          }
          Button(this.t('返回主机列表'), { type: ButtonType.Normal })
            .width('100%').constraintSize({ minHeight: 44 }).borderRadius(12).fontFamily('Geist')
            .fontSize(14).fontWeight(600).backgroundColor(this.raised).fontColor(this.text)
            .onClick(() => this.onBack())
          Text(this.t(this.remedy === 'workspace' ? '如果仍显示此消息，请移除此主机并重新配对。'
            : '已经更新？请返回“主机”并刷新连接。如果仍显示此消息，请移除此主机并重新配对。'))
            .fontFamily('Geist').fontSize(12).lineHeight(17).fontColor(this.muted).margin({ top: 4 })
        }.width('100%').alignItems(HorizontalAlign.Start).padding(16).backgroundColor(this.surface)
          .border({ width: 1, color: this.borderTint, radius: 16 })
      }.width('100%').constraintSize({ maxWidth: 480, maxHeight: '100%' }).scrollBar(BarState.Auto)
    }.width('100%').height('100%').padding(16).justifyContent(FlexAlign.Center).backgroundColor(this.bg)
  }
}
