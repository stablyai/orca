import { uiText } from '../settings/NativeUi';
import { router } from '@kit.ArkUI';
import { readPagePreferencesSync, setString, KEY_TERMINAL_LINK_MODE } from '../settings/SettingsStore';

@Entry
@Component
struct BrowserSettings {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeAccent') themeAccent: string = '#3276f2';
  @State value: string = 'orca-browser';
  @State error: string = '';
  @State saving: boolean = false;

  aboutToAppear(): void {
    try { this.value = readPagePreferencesSync(getContext(this)).get(KEY_TERMINAL_LINK_MODE) ?? 'orca-browser'; }
    catch (e) { this.error = '无法读取设置'; }
  }

  private async select(value: string): Promise<void> {
    if (this.saving) { return; }
    this.saving = true; this.error = '';
    try { await setString(getContext(this), KEY_TERMINAL_LINK_MODE, value); this.value = value; }
    catch (e) { this.error = '无法保存设置，请重试'; }
    finally { this.saving = false; }
  }

  build() {
    Column() {
      Row() {
        Button('‹').fontFamily('Geist').fontSize(24).fontColor(this.themeText).backgroundColor(Color.Transparent).width(44).height(44).accessibilityText('返回').onClick((): void => { router.back(); })
        Text(uiText('浏览器', this.uiLocale)).fontFamily('Geist').fontSize(20).fontWeight(FontWeight.Medium).fontColor(this.themeText).layoutWeight(1)
      }.width('100%').padding({ top: 8, right: 16 })
      Column() {
        Row() {
          Text(uiText('电脑上的 Orca 浏览器', this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeText).layoutWeight(1)
          if (this.value === 'orca-browser') { Text('✓').fontColor(this.themeAccent) }
        }.width('100%').height(48).padding({ left: 16, right: 16 }).enabled(!this.saving)
        .onClick((): void => { this.select('orca-browser'); })
        Row() {
          Text(uiText('手机浏览器', this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeText).layoutWeight(1)
          if (this.value === 'phone-browser') { Text('✓').fontColor(this.themeAccent) }
        }.width('100%').height(48).padding({ left: 16, right: 16 }).enabled(!this.saving)
        .onClick((): void => { this.select('phone-browser'); })
      }.width('100%').backgroundColor(this.themeSurface).borderRadius(12).margin({ top: 24 })
      Text(uiText('选择终端内 HTTP(S) 链接的打开位置。', this.uiLocale)).fontFamily('Geist').fontSize(12).fontColor(this.themeMuted).width('100%').padding({ top: 8 })
      if (this.error.length > 0) { Text(this.error).fontFamily('Geist').fontSize(13).fontColor(this.themeText).width('100%').padding({ top: 16 }) }
    }.width('100%').height('100%').padding({ left: 16, right: 16 }).backgroundColor(this.themeBg)
  }
}
